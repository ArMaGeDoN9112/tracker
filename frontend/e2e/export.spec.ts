import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'

test('settings download readable full JSON with a privacy warning', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Экспорт всех данных' })).toHaveCount(0)
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  const settings = page.getByRole('region', { name: 'Настройки' })
  await expect(settings).toContainText('личные сведения')
  await expect(settings).toContainText('мягко удалённые')
  const id = await page.evaluate(async () => {
    const { csrf_token } = await (await fetch('/api/auth/csrf')).json()
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf_token }
    const created = await fetch('/api/entries', { method: 'POST', headers,
      body: JSON.stringify({ operation_id: crypto.randomUUID(), occurred_at: '1970-01-01T00:00:00.123Z', comment: 'Старое 😀\nУдалено', glucose: null }) })
    if (!created.ok) throw new Error('Could not create export fixture')
    const { result_id } = await created.json()
    const deleted = await fetch(`/api/entries/${result_id}/delete`, { method: 'POST', headers,
      body: JSON.stringify({ operation_id: crypto.randomUUID(), expected_revision: 1 }) })
    if (!deleted.ok) throw new Error('Could not delete export fixture')
    return result_id as string
  })
  const downloading = page.waitForEvent('download')
  const link = settings.getByRole('link', { name: 'Экспорт всех данных' })
  await link.focus()
  await page.keyboard.press('Enter')
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/^diabetes-diary-\d+\.json$/)
  expect(await download.failure()).toBeNull()
  const path = await download.path()
  const document = JSON.parse(await readFile(path!, 'utf8'))
  expect(document.schema_version).toBe(1)
  expect(document.timezone).toBe('Europe/Moscow')
  expect(document.entries).toContainEqual(expect.objectContaining({
    id, occurred_at: '1970-01-01T00:00:00.123Z', comment: 'Старое 😀\nУдалено', glucose: null, bolus: '0.0', revision: 2,
    deleted_at: expect.any(String),
  }))
  expect(Object.keys(document.account).sort()).toEqual(['created_at', 'id', 'login'])
})

test('expired export returns to login and requires an explicit retry', async ({ page, context }) => {
  await page.goto('/')
  const login = async () => {
    await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
    await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
    await page.getByRole('button', { name: 'Войти', exact: true }).click()
  }
  await login()
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await context.clearCookies()
  let downloads = 0
  page.on('download', () => downloads++)
  await page.getByRole('link', { name: 'Экспорт всех данных' }).click()
  await expect(page.getByRole('heading', { name: 'Вход в дневник' })).toBeVisible()
  expect(downloads).toBe(0)
  await login()
  await expect(page.getByRole('link', { name: 'Экспорт всех данных' })).toBeVisible()
  expect(downloads).toBe(0)
  const downloading = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Экспорт всех данных' }).click()
  expect(await (await downloading).failure()).toBeNull()
})
