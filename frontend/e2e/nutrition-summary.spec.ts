import { openSection } from './navigation'
import { test, expect, type Page } from '@playwright/test'

test.use({ timezoneId: 'America/Los_Angeles' })
const summary = (page: Page) => page.getByRole('region', { name: 'Сводки питания', exact: true })
const history = (page: Page) => page.getByRole('region', { name: 'День питания', exact: true })

async function start(page: Page) {
  await page.goto('/?section=nutrition-summary&day=2025-10-19')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Аналитика питания', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Форма приёма пищи', exact: true })).toBeHidden()
}

async function period(page: Page, start: string, end: string) {
  await summary(page).getByLabel('Начало периода питания — Москва').fill(start)
  await summary(page).getByLabel('Конец периода питания — Москва').fill(end)
  await summary(page).getByRole('button', { name: 'Показать период питания' }).click()
  await expect(summary(page).getByTestId('nutrition-bounds')).toHaveText(`${start} — ${end} · Москва · обе даты включены`)
}

test('known days, zero, keyboard day navigation clears unfinished input and refreshed edits/moves/delete/undo', async ({ page }, info) => {
  await start(page)
  const month = info.project.name === 'phone' ? '08' : '07'
  const first = `2025-${month}-01`, second = `2025-${month}-02`, third = `2025-${month}-03`, fourth = `2025-${month}-04`
  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).csrf_token
  const headers = { Origin: 'https://localhost:5173', 'X-CSRF-Token': csrf }
  for (const [day, lines] of [[first, [{ carbohydrate: '10' }, {}]], [second, [{}]]] as const) {
    expect((await page.request.post('/api/meals', { headers, data: { operation_id: crypto.randomUUID(),
      occurred_at: `${day}T00:00:00+03:00`, lines: lines.map(values => ({ id: crypto.randomUUID(), kind: 'one_off', name: 'Контрольная еда', ...values })) } })).ok()).toBeTruthy()
  }
  expect((await page.request.post('/api/water', { headers, data: { operation_id: crypto.randomUUID(), volume_ml: 200,
    occurred_at: `${third}T23:59:59.999+03:00` } })).ok()).toBeTruthy()
  await period(page, first, third)
  await expect(summary(page)).toContainText('Дней с едой: 2; приёмов: 2')
  const average = summary(page).getByTestId('nutrition-average-carbohydrate')
  await expect(average).toContainText('10.00 г; данные неполные')
  await expect(average).toContainText('известных дней: 1; неполных дней: 2')
  await expect(summary(page).getByRole('row').filter({ hasText: first })).toContainText('Известно 10.00; данные неполные')
  await expect(summary(page).getByTestId('nutrition-average-calories')).toContainText('Неизвестно; данные неполные')
  await openSection(page, 'Ввод питания')
  await page.getByRole('button', { name: 'Добавить разовую еду' }).click()
  await page.getByLabel('Название строки 1', { exact: true }).fill('Сохранённый черновик')
  await page.getByRole('button', { name: 'Выбрать из каталога', exact: true }).click()
  await openSection(page, 'Аналитика питания')
  const open = summary(page).getByRole('button', { name: `Открыть питание за ${third}` })
  await open.focus(); await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`section=nutrition&day=${third}`))
  await expect(summary(page)).toBeHidden()
  await expect(page.locator('#nutrition-history')).toBeFocused()
  await expect(history(page)).toContainText('Нет записей еды')
  await expect(page.getByLabel('Название строки 1', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Добавить разовую еду' }).click()
  await page.getByLabel('Название строки 1', { exact: true }).fill('Новая еда')
  await page.getByLabel('Время приёма — Москва').fill(`${third}T23:59`)
  await page.getByLabel('Углеводы строки 1, г за исходную порцию').fill('0')
  await page.getByRole('button', { name: 'Сохранить приём пищи', exact: true }).click()
  await openSection(page, 'Аналитика питания')
  await expect(average).toContainText('5.00 г; данные неполные')
  await expect(average).toContainText('известных дней: 2; неполных дней: 2')
  await openSection(page, 'Ввод питания')
  await history(page).getByRole('button', { name: 'Изменить приём', exact: true }).click()
  await page.getByLabel('Углеводы строки 1, г за исходную порцию').fill('4')
  await page.getByRole('button', { name: 'Сохранить приём пищи', exact: true }).click()
  await openSection(page, 'Аналитика питания')
  await expect(average).toContainText('7.00 г')
  await openSection(page, 'Ввод питания')
  await history(page).getByRole('button', { name: 'Изменить приём', exact: true }).click()
  await page.getByLabel('Время приёма — Москва').fill(`${fourth}T00:00`)
  await page.getByRole('button', { name: 'Сохранить приём пищи', exact: true }).click()
  await openSection(page, 'Аналитика питания')
  await expect(average).toContainText('10.00 г')
  await expect(summary(page)).toContainText('Дней с едой: 2; приёмов: 2')
  await summary(page).getByRole('button', { name: `Открыть питание за ${first}` }).click()
  await history(page).getByRole('button', { name: 'Удалить приём', exact: true }).click()
  await openSection(page, 'Аналитика питания')
  await expect(average).toContainText('Неизвестно; данные неполные')
  await page.getByRole('button', { name: 'Отменить удаление приёма', exact: true }).click()
  await openSection(page, 'Аналитика питания')
  await expect(average).toContainText('10.00 г')
  for (const width of [375, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    for (const button of await summary(page).getByRole('button').all()) {
      const box = await button.boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(44)
      expect(box!.width).toBeGreaterThanOrEqual(44)
    }
    if (process.env.DIARY_ACCEPTANCE_DIR) {
      await summary(page).scrollIntoViewIfNeeded()
      await summary(page).screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/summary-${info.project.name}-${width}.png` })
    }
  }
})

test('two dates default to seven days and allow older, empty and invalid periods', async ({ page }) => {
  await start(page)
  await expect(summary(page).getByRole('row')).toHaveCount(8)
  const defaults = await (await page.request.get('/api/nutrition-summary?period=week')).json()
  await expect(summary(page).getByRole('combobox')).toHaveCount(0)
  await expect(summary(page).getByLabel('Начало периода питания — Москва')).toHaveValue(defaults.start)
  await expect(summary(page).getByLabel('Конец периода питания — Москва')).toHaveValue(defaults.end)
  await summary(page).getByLabel('Начало периода питания — Москва').fill('1901-01-04')
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await openSection(page, 'Аналитика питания')
  await expect(summary(page).getByLabel('Начало периода питания — Москва')).toHaveValue('1901-01-04')
  await expect(summary(page).getByLabel('Конец периода питания — Москва')).toHaveValue(defaults.end)
  await expect(summary(page).getByLabel('Начало периода питания — Москва')).toHaveAttribute('required', '')
  await expect(summary(page).getByLabel('Конец периода питания — Москва')).toHaveAttribute('required', '')
  await summary(page).getByLabel('Конец периода питания — Москва').fill('1901-02-02')
  await summary(page).getByRole('button', { name: 'Показать период питания' }).click()
  await expect(summary(page).getByRole('row')).toHaveCount(31)
  await expect(summary(page).getByTestId('nutrition-bounds')).toHaveText('1901-01-04 — 1901-02-02 · Москва · обе даты включены')
  await expect(summary(page).getByRole('status')).toHaveText('В этом периоде нет записей еды.')
  await expect(summary(page).getByTestId('nutrition-average-protein')).toContainText('известных дней: 0; неполных дней: 0; дней с едой: 0')
  await summary(page).getByLabel('Начало периода питания — Москва').fill('1901-02-03')
  await summary(page).getByRole('button', { name: 'Показать период питания' }).click()
  await expect(summary(page).getByRole('alert')).toContainText('Укажите начало периода не позже окончания')
  await expect(summary(page).getByRole('table')).toHaveCount(0)
})

test('network failure can be retried; delayed real period cannot replace a newer one', async ({ page }) => {
  await page.route('**/api/nutrition-summary?*', route => route.abort(), { times: 1 })
  await start(page)
  await expect(summary(page).getByRole('alert')).toBeVisible()
  let release!: () => void, captured!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { captured = resolve })
  await page.route('**/api/nutrition-summary?period=week', async route => {
    const response = await route.fetch(); captured(); await delayed; await route.fulfill({ response })
  }, { times: 1 })
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await openSection(page, 'Аналитика питания')
  await ready
  await expect(summary(page).getByRole('status')).toHaveText('Загружаем сводку питания…')
  await period(page, '1900-01-01', '1900-01-02')
  const oldResponse = page.waitForResponse('**/api/nutrition-summary?period=week')
  release(); await oldResponse
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(summary(page).getByTestId('nutrition-bounds')).toHaveText('1900-01-01 — 1900-01-02 · Москва · обе даты включены')
  await expect(summary(page).getByRole('row')).toHaveCount(3)
})

test('summary captured before a meal save cannot replace the refreshed result', async ({ page }, info) => {
  await start(page)
  const day = info.project.name === 'phone' ? '2024-08-01' : '2024-07-01'
  await period(page, day, day)
  let release!: () => void, captured!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { captured = resolve })
  const url = `**/api/nutrition-summary?period=custom&start=${day}&end=${day}`
  await page.route(url, async route => {
    const response = await route.fetch(); captured(); await delayed; await route.fulfill({ response })
  }, { times: 1 })
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await openSection(page, 'Аналитика питания')
  await ready
  await openSection(page, 'Ввод питания')
  await page.getByRole('button', { name: 'Добавить разовую еду' }).click()
  await page.getByLabel('Название строки 1', { exact: true }).fill('Новая еда')
  await page.getByLabel('Время приёма — Москва').fill(`${day}T00:00`)
  await page.getByLabel('Белки строки 1, г за исходную порцию').fill('12')
  await page.getByRole('button', { name: 'Сохранить приём пищи', exact: true }).click()
  const average = summary(page).getByTestId('nutrition-average-protein')
  await openSection(page, 'Аналитика питания')
  await expect(average).toContainText('12.00 г')
  const oldResponse = page.waitForResponse(url)
  release(); await oldResponse
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(average).toContainText('12.00 г')
})
