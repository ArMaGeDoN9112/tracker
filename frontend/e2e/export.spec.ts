import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'

test('settings download readable full JSON with a privacy warning', async ({ page }) => {
  await page.goto('/?section=diary')
  await expect(page.getByRole('link', { name: 'Экспорт всех данных' })).toHaveCount(0)
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  const settings = page.getByRole('region', { name: 'Настройки' })
  await expect(settings).toContainText('личные сведения')
  await expect(settings).toContainText('мягко удалённые')
  const ids = await page.evaluate(async () => {
    const { csrf_token } = await (await fetch('/api/auth/csrf')).json()
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf_token }
    const created = await fetch('/api/entries', { method: 'POST', headers,
      body: JSON.stringify({ operation_id: crypto.randomUUID(), occurred_at: '1970-01-01T00:00:00.123Z', comment: 'Старое 😀\nУдалено', glucose: null }) })
    if (!created.ok) throw new Error('Could not create export fixture')
    const { result_id } = await created.json()
    const deleted = await fetch(`/api/entries/${result_id}/delete`, { method: 'POST', headers,
      body: JSON.stringify({ operation_id: crypto.randomUUID(), expected_revision: 1 }) })
    if (!deleted.ok) throw new Error('Could not delete export fixture')
    const send = async (path: string, data: object, method = 'POST') => {
      const response = await fetch(path, { method, headers, body: JSON.stringify({ operation_id: crypto.randomUUID(), ...data }) })
      if (!response.ok) throw new Error('Could not prepare nutrition export fixture')
      return response.json()
    }
    const portion = { id: crypto.randomUUID(), name: 'Ломтик', quantity: '30' }
    const card = { name: 'Историческая карточка', unit: 'g', protein: '10', fat: '5', carbohydrate: '20', calories: '180', portions: [portion] }
    const product = await send('/api/products', card)
    const meal = await send('/api/meals', { occurred_at: '1970-01-01T00:00:00.123Z', lines: [
      { id: crypto.randomUUID(), kind: 'product', ...card, quantity: '30', basis_quantity: '100',
        product_id: product.result_id, product_revision: 1, portion, portions: undefined },
      { id: crypto.randomUUID(), kind: 'one_off', name: 'Без веса', protein: '0' },
    ] })
    await send(`/api/meals/${meal.result_id}/delete`, { expected_revision: 1 })
    await send(`/api/products/${product.result_id}`, { ...card, expected_revision: 1, name: 'Новая карточка', protein: '99', portions: [] }, 'PUT')
    const water = await send('/api/water', { volume_ml: 330, occurred_at: '1970-01-01T00:00:00.123Z' })
    await send(`/api/water/${water.result_id}/delete`, { expected_revision: 1 })
    const settings = await (await fetch('/api/water-settings')).json()
    await send('/api/water-settings', { expected_revision: settings.revision, volumes_ml: [330, 125] }, 'PUT')
    return { entry: result_id as string, product: product.result_id as string, meal: meal.result_id as string, water: water.result_id as string }
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
  expect(document.schema_version).toBe(3)
  expect(document.timezone).toBe('Europe/Moscow')
  expect(document.entries).toContainEqual(expect.objectContaining({
    id: ids.entry, occurred_at: '1970-01-01T00:00:00.123Z', comment: 'Старое 😀\nУдалено', glucose: null, bolus: '0.0', revision: 2,
    deleted_at: expect.any(String),
  }))
  expect(Object.keys(document.account).sort()).toEqual(['created_at', 'id', 'login'])
  expect(document.products).toContainEqual(expect.objectContaining({ id: ids.product, revision: 2, protein: '99.00', portions: [] }))
  const historical = document.meals.find((meal: { id: string }) => meal.id === ids.meal)
  expect(historical).toMatchObject({ revision: 2, deleted_at: expect.any(String), lines: [
    expect.objectContaining({ name: 'Историческая карточка', protein: '10.00', basis_quantity: '100.00', quantity: '30.00',
      product_revision: 1, portion: expect.objectContaining({ quantity: '30.00' }), totals: { protein: '3.00', fat: '1.50', carbohydrate: '6.00', calories: '54.00' } }),
    expect.objectContaining({ name: 'Без веса', quantity: null, basis_quantity: null, protein: '0.00', fat: null }),
  ] })
  expect(document.water).toContainEqual(expect.objectContaining({ id: ids.water, volume_ml: 330, deleted_at: expect.any(String) }))
  expect(document.settings.water.volumes_ml).toEqual([330, 125])
})

test('expired export returns to login and requires an explicit retry', async ({ page, context }) => {
  await page.goto('/?section=diary')
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
