import { test, expect } from '@playwright/test'
import { openSection } from './navigation'

test('console C keeps the prototype compositions across every working section', async ({ page }, info) => {
  const phone = info.project.name === 'phone'
  const day = phone ? '2094-10-30' : '2094-10-29'
  await page.setViewportSize({ width: phone ? 375 : 1440, height: 1000 })
  await page.route('**/api/backup-status', route => route.fulfill({ json: { last_external_success: '2026-10-29T00:05:00Z', last_local_success: null, last_verification: '2026-10-29T00:15:00Z', verification_error: null, error: null, overdue: false } }))
  const capture = async (name: string) => {
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (process.env.DIARY_ACCEPTANCE_DIR) await page.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/console-${info.project.name}-${name}.png`, fullPage: true })
  }
  await page.goto(`/?section=calendar&day=${day}`)
  await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible()
  const intro = (await page.locator('.login-intro').boundingBox())!
  const login = (await page.locator('.workspace').boundingBox())!
  if (!phone) expect(intro.x + intro.width).toBeLessThan(login.x)
  else expect(intro.y + intro.height).toBeLessThanOrEqual(login.y)
  await capture('login')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible()
  const headers = { Origin: 'https://localhost:5173', 'X-CSRF-Token': (await (await page.request.get('/api/auth/csrf')).json()).csrf_token }
  for (const [path, data] of [
    ['/api/entries', { glucose: '5.6', bolus: '0.1', comment: 'Запись в пульте данных' }],
    ['/api/entries', { glucose: '6.4', bolus: '0.2' }],
    ['/api/meals', { lines: [{ id: crypto.randomUUID(), kind: 'one_off', name: 'Обед', calories: '420', protein: '22', fat: '14', carbohydrate: '48' }] }],
    ['/api/water', { volume_ml: 250 }],
    ['/api/products', { name: `Продукт для пульта ${day}`, unit: 'g', calories: '120', protein: '4', fat: '3', carbohydrate: '18', portions: [] }],
  ] as const) {
    const response = await page.request.post(path, { headers, data: { operation_id: crypto.randomUUID(), ...(path === '/api/products' ? {} : { occurred_at: `${day}T12:00:00+03:00` }), ...data } })
    expect(response.ok(), await response.text()).toBeTruthy()
  }
  await page.reload()
  const metrics = page.locator('.console-metrics')
  await expect(metrics).toContainText('0,3')
  await expect(page.locator('.calendar-records')).toContainText('Запись в пульте данных')
  if (!phone) {
    const left = (await metrics.boundingBox())!
    const chart = (await page.locator('.calendar-summary-chart').boundingBox())!
    const right = (await page.locator('.calendar-right').boundingBox())!
    expect(left.x + left.width).toBeLessThan(chart.x)
    expect(chart.x + chart.width).toBeLessThan(right.x)
  }
  await capture('calendar')
  for (const width of [375, 768, 1440, 1920, 2560, 3840]) {
    await page.setViewportSize({ width, height: 1000 })
    const dayButton = (await page.locator('.calendar-day').first().boundingBox())!
    expect(dayButton.width).toBeGreaterThanOrEqual(44)
    expect(dayButton.height).toBeGreaterThanOrEqual(44)
    const shell = (await page.locator('.app-shell').boundingBox())!
    expect(shell.x).toBe(0)
    expect(shell.width).toBe(await page.evaluate(() => document.documentElement.clientWidth))
    if (width >= 768) {
      expect((await page.locator('.app-sidebar').boundingBox())!.x).toBe(0)
      expect((await page.locator('.main-nav').boundingBox())!.x).toBe(8)
    }
  }
  await page.setViewportSize({ width: phone ? 375 : 1440, height: 1000 })
  await openSection(page, 'Ввод сахара')
  const form = (await page.getByRole('region', { name: 'Ввод записи', exact: true }).boundingBox())!
  const aside = (await page.locator('.input-aside').boundingBox())!
  if (!phone) expect(form.x + form.width).toBeLessThan(aside.x)
  else expect(form.y + form.height).toBeLessThanOrEqual(aside.y)
  await expect(page.getByRole('region', { name: 'Хронология дня', exact: true })).toBeHidden()
  await capture('diabetes-input')
  await openSection(page, 'Аналитика сахара')
  await page.getByLabel('Начало периода — Москва', { exact: true }).fill(day)
  await page.getByLabel('Конец периода — Москва', { exact: true }).fill(day)
  await page.getByRole('button', { name: 'Показать период', exact: true }).click()
  await expect(page.getByTestId('period-average')).toContainText('6,0')
  await expect(page.locator('.entry')).toHaveCount(2)
  if (!phone) await expect(page.locator('.entry-table-heading')).toBeVisible()
  await capture('diabetes-analysis')
  await openSection(page, 'Ввод питания')
  const meal = (await page.getByRole('region', { name: 'Форма приёма пищи', exact: true }).boundingBox())!
  const water = (await page.getByRole('region', { name: 'Учёт воды', exact: true }).boundingBox())!
  if (!phone) expect(meal.x + meal.width).toBeLessThan(water.x)
  else expect(meal.y + meal.height).toBeLessThanOrEqual(water.y)
  await capture('nutrition-input')
  await openSection(page, 'Аналитика питания')
  await page.getByLabel('Начало периода питания — Москва', { exact: true }).fill(day)
  await page.getByLabel('Конец периода питания — Москва', { exact: true }).fill(day)
  await page.getByRole('button', { name: 'Показать период питания', exact: true }).click()
  await expect(page.getByTestId('nutrition-average-calories')).toContainText('420.00')
  await expect(page.getByRole('region', { name: 'День питания', exact: true })).toContainText('Обед')
  const period = (await page.locator('.nutrition-period').boundingBox())!
  const history = (await page.getByRole('region', { name: 'День питания', exact: true }).boundingBox())!
  expect(period.y + period.height).toBeLessThanOrEqual(history.y)
  await capture('nutrition-analysis')
  await openSection(page, 'Каталог')
  await page.getByLabel('Поиск продуктов', { exact: true }).fill(`Продукт для пульта ${day}`)
  await expect(page.locator('.food-card')).toHaveCount(1)
  const product = (await page.locator('.food-card summary').boundingBox())!
  if (!phone) expect(product.width).toBeGreaterThan(product.height * 4)
  await capture('catalog')
  await page.getByRole('button', { name: 'Новый продукт', exact: true }).click()
  await capture('product-editor')
  await openSection(page, 'База')
  await capture('basal-schedule')
  await page.getByRole('link', { name: 'Временная база', exact: true }).click()
  await capture('temporary-basal')
  await openSection(page, 'Настройки')
  await expect(page.getByRole('region', { name: 'Резервное копирование', exact: true })).toBeVisible()
  await capture('settings')
})
