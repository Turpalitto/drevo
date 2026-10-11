@echo off
REM Домашний сервер "Корни". Запуск: start-home.bat
REM Пароль задаётся переменной окружения KORNI_PASSWORD
if "%KORNI_PASSWORD%"=="" (
  echo Задайте пароль: set KORNI_PASSWORD=ваш-пароль
  pause
  exit /b 1
)
cd /d "%~dp0"
node server.js
pause
