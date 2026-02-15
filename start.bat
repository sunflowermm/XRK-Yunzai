@echo off
REM UTF-8 console to avoid garbled Chinese (use ASCII-only in .bat for CMD parsing)
chcp 65001 >nul 2>&1
cd /d "%~dp0"
node app.js %*
pause
