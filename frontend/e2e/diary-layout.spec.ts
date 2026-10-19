import { test, expect } from '@playwright/test'

test.use({ timezoneId: 'America/Los_Angeles' })

test('neighbor days and server Today preserve the draft and expose day loading and errors', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const time = page.getByLabel('Время события — Москва')
  await expect(time).not.toHaveValue('')
  await time.fill('2014-10-26T01:30')
  await page.getByLabel('Комментарий', { exact: true }).fill('Независимый черновик')
  await page.getByLabel('День — Москва').fill('2026-12-31')
  await page.getByRole('button', { name: 'Следующий день', exact: true }).click()
  await expect(page.getByLabel('День — Москва')).toHaveValue('2027-01-01')
  await page.getByRole('button', { name: 'Предыдущий день', exact: true }).click()
  await expect(page.getByLabel('День — Москва')).toHaveValue('2026-12-31')
  const server = await (await page.request.get('/api/entry-form')).json()
  await page.getByRole('button', { name: 'Сегодня', exact: true }).click()
  await expect(page.getByLabel('День — Москва')).toHaveValue(server.local_time.slice(0, 10))
  await expect(time).toHaveValue('2014-10-26T01:30')
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('Независимый черновик')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/day?day=2027-01-03', async route => { await gate; await route.abort() })
  await page.getByLabel('День — Москва').fill('2027-01-03')
  await expect(page.getByRole('status').filter({ hasText: 'Загружаем день' })).toBeVisible()
  await expect(page.getByText('Записей нет.', { exact: true })).toBeHidden()
  if (process.env.DIARY_ACCEPTANCE_DIR) await page.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/loading-${test.info().project.name}.png`, fullPage: true })
  release()
  await expect(page.getByRole('alert').filter({ hasText: 'Не удалось загрузить день' })).toBeVisible()
  await expect(page.getByText('Записей нет.', { exact: true })).toBeHidden()
  if (process.env.DIARY_ACCEPTANCE_DIR) await page.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/day-error-${test.info().project.name}.png`, fullPage: true })
  await page.getByLabel('День — Москва').fill('2027-01-04')
  await expect(page.getByText('Записей нет.', { exact: true })).toBeVisible()
  if (process.env.DIARY_ACCEPTANCE_DIR) await page.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/empty-${test.info().project.name}.png`, fullPage: true })
})

test('field errors stay beside the draft and confirmed save differs from failed refresh', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByLabel('Сахар, ммоль/л').fill('NaN')
  await page.getByLabel('Комментарий', { exact: true }).fill('Полный черновик')
  await page.getByRole('button', { name: 'Сохранить запись', exact: true }).click()
  const glucose = page.getByLabel('Сахар, ммоль/л')
  await expect(glucose).toHaveAttribute('aria-describedby', 'glucose-error')
  await expect(page.locator('#glucose-error')).toBeVisible()
  if (process.env.DIARY_ACCEPTANCE_DIR) await page.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/field-error-${testInfo.project.name}.png`, fullPage: true })
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('Полный черновик')
  const day = testInfo.project.name === 'phone' ? '2028-02-02' : '2028-02-01'
  await page.getByLabel('Время события — Москва').fill(`${day}T12:00`)
  await glucose.fill('5.6')
  await page.route(`**/api/day?day=${day}`, route => route.abort())
  await page.getByRole('button', { name: 'Сохранить запись', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Запись сохранена, но обновление не удалось' })).toBeVisible()
  await expect(page.getByText('Результат запроса неизвестен.', { exact: false })).toBeHidden()
  await page.unroute(`**/api/day?day=${day}`)
  await page.getByRole('button', { name: 'Повторить сохранение', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Запись сохранена.' })).toBeVisible()
  await expect(page.locator('.entries > .entry')).toHaveCount(1)
})

test('full history remains readable at phone, tablet and desktop widths and stale responses cannot replace a day', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const day = testInfo.project.name === 'phone' ? '2028-04-02' : '2028-04-01'
  await expect(page.getByLabel('Сахар, ммоль/л')).toBeVisible()
  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).csrf_token
  const longComment = 'Полный комментарий без обрезания. '.repeat(35)
  for (let index = 0; index < 25; index++) {
    const response = await page.request.post('/api/entries', {
      headers: { Origin: 'https://localhost:5173', 'X-CSRF-Token': csrf },
      data: { operation_id: crypto.randomUUID(), occurred_at: `${day}T12:00:00.000+03:00`, glucose: '5.6', bolus: '1.2', reason: 'food', comment: index === 0 ? longComment : `Запись ${index}` },
    })
    expect(response.ok(), await response.text()).toBe(true)
  }
  const expected = (await (await page.request.get(`/api/day?day=${day}`)).json()).entries.map((row: { comment: string }) => row.comment)
  await page.getByLabel('День — Москва').fill(day)
  await expect(page.locator('.entries > .entry')).toHaveCount(25)
  await expect(page.locator('.entries > .entry .comment')).toHaveText(expected)
  for (const width of [375, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    const form = await page.getByRole('region', { name: 'Ввод записи', exact: true }).boundingBox()
    const timeline = await page.getByRole('region', { name: 'Хронология дня', exact: true }).boundingBox()
    expect(form).not.toBeNull(); expect(timeline).not.toBeNull()
    if (width >= 1280) expect(form!.x + form!.width).toBeLessThan(timeline!.x)
    else expect(form!.y + form!.height).toBeLessThan(timeline!.y)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.locator('.diary-layout button, .diary-layout input, .diary-layout select, .diary-layout textarea').evaluateAll(elements => elements.filter(element => element.getClientRects().length).every(element => element.getBoundingClientRect().height >= 44))).toBe(true)
    if (width === 375) {
      await page.getByLabel('Комментарий', { exact: true }).focus()
      await page.keyboard.press('Tab')
      const save = page.getByRole('button', { name: 'Сохранить запись', exact: true })
      await expect(save).toBeFocused()
      const saveBounds = await save.boundingBox()
      const navBounds = await page.getByRole('navigation', { name: 'Разделы', exact: true }).boundingBox()
      expect(saveBounds!.y + saveBounds!.height).toBeLessThanOrEqual(navBounds!.y)
    }

    if (process.env.DIARY_ACCEPTANCE_DIR && testInfo.project.name === 'desktop') {
      await page.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/diary-${width}.png`, fullPage: width === 390 })
    }
  }
  await page.setViewportSize({ width: 375, height: 1000 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.evaluate(() => { document.documentElement.style.fontSize = '' })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/day?day=2028-05-01', async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }) })
  await page.getByLabel('День — Москва').fill('2028-05-01')
  await page.getByLabel('День — Москва').fill(day)
  await expect(page.locator('.entries > .entry')).toHaveCount(25)
  release()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(page.locator('.entries > .entry')).toHaveCount(25)
  await expect(page.getByLabel('День — Москва')).toHaveValue(day)
})


test('late Today response cannot replace a newer calendar choice', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByLabel('Время события — Москва')).not.toHaveValue('')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/entry-form', async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }) })
  await page.getByRole('button', { name: 'Сегодня', exact: true }).click()
  await page.getByLabel('День — Москва').fill('2029-01-01')
  release()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(page.getByRole('button', { name: 'Сегодня', exact: true })).toBeVisible()
  await expect(page.getByLabel('День — Москва')).toHaveValue('2029-01-01')
})

test('empty entry validation is attached to the entry fields without requiring sugar', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('button', { name: 'Сохранить запись', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Данные записи', exact: true })).toHaveAttribute('aria-describedby', 'entry-fields-error')
  await expect(page.locator('#entry-fields-error')).toContainText('Укажите сахар')
  await expect(page.getByLabel('Сахар, ммоль/л')).toHaveValue('')
  await page.getByLabel('Комментарий', { exact: true }).fill('Комментарий достаточен')
  await page.getByRole('button', { name: 'Сохранить запись', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Запись сохранена.' })).toBeVisible()
})
