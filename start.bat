@echo off
setlocal
title Chinese Checkers Server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Please install Node.js LTS from https://nodejs.org/ and try again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\express\package.json" (
  echo Installing dependencies, this may take a minute...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    echo If you are behind a company proxy, configure it first, for example:
    echo     npm config set proxy http://user:pass@proxy.host:port
    echo     npm config set https-proxy http://user:pass@proxy.host:port
    echo.
    pause
    exit /b 1
  )
  echo.
)

echo ============================================================
echo   Chinese Checkers server starting
echo.
echo   Local:   http://localhost:3000
echo   LAN:     http://YOUR-IP:3000     (run ipconfig to find it)
echo.
echo   Press Ctrl+C to stop.
echo ============================================================
echo.

rem open the browser a few seconds later, after the server is listening
start "" /b cmd /c "ping -n 4 127.0.0.1 >nul & start "" http://localhost:3000"

node server.js
echo.
echo Server stopped.
pause
