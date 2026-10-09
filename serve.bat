@echo off
rem Serve the emulator at http://localhost:8765/ (needed only if double-clicking web\index.html cannot open folders)
cd /d "%~dp0web"
start "" http://localhost:8765/
python -m http.server 8765
