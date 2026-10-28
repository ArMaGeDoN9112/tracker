import { openSection } from './navigation'
import { test, expect } from '@playwright/test'

test.use({ timezoneId: 'America/Los_Angeles' })

test('month calendar opens the complete Moscow day and clears unfinished input', async ({ page }, info) => {
  await page.goto('/?section=diary')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByLabel('Время события — Москва')).not.toHaveValue('')
  const calendar = page.getByRole('region', { name: 'Календарь дней', exact: true })
  const server = await (await page.request.get('/api/entry-form')).json()
  await expect(calendar).toBeHidden()
  const day = info.project.name === 'phone' ? '2024-02-29' : '2024-02-28'
  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).csrf_token
  const headers = { Origin: 'https://localhost:5173', 'X-CSRF-Token': csrf }
  for (const [path, data] of [
    ['/api/meals', { lines: [{ id: crypto.randomUUID(), kind: 'one_off', name: 'Обед в календаре', calories: '123.45', protein: '7' }] }],
    ['/api/water', { volume_ml: 750 }],
    ['/api/entries', { glucose: '5.6', bolus: '1.2', reason: 'food', comment: 'Запись календаря' }],
    ['/api/entries', { glucose: '7.0' }],
    ['/api/entries', { bolus: '0.5' }],
  ] as const) {
    expect((await page.request.post(path, { headers, data: { operation_id: crypto.randomUUID(), occurred_at: `${day}T23:59:59.999+03:00`, ...data } })).ok()).toBeTruthy()
  }
  await page.getByLabel('Комментарий', { exact: true }).fill('Черновик остаётся')
  await page.getByRole('link', { name: 'Календарь', exact: true }).click()
  await expect(page).toHaveURL(/section=calendar/)
  await expect(page.getByRole('heading', { name: 'Календарь', exact: true, level: 1 })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Ввод записи', exact: true })).toBeHidden()
  await expect(calendar.getByLabel('Месяц — Москва')).toHaveValue(server.local_time.slice(0, 7))
  await calendar.getByLabel('Месяц — Москва').fill('2024-02')
  const days = calendar.locator('.calendar-day')
  await expect(days).toHaveCount(29)
  await expect(days.first()).toHaveCSS('grid-column-start', '4')
  const open = calendar.getByRole('button', { name: `Открыть сводку за ${day}:` })
  await expect(open).toContainText('123.45')
  await expect(open).toContainText('750')
  await expect(open.locator('.calendar-glucose')).toHaveText('6,3')
  await expect(open).toHaveAccessibleName(/средний сахар 6,3 ммоль\/л/)
  await expect(days.first().locator('.calendar-glucose')).toHaveText('—')
  await expect(days.first()).toHaveAccessibleName(/нет измерений сахара/)
  await open.focus(); await page.keyboard.press('Enter')
  const details = calendar.getByRole('region', { name: 'Подробная сводка дня', exact: true })
  await expect(details.getByRole('heading', { name: `Сводка за ${day}` })).toBeFocused()
  await expect(details).not.toContainText('Обед в календаре')
  await expect(details).toContainText('123.45 ккал')
  await expect(details).toContainText('750 мл')
  const glucoseChart = details.getByRole('slider', { name: 'Показатели дня по времени' })
  await glucoseChart.focus()
  await glucoseChart.press('End')
  await expect(details.getByRole('tooltip', { name: 'Показатели дня' })).toContainText('5,6 ммоль/л')
  await expect(details.getByRole('tooltip', { name: 'Показатели дня' })).toContainText('7,0 ммоль/л')
  await expect(details.getByRole('tooltip', { name: 'Показатели дня' })).toContainText('1,2 ед.')
  await expect(details.locator('.calendar-records')).toContainText('Запись календаря')
  await expect(details).not.toContainText('Известных строк')
  await expect(details).not.toContainText('Основа:')
  await expect(details).not.toContainText('редакция')
  await expect(details.getByRole('checkbox', { name: 'База', exact: true })).toBeChecked()
  await expect(page).toHaveURL(new RegExp(`section=calendar&day=${day}`))
  await openSection(page, 'Ввод сахара')
  await expect(calendar).toBeHidden()
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('')
  await page.goBack()
  await expect(calendar).toBeVisible()
  await expect(glucoseChart).toBeVisible()
  for (const width of [375, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const box = await days.first().boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)
    const water = await open.locator('.calendar-water').boundingBox()
    const selected = await open.boundingBox()
    expect(water!.y + water!.height).toBeLessThanOrEqual(selected!.y + selected!.height)
    const glucose = await open.locator('.calendar-glucose').boundingBox()
    expect(glucose!.y + glucose!.height).toBeLessThanOrEqual(selected!.y + selected!.height)
    expect((await open.locator('.calendar-calories').boundingBox())!.height).toBeLessThanOrEqual(21)
    if (process.env.DIARY_ACCEPTANCE_DIR) await calendar.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/calendar-${info.project.name}-${width}.png` })
  }
  await calendar.getByRole('button', { name: 'Следующий месяц' }).click()
  await expect(days).toHaveCount(31)
  await expect(details).toHaveCount(0)
  await calendar.getByLabel('Месяц — Москва').fill('2025-02')
  await expect(days).toHaveCount(28)
  await days.first().click()
  await expect(details).toContainText('Нет записей еды')
  await expect(details).toContainText('Нет записей воды')
  await expect(details).toContainText('Нет записей сахара и подколок')
  await page.reload()
  await expect(page.getByRole('link', { name: 'Календарь', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(calendar).toBeVisible()
  await expect(page.getByRole('region', { name: 'Ввод записи', exact: true })).toBeHidden()
})

test('calendar charts show loading and errors and discard a late response for a closed day', async ({ page }) => {
  await page.goto('/?section=calendar&day=2086-01-01')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const details = page.getByRole('region', { name: 'Подробная сводка дня' })
  await expect(details).toContainText('Нет записей сахара и подколок.')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let received!: () => void
  const held = new Promise<void>(resolve => { received = resolve })
  await page.route('**/api/nutrition-day?day=2086-01-02', async route => {
    const response = await route.fetch()
    received()
    await gate
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: 'Открыть сводку за 2086-01-02:' }).click()
  await held
  await expect(details).toContainText('Загружаем сводку дня…')
  await expect(details.getByRole('slider')).toHaveCount(0)
  await page.route('**/api/nutrition-day?day=2086-01-03', route => route.fulfill({ status: 503, json: { message: 'Synthetic read failure' } }))
  await page.getByRole('button', { name: 'Открыть сводку за 2086-01-03:' }).click()
  await expect(details.getByRole('alert')).toContainText('Не удалось загрузить сводку дня.')
  const late = page.waitForResponse('**/api/nutrition-day?day=2086-01-02')
  release()
  await late
  await expect(details.getByRole('alert')).toBeVisible()
  await expect(details.getByRole('slider')).toHaveCount(0)
  await page.unroute('**/api/nutrition-day?day=2086-01-03')
  await page.getByRole('button', { name: 'Открыть сводку за 2086-01-04:' }).click()
  await expect(details.getByRole('slider')).toHaveCount(1)
  await page.getByRole('button', { name: 'Открыть сводку за 2086-01-03:' }).click()
  await expect(details.getByRole('slider')).toHaveCount(1)
  await expect(details.getByRole('alert')).toHaveCount(0)
})
