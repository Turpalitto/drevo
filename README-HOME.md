# Корни дома: запуск на домашнем ПК (пока нет мини-ПК)

## Что понадобится
- Папка проекта (`index.html`, `server.js`, `package.json`)
- Node.js 22+ (https://nodejs.org — LTS)
- Tailscale (https://tailscale.com/download)
- Придуманный семейный пароль

## 1. Скопируй папку на домашний ПК

Любым способом: флешка, облако, git. База создастся сама в подпапке `data/`.

## 2. Запусти сервер

**Windows:** задай пароль и запусти:
```bat
set KORNI_PASSWORD=ваш-семейный-пароль
start-home.bat
```
Для автозапуска: Win+R → `shell:startup` → положи туда ярлык на `start-home.bat`.
При первом запуске разреши Node.js в брандмауэре.

**Linux/macOS:**
```bash
chmod +x start-home.sh
KORNI_PASSWORD=ваш-семейный-пароль ./start-home.sh
```
Для автозапуска на Linux (systemd):
```bash
sudo cp korni.service /etc/systemd/system/
sudo sed -i 's/поменяйте-меня/ваш-пароль/' /etc/systemd/system/korni.service
sudo sed -i 's/User=%i/User=ваш-пользователь/' /etc/systemd/system/korni.service
sudo mkdir -p /opt/korni && sudo cp -r . /opt/korni/
sudo systemctl enable --now korni
```

Проверка: открой на самом ПК `http://localhost:3000` — должно открыться древо.

## 3. Дай доступ семье (два варианта)

**Вариант А — просто ссылка (рекомендую):**
```bash
tailscale up
tailscale funnel --bg http://localhost:3000
```
Раздай показанную `https://...` ссылку. Ничего ставить родне не надо.

**Вариант Б — только дома по Wi-Fi:**
Узнай IP компьютера (`ipconfig` / `ip a`) и открой с телефона `http://IP:3000`.

## 4. Не забывай
- ПК не должен спать: отключи сон в настройках питания.
- Раз в месяц: «Управление» → скачать JSON-копию.
- Обновление приложения: замени файлы, папку `data/` и пароль не трогай.

## 5. Переезд на мини-ПК (потом)
Скопируй на него всю папку **вместе с `data/`** — древо переедет целиком.
