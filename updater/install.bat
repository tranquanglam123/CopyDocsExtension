@echo off
rem Sets up one-click updates for CopyDocExt. Run once per Windows user.
rem Cai dat cap nhat mot cham cho CopyDocExt. Chi can chay mot lan.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
    echo.
    echo Setup failed - see the message above. / Cai dat that bai - xem thong bao o tren.
)
echo.
pause
