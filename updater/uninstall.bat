@echo off
rem Removes the CopyDocExt updater. The extension itself stays installed.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall
echo.
pause
