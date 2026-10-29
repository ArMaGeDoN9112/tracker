import { openSection } from './navigation'
import { test, expect, type Page } from '@playwright/test'

async function signIn(page: Page) {
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
}
async function start(page: Page) {
  await page.goto('/?section=nutrition&day=2026-10-19')
  await signIn(page)
  await expect(page.getByLabel('Время приёма — Москва')).not.toHaveValue('')
}
async function createProduct(page: Page, name = `ТВОРОГ ${crypto.randomUUID()}`) {
  await page.getByRole('button', { name: 'Выбрать из каталога', exact: true }).click()
  await page.getByRole('button', { name: 'Новый продукт', exact: true }).click()
  await page.getByLabel('Название продукта', { exact: true }).fill(name)
  await page.getByLabel('Белки, г на 100 г', { exact: true }).fill('10')
  await page.getByLabel('Жиры, г на 100 г', { exact: true }).fill('5')
  await page.getByLabel('Углеводы, г на 100 г', { exact: true }).fill('20')
  await page.getByLabel('Калории, ккал на 100 г', { exact: true }).fill('180')
  await page.getByRole('button', { name: 'Добавить порцию', exact: true }).click()
  await page.getByLabel('Название порции 1', { exact: true }).fill('Упаковка')
  await page.getByLabel('Количество порции 1, г', { exact: true }).fill('180')
  await page.getByRole('button', { name: 'Сохранить продукт', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Продукт сохранён' })).toBeVisible()
  await page.getByLabel('Поиск продуктов', { exact: true }).fill(name.toLocaleLowerCase('ru'))
  await page.getByRole('button', { name: 'Вернуться к приёму пищи', exact: true }).click()
  return name
}
async function choose(page: Page, name: string) {
  const loaded = page.waitForResponse(response => response.url().endsWith('/api/products') && response.request().method() === 'GET')
  await page.getByRole('button', { name: 'Выбрать из каталога', exact: true }).click()
  await loaded
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) })
  await expect(card).toBeVisible()
  if (!await card.getByRole('button', { name: 'Добавить в приём', exact: true }).isVisible()) await card.locator('summary').click()
  await card.getByRole('button', { name: 'Добавить в приём', exact: true }).click()
  await expect(page.locator('.meal-line').last().getByRole('textbox', { name: /Количество строки/ })).toBeFocused()
  await expect(page.locator('.meal-line').last().getByRole('textbox', { name: /Количество строки/ })).toBeInViewport()
}
const form = (page: Page) => page.getByRole('region', { name: 'Форма приёма пищи', exact: true })
const history = (page: Page) => page.getByRole('region', { name: 'День питания', exact: true })

test('catalog composition, independent product creation, frozen draft, totals after saving, editing and global undo', async ({ page }) => {
  await start(page)
  const name = await createProduct(page)
  await choose(page, name)
  const portion = form(page).getByRole('button', { name: 'Добавить порцию Упаковка · 180.00 г', exact: true })
  await portion.click()
  await expect(page.getByLabel('Количество строки 1, г', { exact: true })).toHaveValue('180')
  await portion.click()
  await expect(page.getByLabel('Количество строки 1, г', { exact: true })).toHaveValue('360')
  await page.getByLabel('Количество строки 1, г', { exact: true }).fill('0,10')
  await portion.click()
  await expect(page.getByLabel('Количество строки 1, г', { exact: true })).toHaveValue('180.1')
  await page.getByLabel('Количество строки 1, г', { exact: true }).fill('90')
  await expect(form(page).locator('.meal-totals')).toHaveCount(0)
  // Editing the card cannot rewrite a product already picked into the meal.
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) })
  const loaded = page.waitForResponse(response => response.url().endsWith('/api/products') && response.request().method() === 'GET')
  await page.getByRole('button', { name: 'Выбрать из каталога', exact: true }).click()
  await loaded
  await expect(card).toBeVisible()
  if (!await card.getByRole('button', { name: 'Изменить', exact: true }).isVisible()) await card.locator('summary').click()
  await card.getByRole('button', { name: 'Изменить', exact: true }).click()
  await page.getByLabel('Калории, ккал на 100 г', { exact: true }).fill('200')
  await page.getByRole('button', { name: 'Сохранить продукт', exact: true }).click()
  await page.getByRole('button', { name: 'Вернуться к приёму пищи', exact: true }).click()
  await expect(form(page).locator('.meal-totals')).toHaveCount(0)
  const second = await createProduct(page)
  await expect(page.getByLabel('Количество строки 1, г')).toHaveValue('90')
  await choose(page, second)
  await page.getByLabel('Количество строки 2, г').fill('30')
  await page.getByLabel('Время приёма — Москва').fill('2026-10-19T12:00')
  await expect(page.getByLabel('Категория приёма')).toHaveCount(0)
  await expect(page.getByLabel('Количество строки 1, г')).toHaveValue('90')
  await page.getByRole('button', { name: 'Сохранить приём пищи', exact: true }).click()
  await expect(form(page).getByRole('status')).toContainText('Приём пищи сохранён')
  await openSection(page, 'Аналитика питания')
  const saved = history(page).getByRole('article').filter({ hasText: name })
  await expect(saved).toHaveCount(1)
  await expect(saved).toContainText('216.00 ккал')
  await saved.getByRole('button', { name: 'Изменить приём', exact: true }).click()
  await page.getByLabel('Количество строки 1, г').fill('30')
  await expect(page.getByLabel('Категория приёма')).toHaveCount(0)
  await page.getByRole('button', { name: 'Сохранить приём пищи', exact: true }).click()
  await expect(saved).toContainText('108.00 ккал')
  await expect(saved).toContainText('Приём пищи')
  await saved.getByRole('button', { name: 'Удалить приём', exact: true }).click()
  await expect(saved).toHaveCount(0)
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await page.getByRole('button', { name: 'Отменить удаление приёма', exact: true }).click()
  await page.goBack()
  await expect(saved).toContainText('108.00 ккал')
  // Cancelling a meal must leave the independently saved card intact.
  await openSection(page, 'Ввод питания')
  await choose(page, second)
  await page.getByRole('button', { name: 'Отменить приём', exact: true }).click()
  await expect(page.getByLabel('Количество строки 1, г')).toHaveCount(0)
  await openSection(page, 'Каталог')
  await expect(page.getByRole('heading', { name: second, exact: true })).toBeVisible()
})

test('lost committed response keeps exact body through navigation and login; replay does not duplicate', async ({ page }) => {
  await start(page)
  const name = await createProduct(page)
  await choose(page, name)
  await page.getByLabel('Количество строки 1, г').fill('100')
  await page.getByLabel('Время приёма — Москва').fill('2026-10-19T13:00')
  const bodies: string[] = []
  page.on('request', request => { if (request.url().endsWith('/api/meals') && request.method() === 'POST') bodies.push(request.postData()!) })
  await page.route('**/api/meals', async route => {
    const response = await route.fetch()
    expect(response.ok()).toBeTruthy()
    await route.abort()
  }, { times: 1 })
  await page.getByRole('button', { name: 'Сохранить приём пищи', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Повторить сохранение приёма', exact: true })).toBeEnabled()
  await expect(page.getByLabel('Количество строки 1, г')).toBeDisabled()
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await page.goBack()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await expect(page.getByLabel('Количество строки 1, г')).toBeHidden()
  await signIn(page)
  expect(bodies).toHaveLength(1)
  await page.getByRole('button', { name: 'Повторить сохранение приёма', exact: true }).click()
  await expect(form(page).getByRole('status')).toContainText('Приём пищи сохранён')
  expect(bodies).toHaveLength(2)
  expect(bodies[0]).toBe(bodies[1])
  const day = await (await page.request.get('/api/nutrition-day?day=2026-10-19')).json()
  expect(day.meals.filter((meal: { lines: { name: string }[] }) => meal.lines.some(line => line.name === name))).toHaveLength(1)
})

test('field errors, confirmed save with refresh failure and real revision conflict preserve composition', async ({ page }) => {
  await start(page)
  const name = await createProduct(page)
  await choose(page, name)
  await page.getByLabel('Время приёма — Москва').fill('2026-10-19T14:00')
  await page.getByLabel('Количество строки 1, г').fill('0')
  await page.getByRole('button', { name: 'Сохранить приём пищи', exact: true }).click()
  await expect(page.getByLabel('Количество строки 1, г')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('#meal-error')).toBeFocused()
  await page.getByLabel('Количество строки 1, г').fill('30')
  await page.route('**/api/meals/*', route => route.request().method() === 'GET' ? route.abort() : route.continue())
  await page.getByRole('button', { name: 'Сохранить приём пищи', exact: true }).click()
  await expect(page.locator('#meal-error')).toContainText('Операция подтверждена сервером')
  await page.unroute('**/api/meals/*')
  await page.getByRole('button', { name: 'Повторить сохранение приёма', exact: true }).click()
  await openSection(page, 'Аналитика питания')
  const saved = history(page).getByRole('article').filter({ hasText: name })
  await saved.getByRole('button', { name: 'Изменить приём', exact: true }).click()
  await page.getByLabel('Количество строки 1, г').fill('90')
  const day = await (await page.request.get('/api/nutrition-day?day=2026-10-19')).json()
  const row = day.meals.find((meal: { lines: { name: string }[] }) => meal.lines.some(line => line.name === name))
  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).csrf_token
  const { id, occurred_at, revision, lines } = row
  const response = await page.request.put(`/api/meals/${id}`, { headers: { Origin: 'https://localhost:5173', 'X-CSRF-Token': csrf }, data: {
    operation_id: crypto.randomUUID(), occurred_at, expected_revision: revision, lines: lines.map(({ totals, ...line }: Record<string, unknown>) => line),
  } })
  expect(response.ok()).toBeTruthy()
  await page.getByRole('button', { name: 'Сохранить приём пищи', exact: true }).click()
  await expect(page.locator('#meal-error')).toContainText('изменён на другом устройстве')
  await expect(page.getByLabel('Количество строки 1, г')).toHaveValue('90')
  await page.getByRole('button', { name: 'Загрузить актуальный приём', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Актуальный приём', exact: true })).toContainText('Приём пищи')
  await page.getByRole('button', { name: 'Продолжить с моим составом', exact: true }).click()
  await page.getByRole('button', { name: 'Сохранить приём пищи', exact: true }).click()
  await expect(saved).toContainText('162.00 ккал')
})

test('exact half-up saved totals, historical milliseconds, movement between days and late day response', async ({ page }) => {
  await start(page)
  const name = await createProduct(page)
  const products = await (await page.request.get('/api/products')).json()
  const product = products.find((row: { name: string }) => row.name === name)
  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).csrf_token
  const source = { id: crypto.randomUUID(), kind: 'product', name, unit: 'g', quantity: '50', basis_quantity: '100',
    protein: null, fat: '0', carbohydrate: '0.01', calories: null, product_id: product.id, product_revision: 1, portion: null }
  const created = await page.request.post('/api/meals', { headers: { Origin: 'https://localhost:5173', 'X-CSRF-Token': csrf }, data: {
    operation_id: crypto.randomUUID(), occurred_at: '2026-10-19T15:00:12.123+03:00', lines: [source, { ...source, id: crypto.randomUUID() }],
  } })
  expect(created.ok()).toBeTruthy()
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await openSection(page, 'Аналитика питания')
  const saved = history(page).getByRole('article').filter({ hasText: name })
  await expect(saved).toContainText('0.01 г')
  await saved.getByRole('button', { name: 'Изменить приём', exact: true }).click()
  await expect(saved.getByRole('listitem')).toHaveCount(2)
  await expect(saved.getByRole('listitem').nth(0)).toContainText('Углеводы: 0.01 г')
  await expect(saved.getByRole('listitem').nth(1)).toContainText('Углеводы: 0.01 г')
  await expect(saved.getByRole('definition').filter({ hasText: '0.01 г' })).toHaveCount(1)
  await expect(form(page).locator('.meal-totals')).toHaveCount(0)
  await expect(page.getByLabel('Категория приёма')).toHaveCount(0)
  await page.getByRole('button', { name: 'Сохранить приём пищи', exact: true }).click()
  await expect(saved).toContainText('15:00')
  const recorded = await (await page.request.get(`/api/meals/${(await created.json()).result_id}`)).json()
  expect(recorded.occurred_at).toBe('2026-10-19T12:00:12.123Z')
  await saved.getByRole('button', { name: 'Изменить приём', exact: true }).click()
  await page.getByLabel('Время приёма — Москва').fill('2026-10-20T00:00')
  await page.getByRole('button', { name: 'Сохранить приём пищи', exact: true }).click()
  await expect(saved).toHaveCount(0)
  await page.getByLabel('День питания — Москва').fill('2026-10-20')
  await expect(saved).toHaveCount(1)
  let release!: () => void
  let reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const captured = new Promise<void>(resolve => { reached = resolve })
  await page.route('**/api/nutrition-day?day=2026-10-20', async route => {
    const response = await route.fetch()
    reached(); await gate; await route.fulfill({ response })
  }, { times: 1 })
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await openSection(page, 'Аналитика питания')
  await captured
  await page.getByLabel('День питания — Москва').fill('2026-10-21')
  await expect(history(page)).toContainText('Нет записей еды')
  release()
  await expect(history(page)).toContainText('Нет записей еды')
  await expect(saved).toHaveCount(0)
})

test('meal layout and keyboard fit at all specified widths', async ({ page }, testInfo) => {
  await start(page)
  const name = await createProduct(page, 'Длинное название продукта '.repeat(7) + crypto.randomUUID().slice(0, 10))
  await choose(page, name)
  await choose(page, name)
  for (const width of [375, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    await page.getByLabel('Количество строки 1, г').focus()
    await page.keyboard.press('Tab')
    await expect(form(page).locator('summary').first()).toBeFocused()
    const save = page.getByRole('button', { name: 'Сохранить приём пищи', exact: true })
    await save.focus()
    const box = (await save.boundingBox())!
    expect(box.height).toBeGreaterThanOrEqual(44)
    if (width < 768) expect(box.y + box.height).toBeLessThanOrEqual((await page.getByRole('navigation', { name: 'Разделы', exact: true }).boundingBox())!.y)
    if (process.env.DIARY_ACCEPTANCE_DIR) await page.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/meals-${testInfo.project.name}-${width}.png`, fullPage: true })
  }
})

test('expired session during CSRF does not automatically save under a new login', async ({ page, context }) => {
  await page.clock.install()
  await start(page)
  const name = await createProduct(page)
  await choose(page, name)
  await page.getByLabel('Количество строки 1, г').fill('100')
  let release!: () => void
  let reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const captured = new Promise<void>(resolve => { reached = resolve })
  await page.route('**/api/auth/csrf', async route => {
    const response = await route.fetch()
    reached(); await gate; await route.fulfill({ response })
  }, { times: 1 })
  await page.getByRole('button', { name: 'Сохранить приём пищи', exact: true }).click()
  await captured
  await context.clearCookies()
  await page.getByRole('link', { name: 'Календарь', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Вход в дневник' })).toBeVisible()
  await signIn(page)
  await openSection(page, 'Ввод питания')
  let writes = 0
  page.on('request', request => { if (request.url().endsWith('/api/meals') && request.method() === 'POST') writes++ })
  release()
  await expect(page.getByRole('button', { name: 'Повторить сохранение приёма', exact: true })).toBeEnabled()
  expect(writes).toBe(0)
  await expect(page.getByLabel('Количество строки 1, г')).toHaveCount(0)
})

test('explicit new selection reads current card while earlier snapshot stays frozen', async ({ page }) => {
  await start(page)
  const name = await createProduct(page)
  await choose(page, name)
  const rows = await (await page.request.get('/api/products')).json()
  const { id, revision, created_at, updated_at, ...values } = rows.find((row: { name: string }) => row.name === name)
  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).csrf_token
  const headers = { Origin: 'https://localhost:5173', 'X-CSRF-Token': csrf }
  expect((await page.request.put(`/api/products/${id}`, { headers, data: {
    ...values, calories: '200', operation_id: crypto.randomUUID(), expected_revision: revision,
  } })).ok()).toBeTruthy()
  await choose(page, name)
  const fields = form(page).locator('.meal-line')
  await expect(fields.nth(0).getByLabel('Калории строки 1, ккал на 100 г', { exact: true })).toHaveValue('180.00')
  await expect(fields.nth(1).getByLabel('Калории строки 2, ккал на 100 г', { exact: true })).toHaveValue('200.00')
})


test('meal uses previous calendar date and exact latest glucose time after midnight', async ({ page }) => {
  await page.route('**/api/entry-form', async route => {
    const response = await route.fetch()
    await route.fulfill({ json: { ...await response.json(), local_time: '2026-10-19T00:15', latest_glucose_at: '2026-10-18T20:45:56.789Z' } })
  })
  await start(page)
  await expect(page.getByLabel('Время приёма — Москва')).toHaveValue('2026-10-19T00:15')
  await page.getByRole('button', { name: 'Время последнего измерения сахара', exact: true }).click()
  await expect(page.getByLabel('Время приёма — Москва')).toHaveValue('2026-10-18T23:45')
  const name = await createProduct(page)
  await choose(page, name)
  await page.getByLabel('Количество строки 1, г').fill('100')
  const request = page.waitForRequest(request => request.url().endsWith('/api/meals') && request.method() === 'POST')
  await page.getByRole('button', { name: 'Сохранить приём пищи', exact: true }).click()
  expect((await request).postDataJSON().occurred_at).toBe('2026-10-18T20:45:56.789Z')
})
