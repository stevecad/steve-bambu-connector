@echo off
rem Starts the STEVE Bambu connector and restarts it if it stops. Leave this window open, or run it at logon.
rem Options are passed on, e.g. start-connector.cmd --config h2d.config.json --data data-h2d
cd /d "%~dp0"
:loop
node "%~dp0connector.js" %*
echo Connector stopped (exit %errorlevel%). Restarting in 10 seconds... Ctrl+C to quit.
timeout /t 10 /nobreak >nul
goto loop
