@echo off
rem Double-click launcher for install-windows.ps1. Extra arguments pass through,
rem e.g.  scripts\install-windows.cmd -LocalDb
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" %*
if errorlevel 1 (
  echo.
  echo Installation did not finish. See the messages above.
)
pause
