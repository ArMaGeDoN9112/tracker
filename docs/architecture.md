# Архитектура бэкенда

Бэкенд разделён на четыре слоя; решение зафиксировано в
[ADR-0001](adr/0001-backend-clean-architecture.md). Продуктовые правила,
API и команды сохраняются: [дневник](diabetes-diary.md),
[контракты совместимости](compatibility-baseline.md),
[питание](nutrition-api.md), [экспорт](export/README.md), [резервирование](backup.md).

## Зависимости и сборка

- `diary/domain`: предметные данные, валидация, точность и расчёты времени.
- `diary/application`: классы сценариев с методом `execute`, входные/выходные
  Pydantic DTO, типизированные отказы и порты. Импортирует только domain и
  собственные модули; HTTP, SQL и файловых операций в ядре нет.
- `diary/infrastructure`: SQLite/SQLAlchemy Core, Alembic, криптография,
  файлы и restic. Реализует порты; не импортирует interfaces или сборку.
- `diary/interfaces`: HTTP и CLI, транспортные DTO и сериализация экспорта.
  Вызывает application; не импортирует реализации инфраструктуры.
- `diary/bootstrap.py`: явно связывает сценарии и реализации зависимостей,
  передаёт часы, UUID и криптографический генератор токенов. CLI обращается
  к сборке локальным импортом после разбора аргументов.

Сохранённые точки входа: `diary.app:create_app`, `diary.app:from_env`,
`python -m diary.admin`, `python -m diary.backup`. `diary/app.py` собирает
FastAPI и настраивает HTTP-валидацию; admin/backup запускают CLI-адаптеры.
`diary/tables.py` намеренно остаётся общим описанием таблиц SQLAlchemy Core
для инфраструктуры и тестов; схемой владеют миграции.
HTTP DTO и ограничение размера тела находятся в `diary/interfaces/http/`.
Временные `diary.db`, `diary.security` и прежние функциональные модули удалены.
Помощники создания тестового аккаунта находятся в `tests/admin_setup.py`;
e2e setup вызывает классы сценариев через сборку.

## Перечень сценариев

Каждая самостоятельная операция HTTP/CLI представлена отдельным классом.
Методы общих `*Operations` переиспользуют алгоритм изменения и квитанций;
они не заменяют публичные классы сценариев.

| Модуль application | Классы сценариев |
| --- | --- |
| `access` | `Login`, `Logout`, `GetSession`, `GetCsrf`, `CheckCsrf` |
| `admin` | `CreateAccount`, `ResetPassword`, `MigrateDatabase` |
| `entries` | `CreateEntry`, `EditEntry`, `DeleteEntry`, `RestoreEntry`, `GetEntry`, `GetDay`, `GetEntryForm`, `GetMoscowTime` |
| `basal` | `GetSchedules`, `GetBasal`, `GetTemporaryBasals`, `GetTemporaryBasal`, `CreateSchedule`, `CreateTemporaryBasal`, `EditTemporaryBasal`, `DeleteTemporaryBasal`, `RestoreTemporaryBasal` |
| `products` | `GetProducts`, `GetProduct`, `CreateProduct`, `EditProduct` |
| `meals` | `GetMeal`, `RepeatMeal`, `PreviewMealProduct`, `CreateMeal`, `EditMeal`, `DeleteMeal`, `RestoreMeal` |
| `water` | `GetWater`, `GetWaterSettings`, `CreateWater`, `EditWater`, `DeleteWater`, `RestoreWater`, `EditWaterSettings` |
| `reads` | `GetGlucoseSummary`, `GetNutritionSummary`, `GetNutritionDay` |
| `export` | `ExportDiary` |
| `backup` | `GetBackupStatus`, `CreateBackup`, `VerifyBackup`, `RestorePoint`, `RunBackup` |

День питания читает еду и воду одним снимком через `GetNutritionDay`;
отдельного промежуточного `GetDayWater` больше нет. Повтор еды возвращает
форму, а сохранение выполняет `CreateMeal`. Middleware проверки сессии и CSRF
вызывает те же классы доступа, что подключены сборкой.

## Транзакции и совместимость

Application задаёт границу операции через Unit of Work и момент `commit`.
Адаптер открывает отдельное соединение; изменения используют `BEGIN IMMEDIATE`,
UUID/hash, проверку редакции, запись и квитанцию в одной транзакции.
Составные чтения и экспорт используют единый снимок. Неудачный вход и очистка
счётчиков при лимите фиксируются до ожидаемого отказа. Сброс пароля атомарно
отзывает сессии. Файлы/restic управляются отдельными шагами, с блокировкой,
проверкой восстановления и ротацией только успешных точек.

Переход не добавляет миграций, не преобразует рабочие данные и не меняет JSON v3.
Прежний код можно вернуть на ту же схему SQLite; перед развёртыванием сохраняется
проверенный снимок по [инструкции резервирования](backup.md).
Откат кода не отменяет записи, внесённые пользователем после обновления.

## Проверки

Все исполняемые проверки запускаются через Docker Compose, с временной SQLite,
синтетическими аккаунтами и локальным зашифрованным restic, без рабочей БД:

```sh
docker compose run --build --rm checks
docker compose run --rm checks mypy
docker compose build back backup front
docker compose run --build --rm e2e
```

`tests/test_architecture.py` проверяет импорты всех четырёх пакетов, включая
относительные и вложенные импорты; разрешает `tables` только инфраструктуре,
обращение к bootstrap — только CLI. Тесты ядра работают без HTTP/БД;
API/SQLite сохраняют проверки UUID/revision/undo, снимков и ошибок commit.
`test_admin_cli.py` запускает старые команды через псевдотерминал;
`test_backup.py` проверяет реальный backup/restore/verify и отзыв сессий.
Эталоны прежних квитанций не перегенерируются при рефакторинге.

Итоговая приёмка 2026-10-24: полный backend — **469 passed** (503.47 с),
полный e2e — **130 passed** (desktop/phone), mypy — **59 файлов без ошибок**.
Сборки checks/e2e/back/backup/front успешны; дополнительно проверен запуск
`diary.app:from_env` с временной мигрированной SQLite и HTTP lifespan.
CLI/backup/restore/verify проверены полным backend-набором с реальным локальным
зашифрованным restic. Независимое ревью Standards/Spec — **0/0 замечаний**.
Остались прежние предупреждения Starlette/httpx и Pydantic alias.
Внешнее хранилище, VPS, реальный iPhone и отказы оборудования этой приёмкой
не покрыты. Требования остаются в [общей спецификации](../.scratch/tracker/spec.md),
а состояние внешних копий и учений — в [инструкции резервирования](backup.md).

Завершённый план, карта решений и тикеты 01–09 сохранены в Git-ревизии
`0ed8b3aee0c28a0d3bdf44fdbbe477ee633fff21` в `.scratch/clean-architecture/`.
Каталог удалён из рабочего дерева после переноса результатов сюда;
незавершённых критериев архитектурного перехода нет. Прочитать исходный план:

```sh
git show 0ed8b3a:.scratch/clean-architecture/spec.md
git show 0ed8b3a:.scratch/clean-architecture/issues/09-completion.md
```
