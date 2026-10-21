@echo off
rem Chrome starts this as the native messaging host; host.ps1 does the work.
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0host.ps1"
