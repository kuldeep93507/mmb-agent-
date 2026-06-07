@echo off
cd /d "%~dp0"
echo Starting MMB AGENT 24/7...
echo.

:: Kill old instances
taskkill /F /FI "WINDOWTITLE eq MMB Backend*" >nul 2>&1

:: Start Backend
start "MMB Backend" cmd /k "python -m server_python.main"

:: Wait 3 seconds then start Frontend
timeout /t 3 /nobreak >nul
start "MMB Frontend" cmd /k "npx vite --port 5178"

echo.
echo Backend: http://localhost:3100
echo Frontend: http://localhost:5178
echo.
echo Both windows khule hain — band mat karna!
pause
