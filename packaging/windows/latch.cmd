@echo off
rem LatchVerify's latch command: the Node.js and the app installed next to this file.
"%~dp0node\node.exe" "%~dp0app\dist\cli.js" %*
