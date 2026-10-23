import { test, expect } from '@playwright/test'

test('old save paused at CSRF cannot resume automatically under a new login', async ({ page, context }) => {
  await page.clock.install()
  await page.goto('/')
  const signIn = async () => {
    await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
    await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
    await page.getByRole('button', { name: 'Войти', exact: true }).click()
  }
  await signIn()
  await page.getByLabel('Комментарий', { exact: true }).fill('Не отправлять после входа')
  let release!: () => void
  let captured!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => { captured = resolve })
  await page.route('**/api/auth/csrf', async route => {
    const response = await route.fetch()
    captured()
    await gate
    await route.fulfill({ response })
  }, { times: 1 })
  await page.getByRole('button', { name: 'Сохранить запись', exact: true }).click()
  await reached
  await context.clearCookies()
  await page.getByLabel('День — Москва', { exact: true }).fill('1900-01-01')
  await expect(page.getByRole('heading', { name: 'Вход в дневник' })).toBeVisible()
  await signIn()
  await expect(page.getByLabel('Комментарий', { exact: true })).toBeVisible()
  let writes = 0
  page.on('request', request => { if (request.url().endsWith('/api/entries') && request.method() === 'POST') writes++ })
  release()
  await expect(page.getByRole('button', { name: 'Повторить сохранение', exact: true })).toBeEnabled()
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('Не отправлять после входа')
  expect(writes).toBe(0)
})
