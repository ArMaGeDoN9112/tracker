import { test, expect, type Page } from '@playwright/test'

async function signIn(page: Page) {
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
}
async function start(page: Page) {
  await page.goto('/?section=nutrition&day=2026-10-19')
  await signIn(page)
  await expect(page.getByRole('heading', { name: 'Вода', exact: true })).toBeVisible()
  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).csrf_token
  const headers = { Origin: 'https://localhost:5173', 'X-CSRF-Token': csrf }
  const settings = await (await page.request.get('/api/water-settings')).json()
  expect((await page.request.put('/api/water-settings', { headers, data: {
    operation_id: crypto.randomUUID(), expected_revision: settings.revision, volumes_ml: [200, 250, 500],
  } })).ok()).toBeTruthy()
  for (const day of ['2026-10-18', '2026-10-19', '2026-10-20', new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date())]) {
    const data = await (await page.request.get(`/api/nutrition-day?day=${day}`)).json()
    for (const row of data.water) expect((await page.request.post(`/api/water/${row.id}/delete`, { headers, data: {
      operation_id: crypto.randomUUID(), expected_revision: row.revision,
    } })).ok()).toBeTruthy()
  }
  await page.reload()
  await expect(page.getByRole('button', { name: 'Добавить 250 мл', exact: true })).toBeVisible()
}

test('water quick/manual entry, settings, move and global undo preserve draft', async ({ page }) => {
  await start(page)
  await page.getByRole('button', { name: 'Добавить 250 мл', exact: true }).click()
  await expect(page.getByText('Вода сохранена. Показана актуальная история.', { exact: true })).toBeVisible()
  await page.getByLabel('День питания — Москва').fill(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date()))
  await expect(page.getByLabel('История воды').getByRole('article').getByText('250 мл', { exact: true })).toBeVisible()
  await page.getByLabel('Объём воды, мл', { exact: true }).fill('333')
  await page.getByLabel('Время воды — Москва', { exact: true }).fill('2026-10-19T14:00')
  await page.getByRole('button', { name: 'Сохранить воду', exact: true }).click()
  await page.getByLabel('День питания — Москва').fill('2026-10-19')
  await expect(page.getByText('Сумма воды: 333 мл', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Настроить кнопки воды', exact: true }).click()
  await page.getByLabel('Объёмы кнопок воды, мл').fill('100, 333')
  await page.getByRole('button', { name: 'Сохранить кнопки воды', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Добавить 333 мл', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Изменить воду', exact: true }).click()
  await page.getByLabel('Объём воды, мл', { exact: true }).fill('444')
  await page.getByLabel('Время воды — Москва', { exact: true }).fill('2026-10-18T14:00')
  await page.getByRole('button', { name: 'Сохранить воду', exact: true }).click()
  await expect(page.getByText('Нет записей воды', { exact: true })).toBeVisible()
  await page.getByLabel('День питания — Москва').fill('2026-10-18')
  await expect(page.getByText('Сумма воды: 444 мл', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Удалить воду', exact: true }).click()
  await expect(page.getByText('Нет записей воды', { exact: true })).toBeVisible()
  await page.getByLabel('Объём воды, мл', { exact: true }).fill('123')
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await page.getByRole('button', { name: 'Отменить удаление воды', exact: true }).click()
  await page.getByRole('link', { name: 'Ввод питания', exact: true }).click()
  await expect(page.getByText('Сумма воды: 444 мл', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Объём воды, мл', { exact: true })).toHaveValue('123')
})

async function headers(page: Page) {
  return { Origin: 'https://localhost:5173', 'X-CSRF-Token': (await (await page.request.get('/api/auth/csrf')).json()).csrf_token }
}
async function manual(page: Page, amount = '333') {
  await page.getByLabel('Объём воды, мл', { exact: true }).fill(amount)
  await page.getByLabel('Время воды — Москва', { exact: true }).fill('2026-10-19T14:00')
  await page.getByRole('button', { name: 'Сохранить воду', exact: true }).click()
}

test('lost committed quick response keeps body through login; old receipt reads current deletion', async ({ page }) => {
  await start(page)
  const bodies: string[] = []
  page.on('request', request => { if (request.url().endsWith('/api/water') && request.method() === 'POST') bodies.push(request.postData()!) })
  await page.route('**/api/water', async route => {
    expect((await route.fetch()).ok()).toBeTruthy()
    await route.abort()
  }, { times: 1 })
  await page.getByRole('button', { name: 'Добавить 250 мл', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Повторить запрос воды', exact: true })).toBeEnabled()
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await page.goBack()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await expect(page.getByLabel('Объём воды, мл', { exact: true })).toBeHidden()
  await signIn(page)
  await expect(page.getByRole('button', { name: 'Повторить запрос воды', exact: true })).toBeEnabled()
  expect(bodies).toHaveLength(1)
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date())
  const rows = (await (await page.request.get(`/api/nutrition-day?day=${today}`)).json()).water
  expect(rows).toHaveLength(1)
  expect((await page.request.post(`/api/water/${rows[0].id}/delete`, { headers: await headers(page), data: {
    operation_id: crypto.randomUUID(), expected_revision: rows[0].revision,
  } })).ok()).toBeTruthy()
  await page.getByRole('button', { name: 'Повторить запрос воды', exact: true }).click()
  await expect(page.getByText('Вода сохранена. Показана актуальная история.', { exact: true })).toBeVisible()
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toBe(bodies[0])
  await page.getByLabel('День питания — Москва').fill(today)
  await expect(page.getByText('Нет записей воды', { exact: true })).toBeVisible()
})

test('field error, committed refresh failure and peer water revision preserve input', async ({ page }) => {
  await start(page)
  await manual(page, '1.5')
  await expect(page.locator('#water-error')).toBeFocused()
  await expect(page.getByLabel('Объём воды, мл', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  await page.route('**/api/water/*', route => route.request().method() === 'GET' ? route.abort() : route.continue())
  await manual(page)
  await expect(page.locator('#water-error')).toContainText('Операция подтверждена сервером')
  await page.unroute('**/api/water/*')
  await page.getByRole('button', { name: 'Повторить запрос воды', exact: true }).click()
  await expect(page.getByText('Сумма воды: 333 мл', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Изменить воду', exact: true }).click()
  await page.getByLabel('Объём воды, мл', { exact: true }).fill('444')
  const row = (await (await page.request.get('/api/nutrition-day?day=2026-10-19')).json()).water[0]
  expect((await page.request.put(`/api/water/${row.id}`, { headers: await headers(page), data: {
    operation_id: crypto.randomUUID(), expected_revision: row.revision, volume_ml: 555, occurred_at: row.occurred_at,
  } })).ok()).toBeTruthy()
  await page.getByRole('button', { name: 'Сохранить воду', exact: true }).click()
  await expect(page.locator('#water-error')).toContainText('изменена на другом устройстве')
  await page.getByRole('link', { name: 'Ввод сахара', exact: true }).click()
  await page.goBack()
  await expect(page.getByLabel('Объём воды, мл', { exact: true })).toHaveValue('444')
  await page.getByRole('button', { name: 'Загрузить актуальные данные воды', exact: true }).click()
  await expect(page.getByLabel('Актуальная вода')).toContainText('555 мл')
  await page.getByRole('button', { name: 'Продолжить с моим вводом воды', exact: true }).click()
  await page.getByRole('button', { name: 'Сохранить воду', exact: true }).click()
  await expect(page.getByText('Сумма воды: 444 мл', { exact: true })).toBeVisible()
})

test('settings conflict and lost response keep draft; replay reads latest empty buttons', async ({ page }) => {
  await start(page)
  await page.getByRole('button', { name: 'Настроить кнопки воды', exact: true }).click()
  await page.getByLabel('Объёмы кнопок воды, мл').fill('111, 111')
  await page.getByRole('button', { name: 'Сохранить кнопки воды', exact: true }).click()
  await expect(page.getByLabel('Объёмы кнопок воды, мл')).toHaveAttribute('aria-invalid', 'true')
  await page.getByLabel('Объёмы кнопок воды, мл').fill('111, 222')
  const settings = await (await page.request.get('/api/water-settings')).json()
  expect((await page.request.put('/api/water-settings', { headers: await headers(page), data: {
    operation_id: crypto.randomUUID(), expected_revision: settings.revision, volumes_ml: [777],
  } })).ok()).toBeTruthy()
  await page.getByRole('button', { name: 'Сохранить кнопки воды', exact: true }).click()
  await expect(page.locator('#water-error')).toContainText('изменены на другом устройстве')
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await page.goBack()
  await expect(page.getByLabel('Объёмы кнопок воды, мл')).toHaveValue('111, 222')
  await page.getByRole('button', { name: 'Загрузить актуальные данные воды', exact: true }).click()
  await expect(page.getByLabel('Актуальные кнопки воды')).toContainText('777')
  await page.getByRole('button', { name: 'Продолжить с моими кнопками', exact: true }).click()
  const bodies: string[] = []
  page.on('request', request => { if (request.url().endsWith('/api/water-settings') && request.method() === 'PUT') bodies.push(request.postData()!) })
  await page.route('**/api/water-settings', async route => {
    if (route.request().method() !== 'PUT') return route.continue()
    expect((await route.fetch()).ok()).toBeTruthy()
    await route.abort()
  })
  await page.getByRole('button', { name: 'Сохранить кнопки воды', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Повторить запрос воды', exact: true })).toBeEnabled()
  await page.unroute('**/api/water-settings')
  const latest = await (await page.request.get('/api/water-settings')).json()
  expect((await page.request.put('/api/water-settings', { headers: await headers(page), data: {
    operation_id: crypto.randomUUID(), expected_revision: latest.revision, volumes_ml: [],
  } })).ok()).toBeTruthy()
  // Only browser writes are captured above; peer API requests are deliberately separate.
  await page.getByRole('button', { name: 'Повторить запрос воды', exact: true }).click()
  await expect(page.getByText('Кнопки воды сохранены.', { exact: true })).toBeVisible()
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toBe(bodies[0])
  await expect(page.getByRole('button', { name: /^Добавить \d+ мл$/ })).toHaveCount(0)
  await expect(page.getByLabel('Объём воды, мл', { exact: true })).toBeEnabled()
  await manual(page, '99')
  await expect(page.getByText('Сумма воды: 99 мл', { exact: true })).toBeVisible()
})

test('late old-day response, loading/error and layout at specified widths', async ({ page }, testInfo) => {
  await start(page)
  await manual(page)
  await expect(page.getByText('Сумма воды: 333 мл', { exact: true })).toBeVisible()
  let release!: () => void
  let reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const captured = new Promise<void>(resolve => { reached = resolve })
  await page.route('**/api/nutrition-day?day=2026-10-19', async route => {
    const response = await route.fetch()
    reached(); await gate; await route.fulfill({ response })
  }, { times: 1 })
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await page.getByRole('link', { name: 'Ввод питания', exact: true }).click()
  await captured
  await expect(page.getByText('Загружаем воду…', { exact: true })).toBeVisible()
  await page.getByLabel('День питания — Москва').fill('2026-10-18')
  await expect(page.getByText('Нет записей воды', { exact: true })).toBeVisible()
  const lateResponse = page.waitForResponse(response => response.url().endsWith('/api/nutrition-day?day=2026-10-19'))
  release()
  await lateResponse
  await page.unroute('**/api/nutrition-day?day=2026-10-19')
  await expect(page.getByText('Нет записей воды', { exact: true })).toBeVisible()
  await page.route('**/api/nutrition-day?day=2026-10-18', route => route.abort())
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await page.getByRole('link', { name: 'Ввод питания', exact: true }).click()
  await expect(page.getByText('Не удалось загрузить воду. Перезагрузите страницу.', { exact: true })).toBeVisible()
  await page.unroute('**/api/nutrition-day?day=2026-10-18')
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await page.getByRole('link', { name: 'Ввод питания', exact: true }).click()
  await expect(page.getByText('Нет записей воды', { exact: true })).toBeVisible()
  await page.getByLabel('Объём воды, мл', { exact: true }).fill('123')
  for (const width of [375, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    await page.getByLabel('Объём воды, мл', { exact: true }).focus()
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('Время воды — Москва', { exact: true })).toBeFocused()
    const box = await page.getByRole('button', { name: 'Сохранить воду', exact: true }).boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(44)
    if (process.env.DIARY_ACCEPTANCE_DIR) await page.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/water-${testInfo.project.name}-${width}.png`, fullPage: true })
  }
})

test('late settings response cannot replace acknowledged newer buttons', async ({ page }) => {
  await start(page)
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  let release!: () => void
  let reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const captured = new Promise<void>(resolve => { reached = resolve })
  await page.route('**/api/water-settings', async route => {
    const response = await route.fetch()
    reached(); await gate; await route.fulfill({ response })
  }, { times: 1 })
  await page.getByRole('link', { name: 'Ввод питания', exact: true }).click()
  await captured
  await page.getByRole('button', { name: 'Настроить кнопки воды', exact: true }).click()
  await page.getByLabel('Объёмы кнопок воды, мл').fill('111, 222')
  await page.getByRole('button', { name: 'Сохранить кнопки воды', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Добавить 111 мл', exact: true })).toBeVisible()
  const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/water-settings'))
  release()
  await oldResponse
  // initialize reads the form only after applying the settings response.
  await page.waitForResponse(response => response.url().endsWith('/api/entry-form'))
  await expect(page.getByRole('button', { name: 'Добавить 111 мл', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Добавить 250 мл', exact: true })).toHaveCount(0)
})

test('intentionally empty water time survives navigation and login', async ({ page }) => {
  await start(page)
  await expect(page.getByLabel('Время воды — Москва', { exact: true })).not.toHaveValue('')
  await page.getByLabel('Объём воды, мл', { exact: true }).fill('123')
  await page.getByLabel('Время воды — Москва', { exact: true }).fill('')
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  const initialized = page.waitForResponse(response => response.url().endsWith('/api/entry-form'))
  await page.goBack()
  await initialized
  await expect(page.getByLabel('Время воды — Москва', { exact: true })).toHaveValue('')
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await expect(page.getByLabel('Объём воды, мл', { exact: true })).toBeHidden()
  await signIn(page)
  await expect(page.getByLabel('Объём воды, мл', { exact: true })).toHaveValue('123')
  await expect(page.getByLabel('Время воды — Москва', { exact: true })).toHaveValue('')
})
