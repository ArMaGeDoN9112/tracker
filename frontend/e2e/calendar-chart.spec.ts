import { test, expect } from '@playwright/test'

test.use({ timezoneId: 'America/Los_Angeles' })

test('calendar combines all seven metrics, filters lines and tooltips, and preserves basal gaps', async ({ page }, info) => {
  const day = '2026-10-20'
  const total = (value: string | null, incomplete = false) => ({ value, incomplete, known_count: value === null ? 0 : 1, unknown_count: incomplete || value === null ? 1 : 0 })
  const totals = { calories: total('350', true), protein: total('15'), fat: total(null, true), carbohydrate: total('40') }
  await page.route('**/api/nutrition-day?*', route => route.fulfill({ json: {
    day, totals, meals: [1, 2].map(index => ({ id: `meal-${index}`, occurred_at: `${day}T12:00:00+03:00`, totals })), water_total_ml: 750, water: [],
  } }))
  await page.route('**/api/day?*', route => route.fulfill({ json: {
    basal: '0.50', temporary_percent: null, temporary_basals: [],
    basal_changes: [{ occurred_at: `${day}T06:00:00+03:00`, basal: null }, { occurred_at: `${day}T12:00:00+03:00`, basal: '0.00' }, { occurred_at: `${day}T18:00:00+03:00`, basal: '1.80' }],
    entries: [{ id: 'entry-1', occurred_at: `${day}T12:00:00+03:00`, glucose: '5.6', bolus: '1.2' }, { id: 'entry-2', occurred_at: `${day}T12:00:00+03:00`, glucose: null, bolus: '0.0' }],
  } }))
  await page.goto(`/?section=calendar&day=${day}`)
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const chart = page.getByRole('region', { name: 'Общий график дня', exact: true })
  const plot = chart.getByRole('slider', { name: 'Показатели дня по времени' })
  const tip = chart.getByRole('tooltip', { name: 'Показатели дня' })
  await expect(plot).toBeVisible()
  await expect(chart.locator('.recharts-wrapper')).toHaveCount(1)
  await expect(chart.getByRole('checkbox')).toHaveCount(7)
  for (const option of await chart.getByRole('checkbox').all()) await expect(option).toBeChecked()
  const colors = await chart.locator('.calendar-chart-options svg > *').evaluateAll(marks => marks.map(mark => getComputedStyle(mark)[mark.tagName === 'rect' ? 'fill' : 'stroke']))
  expect(colors).not.toContain('none')
  expect(new Set(colors).size).toBe(7)
  await expect(plot.locator('.recharts-line')).toHaveCount(2)
  await expect(plot.locator('.recharts-bar')).toHaveCount(5)
  await expect(plot.locator('.recharts-line-curve')).toHaveCount(1)
  expect(await plot.locator('.recharts-bar-rectangle').count()).toBeGreaterThan(0)
  await expect(chart.getByRole('list', { name: 'Шкалы показателей' })).toContainText('Калории: 0–350 ккал')
  await expect(chart.getByRole('list', { name: 'Шкалы показателей' })).toContainText('Сахар: 0–30 ммоль/л')
  await expect(chart.getByRole('list', { name: 'Шкалы показателей' })).toContainText('Подколки: 0–1.2 ед.')
  if (process.env.DIARY_ACCEPTANCE_DIR) await chart.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/calendar-overview-${info.project.name}.png` })
  await plot.focus()
  await expect(tip).toContainText('00:00–06:00 · 0,50 ед/ч')
  await plot.press('ArrowRight')
  await expect(tip).toContainText('06:00–12:00 · неизвестна')
  await plot.press('ArrowRight')
  for (const value of ['350 ккал', 'Неполные данные', 'Неизвестно', 'Приём 1', 'Приём 2', '15 г', '40 г', '5,6 ммоль/л', 'Сахар не указан', '1,2 ед.', '0,0 ед.', '12:00–18:00 · 0,00 ед/ч']) await expect(tip).toContainText(value)
  await plot.press('ArrowRight')
  await expect(tip).toContainText('18:00–24:00 · 1,80 ед/ч')
  await plot.press('Escape')
  await expect(tip).toHaveCount(0)
  await plot.scrollIntoViewIfNeeded()
  const bounds = (await plot.boundingBox())!
  const x = bounds.x + bounds.width / 2, y = bounds.y + 160
  if (info.project.name === 'phone') await page.touchscreen.tap(x, y)
  else await page.mouse.move(x, y)
  await expect(tip).toContainText('5,6 ммоль/л')
  const floating = chart.locator('.day-chart-tooltip')
  await expect(floating).toHaveCSS('position', 'fixed')
  await expect(floating).toHaveCSS('pointer-events', 'auto')
  if (info.project.name === 'desktop') {
    await floating.hover()
    await expect(tip).toBeVisible()
    await page.mouse.wheel(0, 500)
    await expect(tip).toBeVisible()
    await plot.press('Escape')
    await expect(tip).toHaveCount(0)
    await page.mouse.move(x, y)
    await expect(tip).toBeVisible()
  }
  if (process.env.DIARY_ACCEPTANCE_DIR) await page.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/calendar-combined-${info.project.name}.png` })
  await chart.getByRole('checkbox', { name: 'Калории', exact: true }).uncheck()
  await expect(plot.locator('.recharts-bar')).toHaveCount(4)
  await plot.focus()
  await plot.press('Home')
  await plot.press('ArrowRight')
  await plot.press('ArrowRight')
  await expect(tip).not.toContainText('Калории')
  await expect(tip).toContainText('Сахар')
  for (const option of await chart.getByRole('checkbox').all()) await option.uncheck()
  await expect(chart.getByRole('slider')).toHaveCount(0)
  await expect(chart.getByRole('status')).toHaveText('Выберите хотя бы один показатель.')
  await chart.getByRole('checkbox', { name: 'База', exact: true }).check()
  await expect(plot.locator('.recharts-line')).toHaveCount(1)
  await plot.focus()
  await plot.press('Home')
  await plot.press('ArrowRight')
  await expect(tip).toContainText('неизвестна')
  await expect(tip).not.toContainText('Калории')
  // The unknown interval splits the basal path into two independent sections.
  expect((await plot.locator('.recharts-line-curve').getAttribute('d'))!.match(/M/g)!.length).toBe(2)
  const area = await plot.locator('clipPath rect').first().evaluate(rect => ({ y: Number(rect.getAttribute('y')), height: Number(rect.getAttribute('height')) }))
  const basal = await plot.locator('.recharts-line-curve').evaluate(path => {
    const bounds = (path as SVGGraphicsElement).getBBox()
    return { y: bounds.y, height: bounds.height }
  })
  expect(basal.y).toBeGreaterThanOrEqual(area.y + area.height * 2 / 3 - 1)
  expect(basal.height).toBeCloseTo(area.height / 3, 0)
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
})

test('combined calendar keeps repeated Moscow hours as distinct events', async ({ page }) => {
  const day = '2010-10-31'
  await page.route('**/api/day?*', route => route.fulfill({ json: {
    basal: null, basal_changes: [], temporary_basals: [], temporary_percent: null,
    entries: [{ id: 'first', occurred_at: `${day}T02:30:00+04:00`, glucose: '4.2', bolus: '0.0' }, { id: 'second', occurred_at: `${day}T02:30:00+03:00`, glucose: '39.3', bolus: '2.0' }],
  } }))
  await page.goto(`/?section=calendar&day=${day}`)
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const chart = page.getByRole('region', { name: 'Общий график дня', exact: true })
  const plot = chart.getByRole('slider')
  await expect(chart).toContainText('В этот день переводились часы')
  await expect(chart.getByRole('list', { name: 'Шкалы показателей' })).toContainText('Сахар: 0–30 ммоль/л')
  const area = await plot.locator('clipPath rect').first().evaluate(rect => ({ y: Number(rect.getAttribute('y')), height: Number(rect.getAttribute('height')) }))
  const glucoseY = Number(await plot.locator('.recharts-line-dot').first().getAttribute('cy'))
  expect(glucoseY).toBeCloseTo(area.y + area.height * 0.86, 0)
  await plot.focus()
  await plot.press('ArrowRight')
  const tip = chart.getByRole('tooltip')
  await expect(tip).toContainText('02:30')
  await expect(tip).toContainText('4,2 ммоль/л')
  await plot.press('ArrowRight')
  await expect(tip).toContainText('02:30')
  await expect(tip).toContainText('39,3 ммоль/л')
  await expect(tip).toContainText('2,0 ед.')
})
