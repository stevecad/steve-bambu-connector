@echo off
rem Starts the STEVE Bambu connector and restarts it if it stops. Leave this window open, or run it at logon.
cd /d "%~dp0"
:loop
node connector.js %*
echo Connector stopped (exit %errorlevel%). Restarting in 10 seconds... Ctrl+C to quit.
timeout /t 10 /nobreak >nul
goto loop
