import { test, expect } from '@playwright/test'

// Run separately against the disposable API; screenshots contain synthetic data only.
test('all A sections, large history, focus and responsive acceptance', async ({ page }) => {
  test.setTimeout(180_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/?section=basal&view=temporary&day=2022-01-02')
  const shot = async (name: string) => {
    await page.screenshot({ path: `/qa/${name}.png`, fullPage: true })
    if (/^(diary|temporary|settings)-(375|1440)$/.test(name)) {
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: `/qa/${name}-top.png` })
    }
  }
  const fits = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(page.getByRole('heading', { name: 'Вход в дневник' })).toBeVisible()
  await shot('login-375')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const temporary = page.getByRole('region', { name: 'Временная база', exact: true })
  await expect(temporary).toBeVisible()
  await expect(temporary.getByText(/ещё не/)).toBeVisible()
  await shot('temporary-empty-375')
  await page.evaluate(async () => {
    const { csrf_token } = await (await fetch('/api/auth/csrf')).json()
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf_token }
    const post = async (path: string, values: object) => {
      const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ operation_id: crypto.randomUUID(), ...values }) })
      if (!response.ok) throw new Error(`Fixture failed: ${path}, ${response.status}`)
    }
    await post('/api/basal-schedules', { starts_at: '2022-01-01T00:00:00+03:00', intervals: [{ minute: 0, rate: '0.55' }, { minute: 480, rate: '0.80' }] })
    await post('/api/temporary-basals', { starts_at: '2022-01-01T23:00:00+03:00', duration_minutes: 240, percent: 120 })
    await post('/api/temporary-basals', { starts_at: '2022-01-02T01:00:00+03:00', duration_minutes: 60, percent: 0 })
    for (let index = 0; index < 32; index++) {
      await post('/api/entries', { occurred_at: `2022-01-02T10:${String(index).padStart(2, '0')}:00+03:00`, glucose: index % 2 ? '6.5' : null,
        comment: index === 0 ? 'Длинный комментарий. '.repeat(40) + 'Конец комментария.' : `Синтетическая запись ${index + 1}` })
    }
  })
  await page.getByRole('link', { name: 'Дневник', exact: true }).click()
  await page.getByLabel('Время события — Москва').fill('2022-01-02T00:30')
  await expect(page.getByTestId('form-basal')).toContainText('0,66 ед/ч')
  await page.getByRole('link', { name: 'База', exact: true }).click()
  await temporary.getByRole('button', { name: /Обновить историю/ }).click()
  await expect(temporary.getByRole('article')).toHaveCount(2)
  await temporary.getByLabel('Начало временной базы — Москва').fill('2022-01-02T00:30')
  await temporary.getByLabel('Длительность, мин').fill('120')
  await temporary.getByLabel('Процент от расписания').fill('110')
  await temporary.getByRole('button', { name: 'Проверить период временной базы', exact: true }).click()
  await expect(temporary.getByRole('status').filter({ hasText: 'Затрагиваемый период' })).toContainText('01:00')
  await shot('temporary-preview-375')
  for (const width of [375, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 960 })
    await fits()
    await shot(`temporary-${width}`)
    await page.getByRole('link', { name: 'Расписание', exact: true }).click()
    await page.getByRole('button', { name: 'Обновить историю', exact: true }).click()
    await expect(page.getByLabel('История расписаний').locator('article')).toHaveCount(1)
    await fits()
    await shot(`schedule-${width}`)
    await page.getByRole('link', { name: 'Дневник', exact: true }).click()
    await page.getByRole('button', { name: 'Обновить день', exact: true }).click()
    await expect(page.locator('.entries > .entry')).toHaveCount(32)
    await expect(page.locator('.comment').filter({ hasText: 'Конец комментария.' })).toBeVisible()
    await expect(page.getByTestId('day-basal')).toContainText('0,66 ед/ч')
    await fits()
    await shot(`diary-${width}`)
    await page.getByRole('link', { name: 'Графики', exact: true }).click()
    await page.getByLabel('Конец периода — Москва').fill('2022-01-02')
    await page.getByRole('button', { name: 'Показать период' }).click()
    await expect(page.getByTestId('period-average')).toContainText('6,5 ммоль/л · измерений: 16')
    await fits()
    await shot(`charts-${width}`)
    await page.getByRole('link', { name: 'Настройки', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Настройки', exact: true })).toContainText('мягко удалённые')
    await fits()
    await shot(`settings-${width}`)
    await page.getByRole('link', { name: 'База', exact: true }).click()
    await page.getByRole('link', { name: 'Временная база', exact: true }).click()
    await expect(temporary.getByLabel('Процент от расписания')).toHaveValue('110')
    expect(await page.locator('button, input, select, textarea, .main-nav a, .basal-nav a, summary').evaluateAll(nodes => nodes.filter(node => {
      const box = node.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && (box.width < 44 || box.height < 44)
    }).map(node => node.textContent || node.id))).toEqual([])
  }
  await page.setViewportSize({ width: 375, height: 812 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  for (const section of ['Временная база', 'Настройки', 'Дневник', 'Графики']) {
    if (section !== 'Временная база') await page.getByRole('link', { name: section, exact: true }).click()
    await fits()
    await shot(`text-200-${section === 'Временная база' ? 'temporary' : section === 'Настройки' ? 'settings' : section === 'Дневник' ? 'diary' : 'charts'}-375`)
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '' })
  await page.getByRole('link', { name: 'База', exact: true }).click()
  await temporary.getByLabel('Процент от расписания').focus()
  await expect(temporary.getByLabel('Процент от расписания')).toBeFocused()
  await shot('focus-375')
  await page.keyboard.press('Tab')
  await expect(temporary.getByRole('button', { name: 'Сохранить временную базу', exact: true })).toBeFocused()
  await page.route('**/api/temporary-basals', route => route.abort())
  await temporary.getByRole('button', { name: /Обновить историю/ }).click()
  await expect(temporary.getByRole('alert').filter({ hasText: /истори/ })).toBeVisible()
  await shot('temporary-history-error-375')
  await page.unroute('**/api/temporary-basals')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/temporary-basals', async route => { await gate; await route.continue() }, { times: 1 })
  await temporary.getByRole('button', { name: /Обновить историю|Повторить загрузку/ }).click()
  await expect(temporary.getByRole('status').filter({ hasText: /Загру/ })).toBeVisible()
  await shot('temporary-history-loading-375')
  release()
  await expect(temporary.getByRole('article')).toHaveCount(2)
  await temporary.getByLabel('Начало временной базы — Москва').fill('2022-01-01T23:00')
  await temporary.getByRole('button', { name: 'Проверить период временной базы', exact: true }).click()
  await temporary.getByRole('button', { name: 'Загрузить актуальную временную базу' }).click()
  await expect(temporary.getByTestId('temporary-latest')).toContainText('120%')
  await expect(temporary.getByLabel('Процент от расписания')).toHaveValue('110')
  await shot('temporary-conflict-375')
  await page.setViewportSize({ width: 1440, height: 960 })
  await shot('temporary-conflict-1440')
  await temporary.getByRole('button', { name: 'Закрыть сравнение', exact: true }).click()
  await temporary.getByRole('article').last().getByRole('button', { name: 'Удалить', exact: true }).click()
  await temporary.getByRole('button', { name: 'Проверить период временной базы', exact: true }).click()
  await temporary.getByRole('button', { name: 'Подтвердить удаление временной базы' }).click()
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(page.getByRole('button', { name: 'Отменить удаление временной базы' })).toBeEnabled()
  await shot('undo-settings-375')
  await page.getByRole('button', { name: 'Отменить удаление временной базы' }).click()
})

test('backup loading, local-only, external success and unknown are visually distinct', async ({ page }) => {
  await page.clock.install()
  await page.setViewportSize({ width: 375, height: 812 })
  let state: 'loading' | 'local' | 'external' | 'error' = 'loading'
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/backup-status', async route => {
    if (state === 'loading') await gate
    if (state === 'error') { await route.fulfill({ status: 503, json: { message: 'Сервис недоступен.' } }); return }
    await route.fulfill({ json: {
      last_external_success: state === 'external' ? '2026-10-19T18:00:00Z' : null,
      last_local_success: '2026-10-19T17:00:00Z', last_verification: '2026-10-19T17:30:00Z',
      overdue: state !== 'external', error: state === 'external' ? null : 'Запуск не завершён: проверьте хранилище.',
      verification_error: state === 'external' ? null : 'Проверка восстановления не прошла.',
    } })
  })
  await page.goto('/?section=settings')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const backup = page.getByRole('region', { name: 'Резервное копирование', exact: true })
  await expect(backup.getByRole('status')).toContainText('Проверяем')
  await page.screenshot({ path: '/qa/backup-loading-375.png', fullPage: true })
  state = 'local'; release()
  await expect(backup.getByRole('alert')).toHaveCount(3)
  await page.screenshot({ path: '/qa/backup-local-errors-375.png', fullPage: true })
  await page.getByRole('link', { name: 'Дневник', exact: true }).click()
  await page.getByLabel('Комментарий', { exact: true }).fill('Черновик при предупреждении копий')
  await expect(page.getByRole('link', { name: /резервирован/i })).toBeVisible()
  await page.screenshot({ path: '/qa/backup-warning-375.png', fullPage: true })
  await page.getByRole('link', { name: /резервирован/i }).click()
  state = 'external'
  await page.clock.fastForward(60_001)
  await expect(backup).toContainText('19.10.2026, 21:00:00 МСК')
  await expect(backup.getByRole('alert')).toHaveCount(0)
  await page.screenshot({ path: '/qa/backup-external-375.png', fullPage: true })
  state = 'error'
  await page.clock.fastForward(60_001)
  await expect(backup).toContainText('неизвестно')
  await expect(backup).not.toContainText('Последняя успешная внешняя копия')
  await page.screenshot({ path: '/qa/backup-unknown-375.png', fullPage: true })
  await page.getByRole('link', { name: 'Дневник', exact: true }).click()
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('Черновик при предупреждении копий')
})
