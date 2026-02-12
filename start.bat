@echo off
REM 切换到当前脚本所在目录（项目根目录）
cd /d "%~dp0"
node app.js %*

