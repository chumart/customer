@echo off
chcp 65001 >nul
powershell -NoProfile -Command "Unregister-ScheduledTask -TaskName 'iPhoneDuoMonitor' -Confirm:$false; Write-Host 'OK'"
pause
