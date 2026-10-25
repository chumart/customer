@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 注册 Windows 计划任务：每天 4:50 启动监控（必要时唤醒电脑），登录电脑时也自动启动。
rem 监控已经在运行时，新启动的窗口会自动退出，不会重复查询。
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$bat = Join-Path '%~dp0' 'start-windows.bat';" ^
  "$a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c \"' + $bat + '\"') -WorkingDirectory '%~dp0';" ^
  "$t1 = New-ScheduledTaskTrigger -Daily -At 4:50am;" ^
  "$t2 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME;" ^
  "$s = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew;" ^
  "Register-ScheduledTask -TaskName 'iPhoneDuoMonitor' -Action $a -Trigger $t1,$t2 -Settings $s -Force | Out-Null;" ^
  "Write-Host 'OK'"
if errorlevel 1 (echo 设置失败，请截图发给 Claude) else (echo 已设置：每天 4:50 和登录电脑时自动启动 iPhone Duo 监控。)
pause
