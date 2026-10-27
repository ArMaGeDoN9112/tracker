import { openSection } from './navigation'
import { test, expect } from '@playwright/test'

test('every screen keeps readable cards, unknown values and usable controls at all widths', async ({ page }, info) => {
  const day = info.project.name === 'phone' ? '2091-04-17' : '2090-04-17'
  await page.goto(`/?section=diary&day=${day}`)
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByLabel('Время события — Москва')).not.toHaveValue('')
  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).csrf_token
  const headers = { Origin: 'https://localhost:5173', 'X-CSRF-Token': csrf }
  const name = `Овсянка с ягодами ${crypto.randomUUID()}`
  for (const [path, data] of [
    ['/api/products', { name, unit: 'g', calories: '120', protein: '4', fat: null, carbohydrate: '22', portions: [] }],
    ['/api/meals', { occurred_at: `${day}T09:00:00+03:00`, category: 'breakfast', lines: [{ id: crypto.randomUUID(), kind: 'one_off', name: 'Овсянка с ягодами', quantity: '250', unit: 'g', calories: '300', protein: '10', fat: null, carbohydrate: '55' }] }],
    ['/api/entries', { occurred_at: `${day}T09:00:00+03:00`, glucose: '5.6', bolus: '1.2', reason: 'food', comment: 'После завтрака' }],
    ['/api/water', { occurred_at: `${day}T09:00:00+03:00`, volume_ml: 250 }],
    ['/api/water', { occurred_at: `${day}T13:00:00+03:00`, volume_ml: 500 }],
    ['/api/basal-schedules', { starts_at: `${day}T06:00:00+03:00`, intervals: [{ minute: 0, rate: '0.5' }, { minute: 360, rate: '0.8' }] }],
    ['/api/temporary-basals', { starts_at: `${day}T12:00:00+03:00`, duration_minutes: 60, percent: 133 }],
  ] as const) {
    const response = await page.request.post(path, { headers, data: { operation_id: crypto.randomUUID(), ...data } })
    expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy()
  }
  await page.reload()
  for (const section of ['Ввод сахара', 'Ввод питания', 'Аналитика сахара', 'Аналитика питания', 'Каталог', 'База', 'Настройки']) {
    await openSection(page, section)
    if (section === 'Ввод сахара') await expect(page.getByRole('region', { name: 'Хронология дня' })).toBeHidden()
    if (section === 'Ввод питания') await expect(page.getByRole('region', { name: 'День питания', exact: true })).toBeHidden()
    if (section === 'Аналитика питания') {
      const history = page.getByRole('region', { name: 'День питания', exact: true })
      await expect(history.locator('.metric-grid').first()).toContainText('300.00 ккал')
      await expect(history.locator('.metric-grid').first()).toContainText('Неизвестно')
      await expect(history).not.toContainText('Известных строк')
      await expect(history.getByText('Основа:', { exact: false })).toBeHidden()
      await expect(page.getByLabel('История воды').locator('.water-record')).toHaveCount(2)
    }
    if (section === 'Аналитика сахара') {
      await expect(page.locator('.entry-glucose strong')).toContainText('5,6')
      await page.getByText('График базы за день', { exact: true }).click()
      await expect(page.getByRole('group', { name: 'График базы с 00 до 24 часов, Москва' })).toBeVisible()
      await page.getByLabel('Начало периода — Москва', { exact: true }).fill(day)
      await page.getByLabel('Конец периода — Москва', { exact: true }).fill(day)
      await page.getByRole('button', { name: 'Показать период', exact: true }).click()
      await expect(page.getByTestId('period-average')).toContainText('5,6')
    }
    if (section === 'Аналитика питания') {
      await page.getByLabel('Начало периода питания — Москва').fill(day)
      await page.getByLabel('Конец периода питания — Москва').fill(day)
      await page.getByRole('button', { name: 'Показать период питания' }).click()
      await expect(page.getByTestId('nutrition-average-calories')).toContainText('300.00 ккал')
    }
    if (section === 'Каталог') {
      await page.getByLabel('Поиск продуктов').fill(name)
      const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) })
      await expect(card.locator('.food-energy')).toContainText('120.00 ккал')
      await card.locator('summary').click()
      await expect(card.locator('.product-nutrients')).toContainText('неизвестно')
    }
    if (section === 'База') {
      await page.getByLabel('История расписаний').locator('article').filter({ has: page.locator(`time[datetime^="${day}"]`) }).locator('summary').click()
      await expect(page.getByRole('button', { name: '00:00–06:00 · 0,50 ед/ч', exact: true })).toBeVisible()
    }
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 1000 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      if (section === 'Ввод питания') {
        const form = await page.getByRole('region', { name: 'Форма приёма пищи', exact: true }).boundingBox()
        expect(form).not.toBeNull()
        await expect(page.getByRole('region', { name: 'День питания', exact: true })).toBeHidden()
      }
      if (process.env.DIARY_ACCEPTANCE_DIR) await page.locator('.workspace').screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/${info.project.name}-${section}-${width}.png` })
    }
  }
  await openSection(page, 'База')
  await page.getByRole('link', { name: 'Временная база', exact: true }).click()
  await expect(page.getByLabel('История временной базы').locator('article').filter({ has: page.locator(`time[datetime^="${day}"]`) })).toContainText('133%')
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (process.env.DIARY_ACCEPTANCE_DIR) await page.locator('.workspace').screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/${info.project.name}-Временная база-${width}.png` })
  }
})
