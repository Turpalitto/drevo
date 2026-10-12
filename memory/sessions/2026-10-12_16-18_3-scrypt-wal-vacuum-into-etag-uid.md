# Session

## Goal

Итерация 3: перенос полезного из аналогов — приватность живых, scrypt, WAL/VACUUM INTO, сжатие+ETag, UID

## What was inspected

server.js, index.html (модель, GEDCOM, CSV, гостевая форма), README.md, test/server.test.js, webtrees/Gramps Web/Topola/gedcom.io/node:sqlite/node:zlib.

## Changes made

server.js: (1) /api/contribution/context больше не отдаёт год рождения живых людей — функция isLiving() (нет смерти и год рождения позже текущий-110), добавлено поле living; (2) пароль хранится как scrypt-хеш с солью в kv.password_hash, hashPassword/verifyPassword/refreshPasswordHash, при смене KORNI_PASSWORD хеш пересчитывается; (3) PRAGMA journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000; backupDaily пишет JSON и снимок korni-<дата>.db через VACUUM INTO, ротация по датам для обоих расширений; (4) предсжатие index.html (br q11/zstd/gzip) с согласованием Accept-Encoding, Vary, ETag и 304 для / и ассетов, кэш ассетов в памяти; (5) валидация uid, uid у людей из заявок. index.html: UID_RE/newUid/legacyUid/ensureUids, uid в модели и migrate, 1 UID в GEDCOM и чтение при импорте, колонка uid в CSV, подпись «жив» в гостевом списке. README.md: разделы про WAL, снимок .db, приватность живых и scrypt.

## Files affected

server.js, index.html, README.md, PROJECT_STATE.md

## Decisions

None recorded.

## Tests / validation

npm test — 8/8. Сервер: 39/39 проверок (/tmp/verify_iter3.js) — br 122425→29920 байт и распаковка в исходник, zstd и gzip, ETag/304 для / и ассетов, обход каталога 404, scrypt в kv и отсутствие открытого пароля, journal_mode=wal и файл -wal, VACUUM INTO создаёт korni-<дата>.db с архивом внутри, живые без года, умершие с годом, uid сохраняется и отклоняется невалидный, перезапуск со сменой пароля. Клиент: 12/12 проверок в Chromium (/tmp/cdp_uid.js) — uid новым и старым записям, стабильность uid, 1 UID на человека в GEDCOM, круговорот экспорт→импорт, чтение UID, uid в CSV, консоль чистая. Регрессий нет: быстрые кнопки работают, вид не изменился.

## Problems encountered

Приватность неполная по замыслу: имена живых остаются в списке, иначе гость не выберет родственника. Кэш ассетов в памяти не инвалидируется при замене файла на ходу. lastBackupDay хранится в памяти, поэтому после перезапуска снимок за сегодня не переснимается (VACUUM INTO не перезаписывает существующий файл).

## Remaining work

Локальное хранилище всё ещё localStorage. Нет миграций схемы (PRAGMA user_version). Источники и цитаты, приблизительные даты — по-прежнему не реализованы.

## Recommended next step

Решить по оставшимся пунктам из analogs-2026-10.md: IndexedDB, миграции, источники/цитаты, PWA.
