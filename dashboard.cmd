@echo off
REM Launches the watch-deploys dashboard and opens it in your default browser.
cd /d "%~dp0"
start "" http://localhost:7879/
node server.js
