import { test, expect } from '@playwright/test'

test('charts A visual acceptance at five widths', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  await page.goto('/')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByLabel('Сахар, ммоль/л')).toBeVisible()
  await page.evaluate(async () => {
    const { csrf_token } = await (await fetch('/api/auth/csrf')).json()
    for (const [day, glucose] of [['01', '4.0'], ['01', '8.0'], ['03', '12.0']]) {
      const response = await fetch('/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf_token },
        body: JSON.stringify({ operation_id: crypto.randomUUID(), occurred_at: `2009-09-${day}T12:00:00+04:00`, glucose }) })
      if (!response.ok) throw new Error('Could not seed synthetic measurement')
    }
  })
  await page.getByRole('link', { name: 'Графики', exact: true }).click()
  const charts = page.getByRole('region', { name: 'Графики сахара', exact: true })
  await charts.getByLabel('Период', { exact: true }).selectOption('custom')
  await charts.getByLabel('Начало периода — Москва').fill('2009-09-01')
  await charts.getByLabel('Конец периода — Москва').fill('2009-09-03')
  await charts.getByRole('button', { name: 'Показать период' }).click()
  await expect(charts.getByTestId('period-average')).toContainText('8,0 ммоль/л')
  for (const width of [375, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 960 })
    await expect(charts.locator('.recharts-surface').first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const table = charts.getByRole('region', { name: 'Таблица сводок сахара' })
    expect(await table.evaluate(el => getComputedStyle(el).overflowX)).toBe('auto')
    for (const button of await charts.getByRole('button').all()) {
      const bounds = await button.boundingBox()
      expect(bounds?.height).toBeGreaterThanOrEqual(44)
      expect(bounds?.width).toBeGreaterThanOrEqual(44)
    }
    await page.screenshot({ path: `/evidence/charts-${width}.png`, fullPage: true })
  }
  const openDay = charts.getByRole('button', { name: 'Открыть день 2009-09-01' })
  await page.keyboard.press('Tab')
  await openDay.focus()
  expect(await openDay.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none')
  await page.screenshot({ path: '/evidence/focus-1440.png', fullPage: true })
  await page.setViewportSize({ width: 375, height: 960 })
  await page.addStyleTag({ content: 'html { font-size: 200%; }' })
  await page.screenshot({ path: '/evidence/text-200-375.png', fullPage: true })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
