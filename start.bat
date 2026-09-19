@echo off
title Analab website
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download it from https://nodejs.org then run this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing for the first time, please wait...
  call npm.cmd install
  if errorlevel 1 (
    echo Install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo.
echo Starting Analab. Keep this window open while you use the site.
echo Your admin username and password are shown below the first time only.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000/admin"
node server.js
pause
