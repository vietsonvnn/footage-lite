/**
 * FootageLite — Video Footage Compressor
 * Frontend Application (Vanilla JS)
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const PRESET_NAMES = [
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast',
  'medium', 'slow', 'slower', 'veryslow'
];

// ─── State ───────────────────────────────────────────────────────────────────

let allFiles = [];
let selectedFiles = new Set();
let currentSettings = {
  crf: 23,
  codec: 'h265',
  preset: 'medium',
  outputFolder: '',
  sourceFolder: '',
  sizeThreshold: 100,
  keepStructure: true,
  useHw: true,
  replaceOriginal: false
};
let hwEncoderInfo = null;
let eventSource = null;
let isCompressing = false;
let completedIndices = new Set();

// ─── DOM References ──────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Helper Functions ────────────────────────────────────────────────────────

function formatFileSize(bytes) {
  if (bytes == null || bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const idx = Math.min(i, sizes.length - 1);
  return (bytes / Math.pow(1024, idx)).toFixed(2) + ' ' + sizes[idx];
}

function formatDuration(seconds) {
  if (seconds == null || isNaN(seconds)) return '0:00';
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getBasename(filepath) {
  if (!filepath) return '';
  return filepath.split(/[\\/]/).pop();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showLoading(message) {
  const overlay = $('#loading-overlay');
  const text = $('#loading-text');
  if (text) text.textContent = message || 'Đang tải...';
  if (overlay) overlay.style.display = 'flex';
}

function hideLoading() {
  const overlay = $('#loading-overlay');
  if (overlay) overlay.style.display = 'none';
}

function updateCompressButtonState() {
  const btn = $('#btn-compress');
  if (!btn) return;
  btn.disabled = selectedFiles.size === 0 || isCompressing;
}

function updateSelectionStats() {
  let count = 0;
  let totalBytes = 0;
  for (const file of allFiles) {
    if (selectedFiles.has(file.path)) {
      count++;
      totalBytes += file.size || 0;
    }
  }
  const selCount = $('#selected-count');
  const selSize = $('#selected-size');
  if (selCount) selCount.textContent = count;
  if (selSize) selSize.textContent = formatFileSize(totalBytes);
  updateCompressButtonState();
}

// ─── API Helpers ─────────────────────────────────────────────────────────────

async function apiPost(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`API Error ${response.status}: ${errorText}`);
  }
  return response.json();
}

async function apiGet(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`API Error ${response.status}: ${errorText}`);
  }
  return response.json();
}

// ─── FFmpeg Check ────────────────────────────────────────────────────────────

async function checkFFmpeg() {
  const statusEl = $('#ffmpeg-status');
  const warningEl = $('#ffmpeg-warning');

  try {
    const data = await apiGet('/api/check-ffmpeg');
    if (data.available) {
      if (statusEl) {
        statusEl.innerHTML = '<span class="status-badge status-ready">FFmpeg Ready ✅</span>';
      }
      if (warningEl) warningEl.style.display = 'none';
      return true;
    } else {
      showFFmpegWarning(statusEl, warningEl);
      return false;
    }
  } catch (err) {
    console.error('FFmpeg check failed:', err);
    showFFmpegWarning(statusEl, warningEl);
    return false;
  }
}

async function detectHardwareEncoders() {
  const statusEl = $('#hw-accel-status');
  const toggleEl = $('#hw-accel-toggle');
  
  try {
    const data = await apiGet('/api/hw-encoders');
    hwEncoderInfo = data;
    
    if (data.available && statusEl) {
      statusEl.innerHTML = `<span class="hw-badge hw-available">⚡ ${escapeHtml(data.type || 'GPU')} detected</span>`;
      if (toggleEl) toggleEl.style.display = 'flex';
    } else if (statusEl) {
      statusEl.innerHTML = '<span class="hw-badge hw-unavailable">CPU only (no GPU encoder found)</span>';
      if (toggleEl) toggleEl.style.display = 'none';
      currentSettings.useHw = false;
    }
  } catch (err) {
    console.error('HW encoder detection failed:', err);
    if (statusEl) {
      statusEl.innerHTML = '<span class="hw-badge hw-unavailable">CPU only</span>';
    }
    currentSettings.useHw = false;
  }
}

function showFFmpegWarning(statusEl, warningEl) {
  if (statusEl) {
    statusEl.innerHTML = '<span class="status-badge status-error">FFmpeg Not Found ❌</span>';
  }
  if (warningEl) warningEl.style.display = 'flex';
  // Disable primary action buttons
  const btns = ['#btn-browse-source', '#btn-scan', '#btn-compress'];
  btns.forEach((sel) => {
    const btn = $(sel);
    if (btn) btn.disabled = true;
  });
}

// ─── Browse Folder ───────────────────────────────────────────────────────────

async function browseFolder(title) {
  try {
    const data = await apiPost('/api/browse-folder', { title: title || 'Select Folder' });
    return data.path || '';
  } catch (err) {
    console.error('Browse folder failed:', err);
    return '';
  }
}

// ─── Scan Files ──────────────────────────────────────────────────────────────

async function scanFolder() {
  const sourcePath = $('#source-path');
  if (!sourcePath || !sourcePath.value.trim()) {
    alert('Vui lòng chọn thư mục chứa video trước.');
    return;
  }

  showLoading('Scanning folder...');

  try {
    const data = await apiPost('/api/scan', {
      folder: sourcePath.value.trim(),
      include_subfolders: true
    });

    allFiles = Array.isArray(data.files) ? data.files : [];
    currentSettings.sourceFolder = sourcePath.value.trim();

    // Set default output folder
    const outputPath = $('#output-path');
    if (outputPath && !outputPath.value.trim()) {
      currentSettings.outputFolder = currentSettings.sourceFolder + '/_compressed';
      outputPath.placeholder = currentSettings.outputFolder;
    }

    // Update scan stats
    const scanInfo = $('#scan-info');
    const scanSection = $('#scan-section');
    const emptyState = $('#empty-state');
    const fileCount = $('#file-count');
    const totalSize = $('#total-size');

    if (allFiles.length > 0) {
      let totalBytes = 0;
      allFiles.forEach((f) => { totalBytes += f.size || 0; });

      if (fileCount) fileCount.textContent = allFiles.length;
      if (totalSize) totalSize.textContent = formatFileSize(totalBytes);
      if (scanInfo) scanInfo.style.display = 'flex';
      if (scanSection) scanSection.style.display = 'block';
      if (emptyState) emptyState.style.display = 'none';

      renderFileTable();
    } else {
      if (scanInfo) scanInfo.style.display = 'none';
      if (scanSection) scanSection.style.display = 'block';
      if (emptyState) emptyState.style.display = 'flex';
      // Clear table
      const tbody = $('#file-table-body');
      if (tbody) tbody.innerHTML = '';
    }
  } catch (err) {
    console.error('Scan failed:', err);
    alert('Lỗi khi quét thư mục: ' + err.message);
  } finally {
    hideLoading();
  }
}

// ─── Render File Table ───────────────────────────────────────────────────────

function renderFileTable() {
  const tbody = $('#file-table-body');
  if (!tbody) return;

  tbody.innerHTML = '';
  selectedFiles.clear();

  const thresholdBytes = currentSettings.sizeThreshold * 1024 * 1024;

  allFiles.forEach((file, index) => {
    const isBelowThreshold = (file.size || 0) < thresholdBytes;
    const tr = document.createElement('tr');
    tr.dataset.index = index;
    tr.dataset.path = file.path || '';

    if (isBelowThreshold) {
      tr.classList.add('disabled');
    }

    const checkboxId = `file-check-${index}`;

    tr.innerHTML = `
      <td class="col-check">
        <label class="checkbox-custom checkbox-small">
          <input type="checkbox" id="${checkboxId}" data-file-index="${index}"
            ${isBelowThreshold ? 'disabled' : 'checked'}>
          <span class="checkmark"></span>
        </label>
      </td>
      <td class="col-name" title="${escapeHtml(file.path || '')}">
        ${escapeHtml(getBasename(file.path))}
      </td>
      <td class="col-res">${escapeHtml(file.resolution || '-')}</td>
      <td class="col-duration">${formatDuration(file.duration)}</td>
      <td class="col-size" data-bytes="${file.size || 0}">${formatFileSize(file.size)}</td>
      <td class="col-codec">${escapeHtml(file.codec_name || '-')}</td>
      <td class="col-status">
        <span class="status-cell" id="status-${index}">
          ${isBelowThreshold ? '⊘ Below threshold' : '⏳ Pending'}
        </span>
      </td>
    `;

    tbody.appendChild(tr);

    // Add to selected if not below threshold
    if (!isBelowThreshold && file.path) {
      selectedFiles.add(file.path);
    }
  });

  // Attach checkbox listeners
  tbody.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', onFileCheckboxChange);
  });

  // Update select-all state
  updateSelectAllState();
  updateSelectionStats();
}

function onFileCheckboxChange(e) {
  const index = parseInt(e.target.dataset.fileIndex, 10);
  const file = allFiles[index];
  if (!file) return;

  if (e.target.checked) {
    selectedFiles.add(file.path);
  } else {
    selectedFiles.delete(file.path);
  }

  updateSelectAllState();
  updateSelectionStats();
}

function updateSelectAllState() {
  const selectAll = $('#select-all');
  if (!selectAll) return;

  const thresholdBytes = currentSettings.sizeThreshold * 1024 * 1024;
  const eligibleFiles = allFiles.filter((f) => (f.size || 0) >= thresholdBytes);
  const selectedEligible = eligibleFiles.filter((f) => selectedFiles.has(f.path));

  if (eligibleFiles.length === 0) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
  } else if (selectedEligible.length === eligibleFiles.length) {
    selectAll.checked = true;
    selectAll.indeterminate = false;
  } else if (selectedEligible.length === 0) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
  } else {
    selectAll.checked = false;
    selectAll.indeterminate = true;
  }
}

// ─── SSE / Progress ──────────────────────────────────────────────────────────

function connectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  eventSource = new EventSource('/api/progress');

  eventSource.onmessage = function (e) {
    try {
      const data = JSON.parse(e.data);
      updateProgress(data);

      if (data.completed || data.cancelled) {
        eventSource.close();
        eventSource = null;
        isCompressing = false;
        updateCompressButtonState();

        if (data.completed) {
          showResults(data);
        }
        if (data.cancelled) {
          resetProgressUI();
          alert('Đã hủy quá trình nén.');
        }
      }
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  };

  eventSource.onerror = function () {
    console.warn('SSE connection error. Attempting to reconnect...');
    // EventSource auto-reconnects by default.
    // If compression is no longer running, close it.
    if (!isCompressing) {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    }
  };
}

function updateProgress(data) {
  const totalFiles = data.total_files || 1;
  const currentIndex = data.current_index || 0;
  const fileProgress = data.file_progress || 0;

  // Overall progress bar
  const overallPercent = (currentIndex / totalFiles) * 100;
  const overallBar = $('#overall-progress');
  if (overallBar) overallBar.style.width = overallPercent + '%';

  const overallText = $('#overall-progress-text');
  if (overallText) overallText.textContent = `${currentIndex} / ${totalFiles} files`;

  // File progress bar
  const fileBar = $('#file-progress');
  if (fileBar) fileBar.style.width = fileProgress + '%';

  const fileText = $('#file-progress-text');
  if (fileText) fileText.textContent = fileProgress + '%';

  // Current file name
  const currentFileName = $('#current-file-name');
  if (currentFileName && data.current_file) {
    currentFileName.textContent = getBasename(data.current_file);
  }

  // Encoding stats
  const encodeFps = $('#encode-fps');
  if (encodeFps) encodeFps.textContent = data.file_fps || '0';

  const encodeSpeed = $('#encode-speed');
  if (encodeSpeed) encodeSpeed.textContent = data.file_speed || '0x';

  // Show encoder being used
  const encoderEl = $('#current-encoder');
  if (encoderEl && data.encoder) {
    encoderEl.textContent = data.encoder;
  }

  // Update file table statuses
  if (data.current_file) {
    // Mark current file as processing
    allFiles.forEach((file, idx) => {
      const statusCell = $(`#status-${idx}`);
      if (!statusCell) return;

      if (file.path === data.current_file) {
        statusCell.innerHTML = '<span class="status-processing">⏳ Processing...</span>';
      }
    });
  }

  // Mark completed files
  if (data.completed_files && Array.isArray(data.completed_files)) {
    data.completed_files.forEach((completedPath) => {
      allFiles.forEach((file, idx) => {
        if (file.path === completedPath && !completedIndices.has(idx)) {
          completedIndices.add(idx);
          const statusCell = $(`#status-${idx}`);
          if (statusCell) {
            statusCell.innerHTML = '<span class="status-done">Done ✅</span>';
          }
        }
      });
    });
  }

  // Alternatively, mark by index
  if (data.completed_index != null) {
    const idx = data.completed_index;
    if (!completedIndices.has(idx)) {
      completedIndices.add(idx);
      const statusCell = $(`#status-${idx}`);
      if (statusCell) {
        statusCell.innerHTML = '<span class="status-done">Done ✅</span>';
      }
    }
  }
}

function resetProgressUI() {
  const progressSection = $('#progress-section');
  if (progressSection) progressSection.style.display = 'none';

  const overallBar = $('#overall-progress');
  if (overallBar) overallBar.style.width = '0%';

  const fileBar = $('#file-progress');
  if (fileBar) fileBar.style.width = '0%';

  const overallText = $('#overall-progress-text');
  if (overallText) overallText.textContent = '0 / 0 files';

  const fileText = $('#file-progress-text');
  if (fileText) fileText.textContent = '0%';

  const currentFileName = $('#current-file-name');
  if (currentFileName) currentFileName.textContent = 'Đang chuẩn bị...';

  completedIndices.clear();
}

// ─── Results ─────────────────────────────────────────────────────────────────

function showResults(data) {
  const progressSection = $('#progress-section');
  const resultsSection = $('#results-section');

  if (progressSection) progressSection.style.display = 'none';
  if (resultsSection) {
    resultsSection.style.display = 'block';
    setTimeout(() => {
      resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  }

  const tbody = $('#results-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const results = data.results || [];
  let sumOriginal = 0;
  let sumCompressed = 0;

  results.forEach((result) => {
    const originalSize = result.original_size || 0;
    const compressedSize = result.compressed_size || 0;
    const saved = originalSize - compressedSize;
    const percentReduction = originalSize > 0
      ? ((saved / originalSize) * 100).toFixed(1)
      : '0.0';

    sumOriginal += originalSize;
    sumCompressed += compressedSize;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td title="${escapeHtml(result.file || '')}">${escapeHtml(getBasename(result.file))}</td>
      <td>${formatFileSize(originalSize)}</td>
      <td>${formatFileSize(compressedSize)}</td>
      <td>${formatFileSize(saved)}</td>
      <td><span class="percent-badge">${percentReduction}%</span></td>
    `;
    tbody.appendChild(tr);
  });

  // Totals
  const totalSaved = sumOriginal - sumCompressed;
  const totalPercent = sumOriginal > 0
    ? ((totalSaved / sumOriginal) * 100).toFixed(1)
    : '0.0';

  const totalOriginalEl = $('#total-original');
  const totalCompressedEl = $('#total-compressed');
  const totalSavedEl = $('#total-saved');
  const totalPercentEl = $('#total-percent');

  if (totalOriginalEl) totalOriginalEl.textContent = formatFileSize(sumOriginal);
  if (totalCompressedEl) totalCompressedEl.textContent = formatFileSize(sumCompressed);
  if (totalSavedEl) totalSavedEl.textContent = formatFileSize(totalSaved);
  if (totalPercentEl) totalPercentEl.innerHTML = `<span class="percent-badge percent-total">${totalPercent}%</span>`;

  // Show errors if any
  const errors = data.errors || [];
  const errorList = $('#error-list');
  const errorItems = $('#error-items');

  if (errors.length > 0 && errorList && errorItems) {
    errorList.style.display = 'block';
    errorItems.innerHTML = '';
    errors.forEach((err) => {
      const li = document.createElement('li');
      li.textContent = typeof err === 'string' ? err : `${err.file || 'Unknown'}: ${err.message || err.error || 'Error'}`;
      errorItems.appendChild(li);
    });
  } else if (errorList) {
    errorList.style.display = 'none';
  }

  // Re-enable compress button
  updateCompressButtonState();

  // Update open-output button text based on replace_original setting
  const btnOpenOutput = $('#btn-open-output');
  if (btnOpenOutput) {
    btnOpenOutput.textContent = currentSettings.replaceOriginal
      ? '📁 Mở thư mục nguồn'
      : '📁 Mở thư mục đầu ra';
  }
}

// ─── Compression ─────────────────────────────────────────────────────────────

async function startCompression() {
  if (isCompressing) return;

  const filePaths = Array.from(selectedFiles);
  if (filePaths.length === 0) {
    alert('Vui lòng chọn ít nhất một file để nén.');
    return;
  }

  // Confirm if replace-original is checked
  if (currentSettings.replaceOriginal) {
    const confirmed = confirm(
      '⚠️ BẠN ĐÃ BẬT CHẾ ĐỘ GHI ĐÈ FILE GỐC!\n\n' +
      'Sau khi nén xong, file gốc sẽ bị XÓA VĨNH VIỄN và thay thế bằng file đã nén.\n\n' +
      'Bạn có chắc chắn muốn tiếp tục?'
    );
    if (!confirmed) return;
  }

  // Determine output folder
  const outputPathInput = $('#output-path');
  const outputFolder = (outputPathInput && outputPathInput.value.trim())
    ? outputPathInput.value.trim()
    : currentSettings.sourceFolder + '/_compressed';
  currentSettings.outputFolder = outputFolder;

  try {
    isCompressing = true;
    completedIndices.clear();
    updateCompressButtonState();

    // Show progress, hide results
    const progressSection = $('#progress-section');
    const resultsSection = $('#results-section');
    if (progressSection) progressSection.style.display = 'block';
    if (resultsSection) resultsSection.style.display = 'none';

    // Reset progress bars
    resetProgressUI();
    if (progressSection) progressSection.style.display = 'block';

    // Start SSE before the request so we don't miss events
    connectSSE();

    // Scroll to top so user sees the file table statuses updating
    window.scrollTo({ top: 0, behavior: 'smooth' });

    await apiPost('/api/compress', {
      files: filePaths,
      settings: {
        crf: currentSettings.crf,
        codec: currentSettings.codec,
        preset: currentSettings.preset,
        output_folder: outputFolder,
        source_folder: currentSettings.sourceFolder,
        keep_structure: currentSettings.keepStructure,
        use_hw: currentSettings.useHw,
        replace_original: currentSettings.replaceOriginal
      }
    });
  } catch (err) {
    console.error('Compression start failed:', err);
    alert('Lỗi khi bắt đầu nén: ' + err.message);
    isCompressing = false;
    updateCompressButtonState();
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    resetProgressUI();
  }
}

async function cancelCompression() {
  try {
    await apiPost('/api/cancel', {});
  } catch (err) {
    console.error('Cancel failed:', err);
  }
  // SSE handler will handle the rest when it receives cancelled status
}

// ─── Quality Options ─────────────────────────────────────────────────────────

function setupQualityOptions() {
  const options = $$('.quality-option');
  options.forEach((option) => {
    option.addEventListener('click', () => {
      // Remove active from all
      options.forEach((o) => o.classList.remove('active'));
      option.classList.add('active');

      const crfVal = option.dataset.crf;
      const presetVal = option.dataset.preset;

      const customSection = $('#custom-crf-section');

      if (crfVal === 'custom') {
        // Show custom CRF section
        if (customSection) customSection.style.display = 'block';
        // Use current custom CRF slider value
        const customSlider = $('#custom-crf');
        if (customSlider) {
          currentSettings.crf = parseInt(customSlider.value, 10);
        }
      } else {
        if (customSection) customSection.style.display = 'none';
        currentSettings.crf = parseInt(crfVal, 10);
      }

      if (presetVal) {
        currentSettings.preset = presetVal;
        // Update the encoder preset slider to match
        const presetIndex = PRESET_NAMES.indexOf(presetVal);
        const presetSlider = $('#encoder-preset');
        const presetValueEl = $('#preset-value');
        if (presetIndex !== -1 && presetSlider) {
          presetSlider.value = presetIndex;
        }
        if (presetValueEl) presetValueEl.textContent = presetVal;
      }
    });
  });
}

// ─── Event Listeners Setup ───────────────────────────────────────────────────

function setupEventListeners() {
  const btnBrowseSource = $('#btn-browse-source');
  const sourceInput = $('#source-path');
  const btnScan = $('#btn-scan');

  if (sourceInput && btnScan) {
    sourceInput.addEventListener('input', () => {
      btnScan.disabled = sourceInput.value.trim().length === 0;
    });
  }

  if (btnBrowseSource) {
    btnBrowseSource.addEventListener('click', async () => {
      const path = await browseFolder('Chọn thư mục nguồn');
      if (path) {
        if (sourceInput) sourceInput.value = path;
        if (btnScan) btnScan.disabled = false;
      }
    });
  }

  // Scan button
  if (btnScan) {
    btnScan.addEventListener('click', scanFolder);
  }

  // Select All
  const selectAll = $('#select-all');
  if (selectAll) {
    selectAll.addEventListener('change', (e) => {
      const thresholdBytes = currentSettings.sizeThreshold * 1024 * 1024;
      const checkboxes = $$('#file-table-body input[type="checkbox"]');

      checkboxes.forEach((cb) => {
        const index = parseInt(cb.dataset.fileIndex, 10);
        const file = allFiles[index];
        if (!file) return;

        const isEligible = (file.size || 0) >= thresholdBytes;
        if (isEligible) {
          cb.checked = e.target.checked;
          if (e.target.checked) {
            selectedFiles.add(file.path);
          } else {
            selectedFiles.delete(file.path);
          }
        }
      });

      updateSelectionStats();
    });
  }

  // Size threshold slider
  const thresholdSlider = $('#size-threshold');
  if (thresholdSlider) {
    thresholdSlider.addEventListener('input', (e) => {
      let value = parseInt(e.target.value, 10);
      if (isNaN(value) || value < 0) value = 0;
      currentSettings.sizeThreshold = value;

      // Re-filter files
      if (allFiles.length > 0) {
        renderFileTable();
      }
    });
    // Also handle blur to clamp values
    thresholdSlider.addEventListener('blur', (e) => {
      let value = parseInt(e.target.value, 10);
      if (isNaN(value) || value < 0) {
        value = 0;
        e.target.value = value;
      }
      currentSettings.sizeThreshold = value;
    });
  }

  // Custom CRF slider
  const customCrf = $('#custom-crf');
  if (customCrf) {
    customCrf.addEventListener('input', (e) => {
      const value = parseInt(e.target.value, 10);
      currentSettings.crf = value;
      const crfValueEl = $('#crf-value');
      if (crfValueEl) crfValueEl.textContent = value;
    });
  }

  // Encoder preset slider
  const encoderPreset = $('#encoder-preset');
  if (encoderPreset) {
    encoderPreset.addEventListener('input', (e) => {
      const index = parseInt(e.target.value, 10);
      const presetName = PRESET_NAMES[index] || 'medium';
      currentSettings.preset = presetName;

      const presetValueEl = $('#preset-value');
      if (presetValueEl) presetValueEl.textContent = presetName;
    });
  }

  // Codec select
  const codecSelect = $('#codec-select');
  if (codecSelect) {
    codecSelect.addEventListener('change', (e) => {
      currentSettings.codec = e.target.value;
    });
  }

  // Browse output folder
  const btnBrowseOutput = $('#btn-browse-output');
  if (btnBrowseOutput) {
    btnBrowseOutput.addEventListener('click', async () => {
      const path = await browseFolder('Chọn thư mục đầu ra');
      if (path) {
        const outputInput = $('#output-path');
        if (outputInput) outputInput.value = path;
        currentSettings.outputFolder = path;
      }
    });
  }

  // Keep structure checkbox
  const keepStructure = $('#keep-structure');
  if (keepStructure) {
    keepStructure.addEventListener('change', (e) => {
      currentSettings.keepStructure = e.target.checked;
    });
  }

  // Hardware acceleration toggle
  const useHwAccel = $('#use-hw-accel');
  if (useHwAccel) {
    useHwAccel.addEventListener('change', (e) => {
      currentSettings.useHw = e.target.checked;
    });
  }

  // Replace original checkbox
  const replaceOriginal = $('#replace-original');
  const replaceWarning = $('#replace-original-warning');
  const outputFolderGroup = $('#output-folder-group');
  if (replaceOriginal) {
    replaceOriginal.addEventListener('change', (e) => {
      currentSettings.replaceOriginal = e.target.checked;
      if (replaceWarning) {
        replaceWarning.style.display = e.target.checked ? 'block' : 'none';
      }
      // Dim/undim the output folder group since it's irrelevant when replacing originals
      if (outputFolderGroup) {
        outputFolderGroup.style.opacity = e.target.checked ? '0.4' : '1';
        outputFolderGroup.style.pointerEvents = e.target.checked ? 'none' : 'auto';
      }
    });
  }

  // Compress button
  const btnCompress = $('#btn-compress');
  if (btnCompress) {
    btnCompress.addEventListener('click', startCompression);
  }

  // Cancel button
  const btnCancel = $('#btn-cancel');
  if (btnCancel) {
    btnCancel.addEventListener('click', cancelCompression);
  }

  // Open output folder — smart: open source folder when replace_original is on
  const btnOpenOutput = $('#btn-open-output');
  if (btnOpenOutput) {
    btnOpenOutput.addEventListener('click', async () => {
      // When replace_original is on, the output folder is empty/unused,
      // so open the source folder where the replaced files live
      const folderToOpen = currentSettings.replaceOriginal
        ? currentSettings.sourceFolder
        : currentSettings.outputFolder;

      if (!folderToOpen) {
        alert('Không có thư mục để mở.');
        return;
      }

      try {
        await apiPost('/api/open-folder', { path: folderToOpen });
      } catch (err) {
        console.error('Failed to open folder:', err);
        alert('Không thể mở thư mục: ' + err.message);
      }
    });
  }

  // Quality options
  setupQualityOptions();

  // Column sort (size)
  const sortableHeaders = $$('.sortable');
  sortableHeaders.forEach((th) => {
    th.addEventListener('click', () => {
      const sortKey = th.dataset.sort;
      if (sortKey === 'size') {
        // Toggle sort direction
        const currentDir = th.dataset.sortDir || 'desc';
        const newDir = currentDir === 'desc' ? 'asc' : 'desc';
        th.dataset.sortDir = newDir;

        allFiles.sort((a, b) => {
          const diff = (a.size || 0) - (b.size || 0);
          return newDir === 'asc' ? diff : -diff;
        });

        th.textContent = newDir === 'asc' ? 'Dung lượng ▲' : 'Dung lượng ▼';
        renderFileTable();
      }
    });
  });
}

// ─── Initialization ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await checkFFmpeg();
  detectHardwareEncoders();
  setupEventListeners();
});
