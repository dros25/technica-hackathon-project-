@echo off
rem Double-click to start Guardian: installs what is missing, builds, and opens the public link.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
