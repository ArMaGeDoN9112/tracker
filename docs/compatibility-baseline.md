# Исходная совместимость бэкенда

Этап 01 [плана](../.scratch/clean-architecture/spec.md), 2026-10-23.
Исходный код: `8effa07b52c31e8ae3e152f6ef9c2afc639b91be`.
Это перечень поведения перед переносом, а не описание будущих слоёв.
Код `diary/`, миграции, зависимости и Docker-конфигурация на этом этапе не меняются.

## Общий HTTP-контракт

Все `/api/*`, кроме получения CSRF и входа, требуют действующую сессию.
Чтения возвращают 200, запись также 200 с квитанцией; выход — 204 без тела.
Ответы имеют `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
Cookie сессии `__Host-diary-session`: Secure, HttpOnly, SameSite=Strict, Path=/,
без Domain; срок — 30 дней. До входа используется отдельная pre-session на 15 минут.
Изменения требуют `Origin` и `X-CSRF-Token`; Host проверяется отдельно.
API не разрешает CORS. Тело ограничено 65536 байтами.

Ошибки: `{code, message, field}`, включая `field: null`, без входных секретов.
Общие статусы: 400 для чужого Host; 401 без сессии; 403 при Origin/CSRF;
413 при превышении тела; 422 `validation`; 503 `unavailable` при ошибке SQLAlchemy.
404 `not_found` относится к отсутствующей сущности; неверный UUID пути даёт 422.
Конфликты дают 409: `operation_conflict`, `revision_conflict`, `undo_expired`,
а также отдельные конфликты начал расписания и временной базы.
Точные сообщения валидации зависят от поля и маршрута; они остаются в API-тестах.

Квитанция: `{operation_id, action, request_hash, result_id, revision,
completed_at, replayed, undo_remaining_ms}`. Время — UTC с миллисекундами;
`request_hash` — сохранённый SHA-256 нормализованной команды.
Повтор требует совпадения UUID, действия и хеша, возвращает прежний результат
с `replayed: true`, не переписывает сущность и не продлевает отмену.
У удаления остаток отмены пересчитывается по исходному `completed_at`;
у остальных действий он равен 0. Правка/удаление/восстановление проверяют
`expected_revision`; успех повышает редакцию ровно на 1.
Запись и квитанция фиксируются вместе в `BEGIN IMMEDIATE`; при сбое обе откатываются.
Отмена разрешена строго раньше `deleted_at + 30000` мс. Удалённые данные сохраняются.

## Перечень HTTP-сценариев

Сокращение «квитанция» ниже означает весь формат выше; тела и ответы питания
подробно описаны в [nutrition-api.md](nutrition-api.md), экспорта — в
[export/README.md](export/README.md). Для дня используются московские границы
`[полночь, следующая полночь)`, порядок истории устойчив при одинаковом времени.

| Метод и путь | Текущий ответ и побочный эффект | Регрессионные проверки |
| --- | --- | --- |
| GET `/api/auth/csrf` | `{csrf_token}`; без входа создаёт/переиспользует pre-session, после входа токен сессии | `test_access.py` |
| POST `/api/auth/login` | `{login, csrf_token}`, новая cookie; отзывает прежнюю сессию этого устройства и pre-session. Неверный пароль: 401 `invalid_credentials`, счётчик сохраняется; после 5 попыток — 429 `login_limited`, `Retry-After: 900`, очистка старых попыток фиксируется | `test_access.py` |
| GET `/api/auth/session` | `{login}`, без изменений | `test_access.py` |
| POST `/api/auth/logout` | 204, удаляет текущую сессию и cookie; другие устройства продолжают работать | `test_access.py` |
| GET `/api/entry-form` | `{local_time, basal}`: время сервера в Москве до минут и база для этого момента | `test_entries.py`, `test_basal.py` |
| GET `/api/moscow-time?local_time=…` | `{candidates}` со смещениями для локальной минуты; повторный час имеет два кандидата, отсутствующий — 422 `nonexistent_time` | `test_entries.py` |
| POST `/api/entries` | Квитанция `create_entry`; независимые сахар/подколка/комментарий, редакция 1 | `test_entries.py` |
| GET `/api/entries/{id}` | Запись с базой на время события, включая удалённую | `test_entry_changes.py` |
| PUT `/api/entries/{id}` | `edit_entry`; полная правка, сохраняет время создания | `test_entry_changes.py` |
| POST `/api/entries/{id}/delete`, `/restore` | `delete_entry`/`restore_entry`; мягкое удаление/отмена | `test_entry_changes.py` |
| GET `/api/day?day=…` | `{day, basal, entries, basal_changes, temporary_basals, temporary_percent}`; единый снимок записей и базы, без пагинации | `test_entries.py`, `test_basal.py`, `test_read_snapshots.py` |
| GET `/api/basal-schedules` | Массив неизменяемых версий с `intervals`, вычисленными `ends_at` | `test_basal.py` |
| POST `/api/basal-schedules` | `create_basal_schedule`; версия и интервалы атомарны; занятое начало: 409 `schedule_conflict`, плюс `existing_id`, `href` | `test_basal.py` |
| GET `/api/basal?at=…` | `{basal}`: строка с сотыми или null; расписание с временным процентом, half-up | `test_basal.py`, `test_temporary_basal.py` |
| GET `/api/temporary-basals` | Неудалённые периоды по началу, заданное и эффективное окончания | `test_temporary_basal.py` |
| GET `/api/temporary-basals/{id}` | Период, включая удалённый | `test_temporary_basal_changes.py` |
| POST `/api/temporary-basals` | `create_temporary_basal`; конец из длительности; одинаковое начало — 409 `temporary_conflict` | `test_temporary_basal.py` |
| PUT `/api/temporary-basals/{id}` | `edit_temporary_basal`; начало, конец, процент; исходная длительность сохраняется. Соседние окончания вычисляются при чтении | `test_temporary_basal_changes.py` |
| POST `/api/temporary-basals/{id}/delete`, `/restore` | `delete_temporary_basal`/`restore_temporary_basal`; при отмене проверяется занятость начала | `test_temporary_basal_changes.py` |
| GET `/api/products`, `/api/products/{id}` | Все карточки/одна карточка с упорядоченными порциями и фото; архивирования нет | `test_products.py` |
| POST `/api/products` | `create_product`; карточка и порции атомарны | `test_products.py` |
| PUT `/api/products/{id}` | `edit_product`; полная замена с редакцией, смена единицы требует подтверждения; история еды не меняется | `test_products.py`, `test_meals.py` |
| POST `/api/meal-product-preview` | Пересчёт продукта для формы без сохранения | `test_one_off_meals.py` |
| GET `/api/meals/{id}/repeat-form` | Форма повтора с историческими значениями, без создания приёма; сохранение идёт через POST `/api/meals` | `test_one_off_meals.py` |
| GET `/api/meals/{id}` | Приём с историческими строками, происхождением, основой и итогами, включая удалённый | `test_meals.py` |
| POST `/api/meals` | `create_meal`; приём и все строки атомарны; строки продукта и разовой еды могут смешиваться | `test_meals.py`, `test_one_off_meals.py` |
| PUT `/api/meals/{id}` | `edit_meal`; состав заменяется целиком, расчёт сохраняет историческую основу | `test_meals.py` |
| POST `/api/meals/{id}/delete`, `/restore` | `delete_meal`/`restore_meal`; строки сохраняются при удалении | `test_meals.py` |
| GET `/api/nutrition-day?day=…` | `{day, meals, totals, water, water_total_ml}`; единый снимок; отсутствие воды — null, не 0 | `test_meals.py`, `test_water.py`, `test_read_snapshots.py` |
| GET `/api/water/{id}` | Объём, время, редакция и служебные даты, включая удалённую запись | `test_water.py` |
| POST `/api/water` | `create_water`; без времени использует часы сервера, повтор не меняет это время | `test_water.py` |
| PUT `/api/water/{id}` | `edit_water`; объём и обязательное время | `test_water.py` |
| POST `/api/water/{id}/delete`, `/restore` | `delete_water`/`restore_water`; мягкое удаление/отмена | `test_water.py` |
| GET `/api/water-settings` | `{volumes_ml: [200,250,500], revision: 1}` изначально | `test_water.py` |
| PUT `/api/water-settings` | `edit_water_settings`; уникальные целые объёмы в пользовательском порядке, пустой список допустим; историю не меняет | `test_water.py` |
| GET `/api/glucose-summary` | `{start,end,count,average,days}`; week/month/custom, 7/30 дней включая конец, среднее по измерениям; день содержит count/average/minimum/maximum | `test_glucose_charts.py` |
| GET `/api/nutrition-summary` | `{start,end,food_days,meal_count,averages,days}`; те же периоды; средние по известным дням, признаки неполноты, вода отдельно; единый снимок | `test_nutrition_summary.py`, `test_read_snapshots.py` |
| GET `/api/export` | Attachment `diabetes-diary-<unix_ms>.json`, JSON v3, вся история одним снимком, без секретов и квитанций; файл на сервере не создаётся | `test_export.py`, [схема и пример v3](export/README.md) |
| GET `/api/backup-status` | Состояние резервирования и проверки восстановления, задержки и очищенные сообщения ошибок; restic не запускается | `test_backup.py` |

Файлы тестов в таблице находятся в `tests/`. Подколка и сахар хранятся в целых
десятых, питание и расписание — в целых сотых; ответы содержат десятичные строки.
В питании неизвестность (`null`) отличается от известного нуля (`"0.00"`),
калории независимы от БЖУ, итоги округляются half-up только после точного суммирования.

## Перечень CLI-сценариев

| Команда | Текущий результат и побочный эффект | Проверки |
| --- | --- | --- |
| `python -m diary.admin --database PATH migrate` | Идемпотентные миграции; код 0, `Готово.` | `test_admin_cli.py`, тесты обновлений схемы |
| `… create-account --login LOGIN` | Два скрытых ввода пароля; один аккаунт; код 0, `Готово.` | `test_admin_cli.py`, `test_access.py` |
| `… reset-password` | Два скрытых ввода; пароль и отзыв всех сессий атомарны; код 0, `Готово.` | `test_admin_cli.py`, `test_access.py` |
| Отказ admin | Код 1, причина в stderr: несовпадение/невалидность пароля, существующий/отсутствующий аккаунт; при SQL — общее сообщение без параметров. Без TTY ввод запрещён, доступ не меняется. Ошибка argparse — код 2 | `test_admin_cli.py`, `test_access.py` |
| `python -m diary.backup --database PATH backup [--kind daily\|manual\|premigration] [--at OFFSET_DATETIME]` | Согласованная SQLite-копия, bundle релиза и конфигурации, шифрованный restic; статус, readback и ротация только успешных точек | `test_backup.py` |
| `… verify` | Проверка restic с чтением данных и восстановлением последней завершённой точки, обновление статуса проверки | `test_backup.py` |
| `… restore --snapshot ID --target PATH` | Проверяет bundle/схему/целостность, восстанавливает в новый каталог, отзывает сессии; существующую цель не перезаписывает | `test_backup.py` |
| Отказ backup/verify/restore | Код 1, общее сообщение в stderr; ошибка статуса без секретов, частичный сбой не ротирует прежние точки. Параллельная команда отклоняется файловой блокировкой. Успех — код 0 | `test_backup.py` |

Точки запуска сохраняются: `diary.app:from_env`, `python -m diary.admin`,
`python -m diary.backup`; команды развёртывания — в [README](../README.md),
порядок восстановления и ротации — в [backup.md](backup.md).

## Покрытие критических инвариантов

| Инвариант | Существующая защита | Добавлено на этапе 01 |
| --- | --- | --- |
| UUID, нормализация, действие и объект, поздний replay | API-тесты всех модулей, повтор после рестарта/миграции | Замороженные запросы/квитанции всех 20 действий, конфликт изменённого запроса |
| Ревизии и undo | Конкурентные правки/удаления, 29999/30000 мс, сохранение старых квитанций | Replay сохранённых удалений на 29999 и 30000 мс без продления |
| Атомарность записи и квитанции | Сбои commit/receipt/строк/интервалов, нехватка места и блокировка, повтор после отказа | Существующее покрытие сохранено |
| Конкурентные записи | Один UUID, соперничающие ревизии и начала, гонки восстановления, лимит входа | Существующее покрытие сохранено |
| Единый снимок | Экспорт во время записи, карточка/порции и приём/строки; backup во время записи | День дневника, день питания, сводка питания при записи в WAL |
| Доступ | Cookie, Host/Origin/CSRF, сроки/ротация/выход/сброс, лимиты после рестарта, конкурентные входы | Настоящий admin subprocess с псевдотерминалом, отказ без TTY |
| Backup/restore | Реальный локальный шифрованный restic, восстановление и отзыв сессий, семь московских дней, ошибки ключа/места/upload/readback, блокировка, проверка схемы и питания | Существующее покрытие сохранено |
| Экспорт | История, точность, приватность, фиксированные schema/example v1–v3, обновление старой БД | Формат не менялся; эталоны в `docs/export/` сохранены |

## Эталоны команд и квитанций

[operation-receipts.json](../tests/fixtures/compatibility/operation-receipts.json)
содержит 20 синтетических HTTP-запросов, исходные ответы и строки
`operation_receipt` схемы `010_remove_product_archive`. Они сняты однократно
с исходного кода выше через TestClient и временную файловую SQLite,
с фиксированным временем `1792400000000` (2026-10-19T08:53:20.000Z).
Пароли, сессии и рабочие данные в файл не попадали. Генератор не входит в проверки.
Сценарии включают Unicode, запятую/завершающие нули, порции, смешанные строки еды,
неизвестные показатели, время со смещением и воду без явного времени.

`test_legacy_receipts.py` вставляет готовые строки через SQLAlchemy Core,
повторяет миграции, открывает новое приложение и отправляет исходные запросы.
Сущностей-результатов в тестовой БД намеренно нет: квитанция должна обрабатываться
до проверки текущего состояния, без повторного создания данных. Сравнение экспорта
до/после подтверждает отсутствие побочных эффектов. Пустой исходный экспорт
дополняет существующие тесты повторов поверх изменённых и удалённых сущностей.
Хеши и ожидаемые ответы не вычисляются текущими DTO или алгоритмом нормализации.
При переносе не перегенерировать эталоны новым кодом ради зелёного результата.

## Запуски и исходные сбои

Все исполняемые проверки выполняются через Docker Compose, без тома рабочей БД.

| Запуск | Результат |
| --- | --- |
| Исходный `docker compose run --build --rm checks` | 342 passed, 492.54 с |
| Исходный `docker compose run --rm checks mypy` | Success, 16 source files |
| Исходный `docker compose build front` | Успех, TypeScript/Vite, использован валидный кэш сборки |
| Исходный `docker compose run --build --rm e2e` | 130 passed, 2.9 мин, Chromium desktop/phone |
| Профильный `docker compose run --build --rm checks pytest -q tests/test_legacy_receipts.py tests/test_read_snapshots.py tests/test_admin_cli.py` | 8 passed, 13.27 с |
| Повторный `docker compose run --rm checks mypy` | Success, 16 source files |
| После ревью `docker compose run --build --rm checks pytest -q tests/test_admin_cli.py` | 2 passed, 8.84 с; процесс без TTY запускается в новой сессии |
| Финальный `docker compose run --build --rm checks` | 350 passed, 495.31 с; исправление изоляции TTY дополнительно проверено профильным запуском выше |

Исходные сбои: не обнаружены. Отдельно от ошибок: исходный pytest сообщил
предупреждение Starlette об устаревающем httpx TestClient и предупреждение
Pydantic о неработающем `Field(alias='entry_id')` в контексте генерации схемы.
Предупреждения зависимостей не устранялись в рамках фиксации совместимости.
Финальный прогон также зелёный; аналогичные предупреждения Pydantic возникли
для `product_id` и `payload` в конкурентных тестах (всего 4 предупреждения,
включая Starlette). Они не повлияли на результат тестов.

Проверка чувствительности выполнена в отдельном одноразовом контейнере:
подмена сохранённого хеша нулями дала ожидаемые 2 failed/1 passed;
удаление явного `BEGIN` из чтений дневника — 1 failed/2 passed в проверках снимков.
Файлы рабочего дерева при этом не изменялись. Это отрицательные контрольные
эксперименты, а не исходные сбои приложения.

Ревью `code-review`: Standards выявил наследование управляющего терминала
в негативном CLI-тесте; исправлено отдельной сессией subprocess.
Spec: замечаний нет. Повтор CLI после исправления и финальный полный прогон прошли.
