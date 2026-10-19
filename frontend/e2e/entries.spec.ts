import { test, expect, type Page } from '@playwright/test'

async function signIn(page: Page) {
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByLabel('Сахар, ммоль/л')).toBeVisible()
}

test.use({ timezoneId: 'America/Los_Angeles' })

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
  await expect(page.locator('.entries li')).toHaveCount(1)
  await expect(page.locator('.entries')).toContainText('Сахар: 5,6')
  await expect(page.getByLabel('День — Москва')).toHaveValue(day)
  await expect(page.locator('.entries time')).toHaveText('00:00')

  await time.fill(`${day}T01:00`)
  await page.getByLabel('Подколка, ед.', { exact: true }).fill('1,2')
  await page.getByLabel('Причина подколки').selectOption('food')
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.locator('.entries li')).toHaveCount(2)
  await expect(page.locator('.entries')).toContainText('Подколка: 1,2')

  await time.fill(`${day}T02:00`)
  await page.getByLabel('Комментарий', { exact: true }).fill('<b>Только комментарий 😀</b>')
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.locator('.entries li')).toHaveCount(3)
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
  await expect(page.locator('.entries li')).toHaveCount(historicalCount + 1)
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
  await expect(page.locator('.entries li')).toHaveCount(1)
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
  await expect(page.locator('.entries li')).toHaveCount(0)
  await page.getByRole('button', { name: /^(Сохранить|Повторить сохранение)$/ }).click()
  await expect(page.locator('.entries li')).toHaveCount(1)
})
