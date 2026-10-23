@echo off
rem LatchVerify command-line entry point. Needs Node.js 22 or newer on PATH.
node "%~dp0app\dist\cli.js" %*
