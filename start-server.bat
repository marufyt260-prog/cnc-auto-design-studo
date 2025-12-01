@echo off
setlocal ENABLEDELAYEDEXPANSION

REM Change to the script's directory
pushd "%~dp0"

REM Optional: uncomment next line if you want auto-install on first run
REM call npm install --no-audit --no-fund

REM Start both API server and Vite via npm scripts
call npm run start

popd
pause
