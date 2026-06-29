import os
import sys
import json
import time
import subprocess
import threading
from pathlib import Path

from flask import Flask, render_template, request, jsonify, Response

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = Flask(__name__)

# Video extensions we recognise (lower-case, with leading dot)
VIDEO_EXTENSIONS = {
    '.mp4', '.mov', '.mkv', '.avi', '.mxf', '.webm',
    '.wmv', '.flv', '.m4v', '.ts', '.mts', '.m2ts',
    '.3gp', '.ogv',
}

# ---------------------------------------------------------------------------
# Thread-safe global compression state
# ---------------------------------------------------------------------------

state_lock = threading.Lock()

compression_state = {
    'running': False,
    'cancelled': False,
    'completed': False,
    'current_file': '',
    'current_index': 0,
    'total_files': 0,
    'file_progress': 0,
    'file_fps': 0,
    'file_speed': '',
    'encoder': '',
    'results': [],
    'errors': [],
}

# Reference to the currently-running FFmpeg process so we can kill it on cancel
current_ffmpeg_process = None
ffmpeg_process_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_state_snapshot():
    """Return a deep-ish copy of compression_state (safe to serialise)."""
    with state_lock:
        return {
            'running': compression_state['running'],
            'cancelled': compression_state['cancelled'],
            'completed': compression_state['completed'],
            'current_file': compression_state['current_file'],
            'current_index': compression_state['current_index'],
            'total_files': compression_state['total_files'],
            'file_progress': compression_state['file_progress'],
            'file_fps': compression_state['file_fps'],
            'file_speed': compression_state['file_speed'],
            'encoder': compression_state['encoder'],
            'results': list(compression_state['results']),
            'errors': list(compression_state['errors']),
        }


def _reset_state():
    """Reset global state to defaults before a new compression run."""
    with state_lock:
        compression_state['running'] = False
        compression_state['cancelled'] = False
        compression_state['completed'] = False
        compression_state['current_file'] = ''
        compression_state['current_index'] = 0
        compression_state['total_files'] = 0
        compression_state['file_progress'] = 0
        compression_state['file_fps'] = 0
        compression_state['file_speed'] = ''
        compression_state['encoder'] = ''
        compression_state['results'] = []
        compression_state['errors'] = []


def _run_subprocess(cmd, capture_output=True, text=True, timeout=None):
    """Run a subprocess with CREATE_NO_WINDOW on Windows.

    Returns a CompletedProcess on success, or None on failure.
    """
    creation_flags = 0
    if sys.platform == 'win32':
        creation_flags = subprocess.CREATE_NO_WINDOW

    try:
        result = subprocess.run(
            cmd,
            capture_output=capture_output,
            text=text,
            timeout=timeout,
            creationflags=creation_flags,
        )
        return result
    except FileNotFoundError:
        return None
    except subprocess.TimeoutExpired:
        return None
    except Exception:
        return None


def _get_resolution_label(width, height):
    """Map pixel dimensions to a friendly resolution label."""
    if width <= 0 or height <= 0:
        return 'Unknown'

    # Use the larger dimension to handle portrait videos
    long_side = max(width, height)
    short_side = min(width, height)

    if long_side >= 3840 or short_side >= 2160:
        return '4K'
    if long_side >= 2560 or short_side >= 1440:
        return '2K'
    if long_side >= 1920 or short_side >= 1080:
        return '1080p'
    if long_side >= 1280 or short_side >= 720:
        return '720p'
    if long_side >= 854 or short_side >= 480:
        return '480p'
    return str(short_side) + 'p'


# ---------------------------------------------------------------------------
# Hardware encoder detection (cached)
# ---------------------------------------------------------------------------

_cached_hw_encoders = None


def _detect_hw_encoders():
    """Detect available GPU hardware encoders by querying FFmpeg.

    Checks for NVENC, AMF and QSV encoders in priority order and returns
    a dict describing the best available pair (h265 + h264).  The result
    is cached in a module-level variable so detection only runs once.

    Returns:
        dict: e.g. {'h265': 'hevc_nvenc', 'h264': 'h264_nvenc',
                     'type': 'NVIDIA NVENC'}
              or empty dict if no hardware encoder is found.
    """
    global _cached_hw_encoders
    if _cached_hw_encoders is not None:
        return _cached_hw_encoders

    # Encoder families in priority order
    families = [
        {
            'type': 'NVIDIA NVENC',
            'h265': 'hevc_nvenc',
            'h264': 'h264_nvenc',
        },
        {
            'type': 'AMD AMF',
            'h265': 'hevc_amf',
            'h264': 'h264_amf',
        },
        {
            'type': 'Intel QSV',
            'h265': 'hevc_qsv',
            'h264': 'h264_qsv',
        },
    ]

    result = _run_subprocess(['ffmpeg', '-hide_banner', '-encoders'], timeout=15)
    if result is None or result.returncode != 0:
        _cached_hw_encoders = {}
        return _cached_hw_encoders

    output = result.stdout or ''

    # Build a set of encoder names present in the output
    available = set()
    for line in output.splitlines():
        # Each encoder line looks like: " V....D hevc_nvenc  NVIDIA ..."
        parts = line.split()
        if len(parts) >= 2:
            available.add(parts[1])

    # Pick the first family where at least one encoder is available
    for family in families:
        h265_ok = family['h265'] in available
        h264_ok = family['h264'] in available
        if h265_ok or h264_ok:
            detected = {'type': family['type']}
            if h265_ok:
                detected['h265'] = family['h265']
            if h264_ok:
                detected['h264'] = family['h264']
            _cached_hw_encoders = detected
            return _cached_hw_encoders

    _cached_hw_encoders = {}
    return _cached_hw_encoders


def _probe_file(filepath):
    """Use ffprobe to gather video file metadata.

    Returns a dict with file info, or None if probing fails.
    """
    cmd = [
        'ffprobe',
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filepath,
    ]

    result = _run_subprocess(cmd, timeout=30)
    if result is None or result.returncode != 0:
        return None

    try:
        data = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        return None

    # Find the first video stream
    video_stream = None
    has_audio = False
    for stream in data.get('streams', []):
        codec_type = stream.get('codec_type', '')
        if codec_type == 'video' and video_stream is None:
            video_stream = stream
        if codec_type == 'audio':
            has_audio = True

    if video_stream is None:
        return None

    fmt = data.get('format', {})

    # Extract dimensions
    width = int(video_stream.get('width', 0))
    height = int(video_stream.get('height', 0))

    # Duration: prefer format-level, fall back to stream-level
    duration = 0.0
    try:
        duration = float(fmt.get('duration', 0))
    except (ValueError, TypeError):
        pass
    if duration <= 0:
        try:
            duration = float(video_stream.get('duration', 0))
        except (ValueError, TypeError):
            duration = 0.0

    # Bitrate: prefer format-level
    bitrate = 0
    try:
        bitrate = int(fmt.get('bit_rate', 0))
    except (ValueError, TypeError):
        pass
    if bitrate <= 0:
        try:
            bitrate = int(video_stream.get('bit_rate', 0))
        except (ValueError, TypeError):
            bitrate = 0

    # File size from os.path (more reliable than format metadata)
    try:
        file_size = os.path.getsize(filepath)
    except OSError:
        file_size = int(fmt.get('size', 0))

    codec_name = video_stream.get('codec_name', 'unknown')

    return {
        'name': os.path.basename(filepath),
        'path': filepath,
        'size': file_size,
        'duration': round(duration, 2),
        'width': width,
        'height': height,
        'resolution': _get_resolution_label(width, height),
        'codec_name': codec_name,
        'bitrate': bitrate,
        'has_audio': has_audio,
    }


def _compute_output_path(input_path, source_folder, output_folder):
    """Compute the output file path, preserving subdirectory structure.

    If source and output folders are effectively the same we append
    '_compressed' before the extension to avoid overwriting the original.
    """
    # Normalise paths for reliable comparison
    input_norm = os.path.normpath(os.path.abspath(input_path))
    source_norm = os.path.normpath(os.path.abspath(source_folder))
    output_norm = os.path.normpath(os.path.abspath(output_folder))

    # Relative path from source folder
    try:
        rel = os.path.relpath(input_norm, source_norm)
    except ValueError:
        # Can happen on Windows across drive letters
        rel = os.path.basename(input_norm)

    out_path = os.path.join(output_norm, rel)

    # If output would overwrite input, add _compressed suffix
    if os.path.normpath(os.path.abspath(out_path)) == input_norm:
        base, ext = os.path.splitext(out_path)
        out_path = base + '_compressed' + ext

    return out_path


def _compress_files(files, settings):
    """Background worker that compresses a list of video files.

    Updates compression_state in-place (thread-safe via state_lock).
    """
    global current_ffmpeg_process

    crf = settings.get('crf', 23)
    codec = settings.get('codec', 'h265')
    preset = settings.get('preset', 'medium')
    output_folder = settings.get('output_folder', '')
    source_folder = settings.get('source_folder', '')
    use_hw = settings.get('use_hw', True)
    replace_original = settings.get('replace_original', False)
    gpu_limit = settings.get('gpu_limit', 4)  # 1=25%, 2=50%, 3=75%, 4=100%

    # Map GPU limit to NVENC preset (p1=lightest … p4=heaviest)
    # and Windows process priority class
    GPU_NVENC_PRESET_MAP = {1: 'p1', 2: 'p2', 3: 'p3', 4: 'p4'}
    GPU_PRIORITY_MAP = {
        1: 0x00000040,  # IDLE_PRIORITY_CLASS
        2: 0x00004000,  # BELOW_NORMAL_PRIORITY_CLASS
        3: 0x00000020,  # NORMAL_PRIORITY_CLASS
        4: 0x00000020,  # NORMAL_PRIORITY_CLASS
    }
    nvenc_preset = GPU_NVENC_PRESET_MAP.get(gpu_limit, 'p4')
    process_priority = GPU_PRIORITY_MAP.get(gpu_limit, 0x00000020)

    # --- Determine encoder (hardware or software fallback) ---
    hw_encoders = _detect_hw_encoders() if use_hw else {}
    hw_codec_name = hw_encoders.get(codec)  # e.g. 'hevc_nvenc' or None
    hw_type = hw_encoders.get('type', '')   # e.g. 'NVIDIA NVENC'

    if hw_codec_name:
        encoder_label = f'{hw_codec_name} ({hw_type})'
    else:
        # Software fallback
        hw_codec_name = None
        lib_codec = 'libx265' if codec == 'h265' else 'libx264'
        encoder_label = f'{lib_codec} (software)'

    with state_lock:
        compression_state['running'] = True
        compression_state['total_files'] = len(files)
        compression_state['encoder'] = encoder_label

    for idx, filepath in enumerate(files):
        # --- Check for cancellation ---
        with state_lock:
            if compression_state['cancelled']:
                break
            compression_state['current_index'] = idx
            compression_state['current_file'] = os.path.basename(filepath)
            compression_state['file_progress'] = 0
            compression_state['file_fps'] = 0
            compression_state['file_speed'] = ''

        # --- Probe duration for progress calculation ---
        probe = _probe_file(filepath)
        duration_us = 0
        if probe and probe['duration'] > 0:
            duration_us = probe['duration'] * 1_000_000

        # --- Compute output path ---
        out_path = _compute_output_path(filepath, source_folder, output_folder)

        # Ensure output directory exists
        try:
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
        except OSError as exc:
            with state_lock:
                compression_state['errors'].append({
                    'file': os.path.basename(filepath),
                    'error': f'Cannot create output directory: {exc}',
                })
            continue

        # --- Build FFmpeg command ---
        # Get original file size for later comparison
        try:
            original_size_pre = os.path.getsize(filepath)
        except OSError:
            original_size_pre = 0

        # Estimate a sensible maxrate from original file bitrate
        # to prevent NVENC from producing files larger than the original
        original_bitrate_kbps = 0
        if probe and probe.get('duration') and probe['duration'] > 0 and original_size_pre > 0:
            original_bitrate_kbps = int((original_size_pre * 8) / probe['duration'] / 1000)

        if hw_codec_name:
            # Hardware-accelerated encoding
            cmd = [
                'ffmpeg', '-y',
                '-i', filepath,
                '-c:v', hw_codec_name,
                '-pix_fmt', 'yuv420p',
            ]

            if 'nvenc' in hw_codec_name:
                # NVIDIA NVENC: -cq for constant quality, -rc vbr,
                # -preset controlled by gpu_limit (p1=lightest … p4=heaviest)
                cmd.extend([
                    '-rc', 'vbr',
                    '-cq', str(crf),
                    '-preset', nvenc_preset,
                ])
                # Cap bitrate to prevent output exceeding original size.
                # Allow up to 90% of original bitrate as maximum.
                if original_bitrate_kbps > 0:
                    max_br = int(original_bitrate_kbps * 0.9)
                    cmd.extend([
                        '-maxrate', f'{max_br}k',
                        '-bufsize', f'{max_br * 2}k',
                    ])
            elif 'qsv' in hw_codec_name:
                # Intel QSV: -global_quality instead of -crf
                cmd.extend([
                    '-global_quality', str(crf),
                    '-preset', 'medium',
                ])
            elif 'amf' in hw_codec_name:
                # AMD AMF: -quality balanced, -rc cqp with per-frame QP
                cmd.extend([
                    '-quality', 'balanced',
                    '-rc', 'cqp',
                    '-qp_i', str(crf),
                    '-qp_p', str(crf),
                ])

            if probe and probe.get('has_audio'):
                cmd.extend(['-c:a', 'copy'])

            # Apple-compatible tag for HEVC (all HW HEVC encoders)
            if codec == 'h265':
                cmd.extend(['-tag:v', 'hvc1'])
        else:
            # Software encoding fallback
            cmd = [
                'ffmpeg', '-y',
                '-i', filepath,
                '-c:v', lib_codec,
                '-pix_fmt', 'yuv420p',
                '-crf', str(crf),
                '-preset', preset,
            ]
            
            if probe and probe.get('has_audio'):
                cmd.extend(['-c:a', 'copy'])

            # Apple-compatible tag for HEVC
            if codec == 'h265':
                cmd.extend(['-tag:v', 'hvc1'])

        # Machine-readable progress on stdout
        cmd.extend(['-progress', 'pipe:1', '-nostats'])
        cmd.append(out_path)

        # --- Run FFmpeg ---
        creation_flags = 0
        if sys.platform == 'win32':
            # Combine CREATE_NO_WINDOW with process priority from GPU limit
            creation_flags = subprocess.CREATE_NO_WINDOW | process_priority

        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                creationflags=creation_flags,
            )
        except Exception as exc:
            with state_lock:
                compression_state['errors'].append({
                    'file': os.path.basename(filepath),
                    'error': f'Failed to launch FFmpeg: {exc}',
                })
            continue

        # Store process reference for potential cancellation
        with ffmpeg_process_lock:
            current_ffmpeg_process = proc

        # --- Drain stderr in a background thread to prevent deadlock ---
        # Without this, the stderr pipe buffer fills up and FFmpeg blocks,
        # which also blocks stdout, causing a total deadlock.
        stderr_chunks = []

        def _drain_stderr():
            try:
                for err_line in proc.stderr:
                    stderr_chunks.append(err_line)
            except Exception:
                pass

        stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
        stderr_thread.start()

        # --- Parse progress output line by line ---
        try:
            for line in proc.stdout:
                # Check cancellation flag
                with state_lock:
                    if compression_state['cancelled']:
                        proc.kill()
                        break

                line = line.strip()
                if '=' not in line:
                    continue

                key, _, value = line.partition('=')
                key = key.strip()
                value = value.strip()

                if key == 'out_time_us' and duration_us > 0:
                    try:
                        current_us = int(value)
                        progress = min((current_us / duration_us) * 100, 100)
                        with state_lock:
                            compression_state['file_progress'] = round(progress, 1)
                    except (ValueError, ZeroDivisionError):
                        pass

                elif key == 'fps':
                    try:
                        with state_lock:
                            compression_state['file_fps'] = float(value)
                    except ValueError:
                        pass

                elif key == 'speed':
                    with state_lock:
                        compression_state['file_speed'] = value

        except Exception:
            # stdout read interrupted; process may have been killed
            pass

        # Wait for process and stderr thread to finish
        try:
            proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

        stderr_thread.join(timeout=5)

        with ffmpeg_process_lock:
            current_ffmpeg_process = None

        # --- Handle result ---
        with state_lock:
            was_cancelled = compression_state['cancelled']

        if was_cancelled:
            # Clean up partial output
            try:
                if os.path.exists(out_path):
                    os.remove(out_path)
            except OSError:
                pass
            break

        if proc.returncode != 0:
            # Compression failed - use collected stderr for diagnostics
            stderr_text = ''.join(stderr_chunks).strip()

            # Clean up partial output
            try:
                if os.path.exists(out_path):
                    os.remove(out_path)
            except OSError:
                pass

            error_msg = stderr_text if stderr_text else f'FFmpeg exited with code {proc.returncode}'
            # Limit error message length to something reasonable
            if len(error_msg) > 500:
                error_msg = error_msg[-500:]

            with state_lock:
                compression_state['errors'].append({
                    'file': os.path.basename(filepath),
                    'error': error_msg,
                })
            continue

        # Success - record result
        original_size = 0
        compressed_size = 0
        try:
            original_size = os.path.getsize(filepath)
        except OSError:
            pass
        try:
            compressed_size = os.path.getsize(out_path)
        except OSError:
            pass

        # --- Smart check: skip if compressed file is LARGER than original ---
        if compressed_size >= original_size and original_size > 0:
            # Compressed file is not smaller — discard it and keep the original
            try:
                os.remove(out_path)
            except OSError:
                pass

            with state_lock:
                compression_state['file_progress'] = 100
                compression_state['results'].append({
                    'file': os.path.basename(filepath),
                    'original_size': original_size,
                    'compressed_size': original_size,  # no change
                })
                compression_state['errors'].append({
                    'file': os.path.basename(filepath),
                    'error': f'Bỏ qua — file nén ({compressed_size / 1048576:.1f} MB) lớn hơn hoặc bằng file gốc ({original_size / 1048576:.1f} MB). Giữ nguyên file gốc.',
                })
            continue

        # --- Replace original if requested ---
        if replace_original and os.path.exists(out_path) and compressed_size > 0:
            try:
                # Determine the replacement path: same dir + same name as original
                original_dir = os.path.dirname(filepath)
                original_name = os.path.basename(filepath)
                replace_path = os.path.join(original_dir, original_name)

                # If compressed file has a different extension, keep original extension
                orig_ext = os.path.splitext(original_name)[1]
                comp_ext = os.path.splitext(out_path)[1]
                if orig_ext.lower() != comp_ext.lower():
                    # Use original name stem + compressed extension
                    stem = os.path.splitext(original_name)[0]
                    replace_path = os.path.join(original_dir, stem + comp_ext)

                # Delete original file
                os.remove(filepath)

                # Move compressed file to original location
                import shutil
                shutil.move(out_path, replace_path)

            except Exception as exc:
                with state_lock:
                    compression_state['errors'].append({
                        'file': os.path.basename(filepath),
                        'error': f'Nén thành công nhưng không thể ghi đè file gốc: {exc}',
                    })

        with state_lock:
            compression_state['file_progress'] = 100
            compression_state['results'].append({
                'file': os.path.basename(filepath),
                'original_size': original_size,
                'compressed_size': compressed_size,
            })

    # --- All done ---
    with state_lock:
        compression_state['running'] = False
        if not compression_state['cancelled']:
            compression_state['completed'] = True


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    """Serve the main page."""
    return render_template('index.html')


@app.route('/api/check-ffmpeg', methods=['GET'])
def check_ffmpeg():
    """Check whether ffmpeg and ffprobe are available on this system."""
    available = True
    version = ''

    # Check ffmpeg
    result = _run_subprocess(['ffmpeg', '-version'], timeout=10)
    if result is None or result.returncode != 0:
        available = False
    else:
        # First line is typically "ffmpeg version X.Y.Z ..."
        first_line = (result.stdout or '').split('\n')[0].strip()
        version = first_line

    # Also check ffprobe
    result2 = _run_subprocess(['ffprobe', '-version'], timeout=10)
    if result2 is None or result2.returncode != 0:
        available = False

    return jsonify({'available': available, 'version': version})


@app.route('/api/hw-encoders', methods=['GET'])
def hw_encoders():
    """Return detected GPU hardware encoders."""
    encoders = _detect_hw_encoders()
    if encoders:
        return jsonify({
            'available': True,
            'type': encoders.get('type', ''),
            'encoders': {
                k: v for k, v in encoders.items() if k != 'type'
            },
        })
    return jsonify({'available': False, 'type': '', 'encoders': {}})


@app.route('/api/browse-folder', methods=['POST'])
def browse_folder():
    """Open a native folder-picker dialog using tkinter."""
    data = request.get_json(silent=True) or {}
    title = data.get('title', 'Select Folder')

    selected = ''
    try:
        import subprocess as _sp
        import sys as _sys
        
        # Run tkinter in a SEPARATE process.
        # IMPORTANT: Do NOT use CREATE_NO_WINDOW here — tkinter needs
        # a visible window context to display the folder-picker dialog.
        script = (
            "import tkinter as tk\n"
            "from tkinter import filedialog\n"
            "root = tk.Tk()\n"
            "root.withdraw()\n"
            "root.wm_attributes('-topmost', 1)\n"
            "root.focus_force()\n"
            "root.update()\n"
            f"result = filedialog.askdirectory(title={repr(title)}, parent=root)\n"
            "print(result if result else '')\n"
            "root.destroy()\n"
        )
        result = _sp.run(
            [_sys.executable, '-c', script],
            capture_output=True,
            text=True,
            timeout=120,  # 2 min timeout in case user takes long
        )
        selected = result.stdout.strip()
    except Exception as exc:
        print(f"Browse error: {exc}")
        selected = ''

    return jsonify({'path': selected})


@app.route('/api/scan', methods=['POST'])
def scan_folder():
    """Scan a folder for video files and return metadata for each."""
    data = request.get_json(silent=True) or {}
    folder = data.get('folder', '')
    include_subfolders = data.get('include_subfolders', True)

    if not folder or not os.path.isdir(folder):
        return jsonify({'files': [], 'error': 'Invalid or missing folder path'}), 400

    # Collect video file paths
    video_paths = []
    try:
        if include_subfolders:
            for root_dir, _dirs, filenames in os.walk(folder):
                for fname in filenames:
                    if os.path.splitext(fname)[1].lower() in VIDEO_EXTENSIONS:
                        full_path = os.path.join(root_dir, fname)
                        video_paths.append(full_path)
        else:
            for entry in os.scandir(folder):
                if entry.is_file():
                    if os.path.splitext(entry.name)[1].lower() in VIDEO_EXTENSIONS:
                        video_paths.append(entry.path)
    except PermissionError:
        return jsonify({'files': [], 'error': 'Permission denied when scanning folder'}), 403
    except OSError as exc:
        return jsonify({'files': [], 'error': str(exc)}), 500

    # Sort alphabetically by full path
    video_paths.sort(key=lambda p: p.lower())

    # Probe each file
    files_info = []
    for vpath in video_paths:
        info = _probe_file(vpath)
        if info is not None:
            files_info.append(info)

    return jsonify({'files': files_info})


@app.route('/api/compress', methods=['POST'])
def start_compression():
    """Start compressing the provided list of video files in a background thread."""
    # Prevent starting a new job while one is already running
    with state_lock:
        if compression_state['running']:
            return jsonify({'status': 'error', 'message': 'Compression already in progress'}), 409

    data = request.get_json(silent=True) or {}
    files = data.get('files', [])
    settings = data.get('settings', {})

    if not files:
        return jsonify({'status': 'error', 'message': 'No files provided'}), 400

    # Validate that all file paths exist
    valid_files = [f for f in files if os.path.isfile(f)]
    if not valid_files:
        return jsonify({'status': 'error', 'message': 'None of the provided files exist'}), 400

    # Ensure output folder is set
    output_folder = settings.get('output_folder', '')
    if not output_folder:
        return jsonify({'status': 'error', 'message': 'No output folder specified'}), 400

    # Create output folder if it does not exist
    try:
        os.makedirs(output_folder, exist_ok=True)
    except OSError as exc:
        return jsonify({'status': 'error', 'message': f'Cannot create output folder: {exc}'}), 500

    # Reset state and start the background worker
    _reset_state()

    worker = threading.Thread(
        target=_compress_files,
        args=(valid_files, settings),
        daemon=True,
    )
    worker.start()

    return jsonify({'status': 'started'})


@app.route('/api/progress', methods=['GET'])
def progress_stream():
    """Server-Sent Events stream that pushes compression state every 500ms."""

    def generate():
        while True:
            snapshot = _get_state_snapshot()
            # Format as SSE
            yield f"data: {json.dumps(snapshot)}\n\n"

            # Stop streaming once the job is done
            if snapshot['completed'] or snapshot['cancelled']:
                break
            if not snapshot['running'] and snapshot['total_files'] == 0:
                # No job has started yet; still send one update then stop
                break

            time.sleep(0.5)

    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',  # Disable buffering in reverse proxies
        },
    )


@app.route('/api/cancel', methods=['POST'])
def cancel_compression():
    """Cancel the currently running compression job."""
    with state_lock:
        compression_state['cancelled'] = True

    # Also kill the FFmpeg process immediately if it is running
    with ffmpeg_process_lock:
        if current_ffmpeg_process is not None:
            try:
                current_ffmpeg_process.kill()
            except Exception:
                pass

    return jsonify({'status': 'cancelled'})


@app.route('/api/open-folder', methods=['POST'])
def open_folder():
    """Open a folder in Windows Explorer (or the platform file manager)."""
    data = request.get_json(silent=True) or {}
    folder_path = data.get('path', '')

    if not folder_path or not os.path.isdir(folder_path):
        return jsonify({'status': 'error', 'message': 'Invalid folder path'}), 400

    try:
        os.startfile(os.path.normpath(folder_path))
    except Exception as exc:
        return jsonify({'status': 'error', 'message': str(exc)}), 500

    return jsonify({'status': 'ok'})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    print('\nFootageLite is running!')
    print('Open http://localhost:5000 in your browser\n')
    app.run(debug=False, port=5000, threaded=True)
