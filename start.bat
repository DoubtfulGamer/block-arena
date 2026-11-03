@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org then run this again.
  pause
  exit /b 1
)
REM Usage: start.bat        (all game modes take turns; the host can pick one in the game menu)
REM        start.bat ctf    (or rotate ffa tdm hp ctf kc gg inf lms)
node server.js %1
pause
