@echo off
rem LatchVerify launcher: opens the review UI (`latch review --ui`) for a project.
rem When neither LATCH_LOCKFILE_PATH nor .\latch.lock points at a project, it asks for one.
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo LatchVerify needs Node.js 22 or newer on PATH: https://nodejs.org/
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo LatchVerify needs Node.js 22 or newer.
  pause
  exit /b 1
)

if defined LATCH_LOCKFILE_PATH goto run
if exist "%CD%\latch.lock" goto run
set /p "PROJECT=Project folder that contains latch.lock: "
if not exist "%PROJECT%\latch.lock" (
  echo No latch.lock in "%PROJECT%". Run "latch init" in the project first.
  pause
  exit /b 1
)
cd /d "%PROJECT%"

:run
call "%~dp0latch.cmd" review --ui
if errorlevel 1 pause
