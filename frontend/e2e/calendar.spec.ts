import { test, expect } from '@playwright/test'

test.use({ timezoneId: 'America/Los_Angeles' })

test('month calendar opens the complete Moscow day without losing the draft', async ({ page }, info) => {
  await page.goto('/')
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
  await open.focus(); await page.keyboard.press('Enter')
  const details = calendar.getByRole('region', { name: 'Подробная сводка дня', exact: true })
  await expect(details.getByRole('heading', { name: `Сводка за ${day}` })).toBeFocused()
  await expect(details).toContainText('Обед в календаре')
  await expect(details).toContainText('123.45 ккал')
  await expect(details).toContainText('750 мл')
  await expect(details).toContainText('Сахар: 5.6 ммоль/л')
  await expect(details).toContainText('Подколка: 1.2 ед.')
  await expect(details).toContainText('Запись календаря')
  await expect(page).toHaveURL(new RegExp(`section=calendar&day=${day}`))
  await page.getByRole('link', { name: 'Ввод сахара', exact: true }).click()
  await expect(calendar).toBeHidden()
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('Черновик остаётся')
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
