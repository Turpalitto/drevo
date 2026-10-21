#!/bin/sh
# Домашний сервер "Корни". Запуск: KORNI_PASSWORD=ваш-пароль ./start-home.sh
cd "$(dirname "$0")"
if [ -z "$KORNI_PASSWORD" ]; then
  echo "Задайте пароль: KORNI_PASSWORD=ваш-пароль ./start-home.sh"
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Установите Node.js 22.13+ : https://nodejs.org"
  exit 1
fi
exec node --env-file-if-exists=.env server.js
