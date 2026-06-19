@echo off
cd /d "%~dp0"
echo =========================================
echo       Starting FootageLite Server...
echo =========================================
echo.
echo 1. Kiem tra va cai dat thu vien (neu chua co)...
pip install -r requirements.txt
echo.
echo 2. Khoi dong ung dung...
echo Vui long giu cua so nay mo trong qua trinh su dung.
echo De tat ung dung, ban co the bam dau X de dong cua so nay.
echo.
python app.py
pause
