@echo off
chcp 65001 >nul
title Kick Mod Paneli
cd /d "%~dp0"
if exist .restart del .restart
if not exist config.json (
  echo config.json bulunamadi. config.example.json dosyasinin adini config.json yapip ID ve Secret yaz.
  pause
  exit /b
)
:start
call npm.cmd install --no-audit --no-fund --loglevel=error
start "" cmd /c "timeout /t 2 >nul & start msedge --app=http://127.0.0.1:3000"
node server.js
if exist .restart (
  del .restart
  echo Guncelleme uygulandi, yeniden baslatiliyor...
  goto start
)
pause
