import { test, expect, type Page } from '@playwright/test'

async function signIn(page: Page) {
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByLabel('Сахар, ммоль/л')).toBeVisible()
}

test.use({ timezoneId: 'America/Los_Angeles' })

test('move, keyboard undo and conflict preserve the draft for comparison', async ({ page, browser, context }, testInfo) => {
  await page.goto('/')
  await signIn(page)
  const day = testInfo.project.name === 'phone' ? '2026-11-23' : '2026-10-23'
  const nextDay = testInfo.project.name === 'phone' ? '2026-11-24' : '2026-10-24'
  await page.getByLabel('Время события — Москва').fill(`${day}T12:00`)
  await page.getByLabel('Сахар, ммоль/л').fill('6,2')
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.locator('.entries > .entry')).toHaveCount(1)
  await page.getByRole('button', { name: 'Изменить', exact: true }).click()
  await page.getByLabel('Время события — Москва').fill(`${nextDay}T00:00`)
  await page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()
  await expect(page.getByLabel('День — Москва')).toHaveValue(nextDay)
  await expect(page.locator('.entries > .entry time')).toHaveText('00:00')
  await page.getByLabel('День — Москва').fill(day)
  await expect(page.locator('.entries > .entry')).toHaveCount(0)
  await page.getByLabel('День — Москва').fill(nextDay)
  await expect(page.locator('.entries > .entry')).toHaveCount(1)
  await page.clock.install()
  await page.route('**/api/auth/csrf', async route => {
    // Time before the deletion must not consume its server undo window.
    await page.clock.fastForward(31000)
    await route.continue()
  }, { times: 1 })
  await page.locator('.entries').getByRole('button', { name: 'Удалить', exact: true }).click()
  await expect(page.locator('.entries > .entry')).toHaveCount(0)
  const undo = page.getByRole('button', { name: 'Отменить удаление', exact: true })
  await undo.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.entries > .entry')).toHaveCount(1)

  const device = await browser.newContext({ storageState: await context.storageState(), baseURL: 'https://localhost:5173', ignoreHTTPSErrors: true, timezoneId: 'Asia/Tokyo' })
  try {
    const other = await device.newPage()
    await other.goto('/')
    await other.getByLabel('День — Москва').fill(nextDay)
    await expect(other.locator('.entries > .entry')).toHaveCount(1)
    await other.getByRole('button', { name: 'Изменить', exact: true }).click()
    await page.getByRole('button', { name: 'Изменить', exact: true }).click()
    await other.getByLabel('Комментарий', { exact: true }).fill('Изменение другого устройства')
    await other.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()
    await expect(other.locator('.entries')).toContainText('Изменение другого устройства')
    await page.getByLabel('Комментарий', { exact: true }).fill('Мой черновик')
    await page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'другом устройстве' })).toBeVisible()
    await page.getByRole('button', { name: 'Загрузить актуальную запись', exact: true }).click()
    await expect(page.getByLabel('Актуальная запись')).toContainText('Изменение другого устройства')
    await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('Мой черновик')
    await page.getByRole('button', { name: 'Продолжить с моими значениями', exact: true }).click()
    await page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()
    await expect(page.locator('.entries')).toContainText('Мой черновик')
  } finally {
    await device.close()
  }
})

test('edit preserves milliseconds and all changes retry after a lost committed response', async ({ page }, testInfo) => {
  await page.goto('/')
  await signIn(page)
  const day = testInfo.project.name === 'phone' ? '2026-11-25' : '2026-10-25'
  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).csrf_token
  const receipt = await (await page.request.post('/api/entries', {
    headers: { Origin: 'https://localhost:5173', 'X-CSRF-Token': csrf },
    data: { operation_id: crypto.randomUUID(), occurred_at: `${day}T12:34:56.789+03:00`, glucose: '5.6' },
  })).json()
  const path = `/api/entries/${receipt.result_id}`
  const original = await (await page.request.get(path)).json()
  await page.getByLabel('День — Москва').fill(day)
  await expect(page.locator('.entries > .entry')).toHaveCount(1)
  const bodies = new Map<string, string[]>()
  await page.route('**/api/entries/**', async route => {
    if (!['POST', 'PUT'].includes(route.request().method())) return route.continue()
    const key = route.request().url()
    const attempts = bodies.get(key) ?? []
    attempts.push(route.request().postData()!)
    bodies.set(key, attempts)
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    if (attempts.length === 1) await route.abort('connectionfailed')
    else await route.fulfill({ response })
  })
  await page.getByRole('button', { name: 'Изменить', exact: true }).click()
  await page.getByLabel('Комментарий', { exact: true }).fill('С точностью исходного времени')
  await page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('С точностью исходного времени')
  await page.getByRole('button', { name: 'Повторить сохранение', exact: true }).click()
  await expect(page.locator('.entries')).toContainText('С точностью исходного времени')
  await page.locator('.entries').getByRole('button', { name: 'Удалить', exact: true }).click()
  await page.getByRole('button', { name: 'Повторить операцию', exact: true }).click()
  await expect(page.locator('.entries > .entry')).toHaveCount(0)
  await page.getByRole('button', { name: 'Отменить удаление', exact: true }).click()
  await page.getByRole('button', { name: 'Повторить операцию', exact: true }).click()
  await expect(page.locator('.entries > .entry')).toHaveCount(1)
  const saved = await (await page.request.get(path)).json()
  expect(saved.revision).toBe(4)
  expect(saved.occurred_at).toBe(original.occurred_at)
  expect(saved.created_at).toBe(original.created_at)
  expect(bodies.size).toBe(3)
  for (const attempts of bodies.values()) {
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toBe(attempts[1])
  }
  await page.getByRole('button', { name: 'Изменить', exact: true }).click()
  await page.getByLabel('Комментарий', { exact: true }).fill('Черновик при отмене')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/entry-form', async route => {
    await gate
    await route.fulfill({ status: 503, json: { code: 'unavailable', message: 'Не удалось открыть форму.' } })
  })
  await page.getByRole('button', { name: 'Отменить редактирование', exact: true }).click()
  await expect(page.getByLabel('Комментарий', { exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Сохраняем…', exact: true })).toBeDisabled()
  release()
  await expect(page.getByLabel('Комментарий', { exact: true })).toBeEnabled()
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('Черновик при отмене')
})

test('comma, independent bolus/comment, validation and historical Moscow offset', async ({ page }, testInfo) => {
  await page.goto('/')
  await signIn(page)
  const day = testInfo.project.name === 'phone' ? '2026-11-19' : '2026-10-19'
  const time = page.getByLabel('Время события — Москва')
  await expect(page.getByLabel('Сахар, ммоль/л')).toHaveAttribute('inputmode', 'decimal')
  const originalTime = await time.inputValue()
  await page.getByLabel('Сахар, ммоль/л').fill('5,6')
  await expect(time).toHaveValue(originalTime)
  await time.fill(`${day}T00:00`)
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.locator('.entries > .entry')).toHaveCount(1)
  await expect(page.locator('.entries')).toContainText('Сахар: 5,6')
  await expect(page.getByLabel('День — Москва')).toHaveValue(day)
  await expect(page.locator('.entries > .entry time')).toHaveText('00:00')

  await time.fill(`${day}T01:00`)
  await page.getByLabel('Подколка, ед.', { exact: true }).fill('1,2')
  await page.getByLabel('Причина подколки').selectOption('food')
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.locator('.entries > .entry')).toHaveCount(2)
  await expect(page.locator('.entries')).toContainText('Подколка: 1,2')

  await time.fill(`${day}T02:00`)
  await page.getByLabel('Комментарий', { exact: true }).fill('<b>Только комментарий 😀</b>')
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.locator('.entries > .entry')).toHaveCount(3)
  await expect(page.locator('.comment')).toHaveText('<b>Только комментарий 😀</b>')
  await expect(page.locator('.comment b')).toHaveCount(0)

  await page.getByLabel('Сахар, ммоль/л').fill('NaN')
  await page.getByLabel('Комментарий', { exact: true }).fill('Сохранить черновик')
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByLabel('Сахар, ммоль/л')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('Сохранить черновик')

  await page.getByLabel('Сахар, ммоль/л').fill('')
  const historicalCount = (await (await page.request.get('/api/day?day=2014-10-26')).json()).entries.length
  await time.fill('2014-10-26T01:30')
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByLabel('Смещение UTC')).toBeVisible()
  await page.getByLabel('Смещение UTC').selectOption({ label: 'UTC+04:00' })
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByLabel('День — Москва')).toHaveValue('2014-10-26')
  await expect(page.locator('.entries > .entry')).toHaveCount(historicalCount + 1)
})

test('lost committed response retries the same UUID without duplicate', async ({ page }, testInfo) => {
  await page.goto('/')
  await signIn(page)
  const day = testInfo.project.name === 'phone' ? '2026-11-20' : '2026-10-20'
  await page.getByLabel('Время события — Москва').fill(`${day}T12:00`)
  await page.getByLabel('Сахар, ммоль/л').fill('7,8')
  const bodies: string[] = []
  await page.route('**/api/entries', async route => {
    bodies.push(route.request().postData()!)
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    if (bodies.length === 1) await route.abort('connectionfailed')
    else await route.fulfill({ response })
  })
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Повторить сохранение' })).toBeVisible()
  await expect(page.getByLabel('Сахар, ммоль/л')).toHaveValue('7,8')
  await page.getByRole('button', { name: 'Повторить сохранение' }).click()
  await expect(page.locator('.entries > .entry')).toHaveCount(1)
  expect(bodies).toHaveLength(2)
  expect(bodies[0]).toBe(bodies[1])
})

test('expired session keeps draft and requires explicit save after signing in', async ({ page, context }, testInfo) => {
  await page.goto('/')
  await signIn(page)
  const day = testInfo.project.name === 'phone' ? '2026-11-21' : '2026-10-21'
  await page.getByLabel('Время события — Москва').fill(`${day}T10:00`)
  await page.getByLabel('Комментарий', { exact: true }).fill('После повторного входа')
  await context.clearCookies()
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByLabel('Пароль', { exact: true })).toBeVisible()
  await signIn(page)
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('После повторного входа')
  await page.getByLabel('День — Москва').fill(day)
  await page.getByRole('button', { name: 'Обновить день' }).click()
  await expect(page.locator('.entries > .entry')).toHaveCount(0)
  await page.getByRole('button', { name: /^(Сохранить|Повторить сохранение)$/ }).click()
  await expect(page.locator('.entries > .entry')).toHaveCount(1)
})
