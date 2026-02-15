@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
node app.js %*
echo.
echo Node process ended. Press any key to close this window.
pause >nul
