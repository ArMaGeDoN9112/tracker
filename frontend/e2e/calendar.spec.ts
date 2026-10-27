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
  await expect(details).toContainText('Обед в календаре')
  await expect(details).toContainText('123.45 ккал')
  await expect(details).toContainText('750 мл')
  await expect(details).toContainText('Сахар: 5.6 ммоль/л')
  await expect(details).toContainText('Подколка: 1.2 ед.')
  await expect(details).toContainText('Запись календаря')
  await expect(details).not.toContainText('Известных строк')
  await expect(details).not.toContainText('Основа:')
  await expect(details).not.toContainText('редакция')
  await expect(details.getByRole('group', { name: 'График базы с 00 до 24 часов, Москва' })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`section=calendar&day=${day}`))
  await openSection(page, 'Ввод сахара')
  await expect(calendar).toBeHidden()
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('')
  await page.goBack()
  await expect(calendar).toBeVisible()
  await expect(details).toContainText('Запись календаря')
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

test('calendar shows basal gaps and zero rates, meal results and water volumes', async ({ page }, info) => {
  await page.goto('/?section=diary')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const total = (value: string | null, incomplete = false) => ({ value, incomplete, known_count: value === null ? 0 : 1, unknown_count: incomplete || value === null ? 1 : 0 })
  const totals = { calories: total('350', true), protein: total('15'), fat: total(null), carbohydrate: total('40') }
  await page.route('**/api/nutrition-day?*', route => route.fulfill({ json: {
    day: '2026-10-20', totals, meals: [{ id: 'meal', occurred_at: '2026-10-20T09:00:00Z', category: 'lunch', totals,
      lines: [{ id: 'food', name: 'Рис с овощами', quantity: '250', unit: 'g' }] }],
    water_total_ml: 750, water: [{ id: 'water-1', occurred_at: '2026-10-20T06:00:00Z', volume_ml: 250 }, { id: 'water-2', occurred_at: '2026-10-20T09:00:00Z', volume_ml: 500 }],
  } }))
  await page.route('**/api/day?*', route => route.fulfill({ json: {
    basal: '0.50', temporary_percent: null, entries: [], temporary_basals: [],
    basal_changes: [{ occurred_at: '2026-10-19T22:40:12.345Z', basal: '0.60' }, { occurred_at: '2026-10-20T03:00:00Z', basal: null }, { occurred_at: '2026-10-20T09:00:00Z', basal: '0.00' }, { occurred_at: '2026-10-20T15:00:00Z', basal: '0.80' }],
  } }))
  await page.getByRole('link', { name: 'Календарь', exact: true }).click()
  await page.getByLabel('Месяц — Москва').fill('2026-10')
  await page.getByRole('button', { name: 'Открыть сводку за 2026-10-20:' }).click()
  const details = page.getByRole('region', { name: 'Подробная сводка дня', exact: true })
  for (const text of ['Обед', 'Рис с овощами', '350 ккал', 'Неполные данные', 'Неизвестно']) await expect(details.getByRole('article')).toContainText(text)
  await expect(details).not.toContainText('Известных строк')
  await expect(details).not.toContainText('Основа:')
  await expect(details).toContainText('750 мл')
  const chart = details.getByRole('group', { name: 'График базы с 00 до 24 часов, Москва' })
  await expect(chart).toBeVisible()
  await expect(details.getByText('Интервалы и скорости', { exact: true })).toHaveCount(0)
  for (const interval of ['00:00–01:40 · 0,50 ед/ч', '01:40–06:00 · 0,60 ед/ч', '06:00–12:00 · неизвестна', '12:00–18:00 · 0,00 ед/ч', '18:00–24:00 · 0,80 ед/ч']) {
    const target = chart.getByRole('button', { name: interval, exact: true })
    await target.hover()
    const [period, rate] = interval.split(' · ')
    await expect(chart.getByRole('tooltip')).toContainText(period)
    await expect(chart.getByRole('tooltip')).toContainText(rate)
  }
  if (process.env.DIARY_ACCEPTANCE_DIR) await chart.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/basal-tooltip-${info.project.name}.png` })
  await page.keyboard.press('Escape')
  await expect(chart.getByRole('tooltip')).toHaveCount(0)
  await details.getByRole('heading', { name: 'Питание', exact: true }).hover()
  await expect(chart.getByRole('tooltip')).toHaveCount(0)
  const zero = chart.getByRole('button', { name: '12:00–18:00 · 0,00 ед/ч', exact: true })
  if (info.project.name === 'phone') await zero.tap()
  else await zero.focus()
  await expect(zero).toBeFocused()
  await expect(chart.getByRole('tooltip')).toContainText('0,00 ед/ч')
  await page.keyboard.press('Escape')
  await expect(chart.getByRole('tooltip')).toHaveCount(0)
  await chart.getByRole('button', { name: '01:40–06:00 · 0,60 ед/ч', exact: true }).dispatchEvent('click')
  await expect(chart.getByRole('tooltip')).toContainText('0,60 ед/ч')
  const bars = details.locator('.water-bar-track>span')
  const small = await bars.nth(0).boundingBox()
  const large = await bars.nth(1).boundingBox()
  expect(large!.width / small!.width).toBeCloseTo(2, 1)
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (process.env.DIARY_ACCEPTANCE_DIR) await details.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/summary-${info.project.name}-${width}.png` })
  }
  await page.route('**/api/day?*', route => route.fulfill({ json: {
    basal: '0.50', temporary_percent: null, entries: [], temporary_basals: [], basal_changes: [
      { occurred_at: '2014-10-25T21:15:00Z', basal: '1.00' },
      { occurred_at: '2014-10-25T21:45:00Z', basal: '0.50' },
      { occurred_at: '2014-10-25T22:15:00Z', basal: '1.00' },
      { occurred_at: '2014-10-25T22:45:00Z', basal: '0.50' },
    ],
  } }))
  await page.getByLabel('Месяц — Москва').fill('2014-10')
  await page.getByRole('button', { name: 'Открыть сводку за 2014-10-26:' }).click()
  await expect(details).toContainText('В этот день переводились часы')
  await expect(details.getByRole('group', { name: 'График базы с 00 до 24 часов, Москва' })).toHaveCount(0)
  await expect(details).toContainText('26.10.2014, 01:15')
  await expect(details).not.toContainText(/GMT|МСК|\d{2}:\d{2}:\d{2}/)
  await expect(details.getByRole('listitem').filter({ hasText: 'ед/ч' })).toHaveCount(5)
})
