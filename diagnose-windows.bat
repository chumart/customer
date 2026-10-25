@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul && (py -3 duo_monitor.py --diagnose) || (python duo_monitor.py --diagnose)
pause
