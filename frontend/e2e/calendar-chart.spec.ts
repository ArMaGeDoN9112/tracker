import { test, expect } from '@playwright/test'

test.use({ timezoneId: 'America/Los_Angeles' })

test('calendar aligns event icons, filters metrics and tooltips, and preserves basal gaps', async ({ page }, info) => {
  const day = '2026-10-20'
  const total = (value: string | null, incomplete = false) => ({ value, incomplete, known_count: value === null ? 0 : 1, unknown_count: incomplete || value === null ? 1 : 0 })
  const totals = { calories: total('350', true), protein: total('15'), fat: total(null, true), carbohydrate: total('40') }
  await page.route('**/api/nutrition-day?*', route => route.fulfill({ json: {
    day, totals, meals: [1, 2].map(index => ({ id: `meal-${index}`, occurred_at: `${day}T12:00:00+03:00`, totals, lines: [{ id: `line-${index}`, name: index === 1 ? 'Гречка, курица' : 'Чай', quantity: '150', unit: 'g' }] })), water_total_ml: 750, water: [],
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
  await expect(chart.getByRole('checkbox')).toHaveCount(5)
  for (const option of await chart.getByRole('checkbox').all()) await expect(option).toBeChecked()
  const colors = await chart.locator('.calendar-chart-options svg > :is(circle, rect, line, path)').evaluateAll(marks => marks.map(mark => getComputedStyle(mark)[['line', 'path'].includes(mark.tagName) ? 'stroke' : 'fill']))
  expect(colors).not.toContain('none')
  expect(new Set(colors).size).toBe(5)
  await expect(plot.locator('.recharts-line')).toHaveCount(2)
  await expect(plot.locator('.recharts-bar')).toHaveCount(1)
  await expect(plot.locator('.recharts-line-curve')).toHaveCount(1)
  expect(await plot.locator('.recharts-bar-rectangle').count()).toBeGreaterThan(0)
  const events = chart.getByRole('list', { name: 'События дня по времени' })
  const cards = events.getByRole('button', { name: /Еда:/ })
  await expect(cards).toHaveCount(2)
  await expect(cards.first()).toHaveAccessibleName('12:00 · Еда: Гречка, курица')
  await expect(cards.first().locator('svg title')).toHaveText('Крупы и паста')
  await expect(events.getByRole('button', { name: /Подколка:/ })).toHaveCount(1)
  await cards.first().focus()
  await expect(tip).toContainText('Гречка, курица · 150 г')
  await expect(plot.locator('.recharts-reference-line')).toHaveCount(1)
  await cards.first().press('Escape')
  await expect(tip).toHaveCount(0)
  await expect(chart.getByRole('list', { name: 'Шкалы показателей' })).toContainText('Сахар: 0–30 ммоль/л')
  await expect(chart.getByRole('list', { name: 'Шкалы показателей' })).toContainText('Подколки: 0–1.2 ед.')
  if (process.env.DIARY_ACCEPTANCE_DIR) await chart.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/calendar-overview-${info.project.name}.png` })
  await plot.focus()
  await plot.press('Home')
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
  await chart.getByRole('checkbox', { name: 'Еда', exact: true }).uncheck()
  await expect(cards).toHaveCount(0)
  await expect(events.getByRole('button', { name: /Подколка:/ })).toHaveCount(1)
  await expect(plot.locator('.recharts-bar')).toHaveCount(1)
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
    await chart.getByRole('checkbox', { name: 'Еда', exact: true }).check()
    await expect.poll(async () => {
      const a = (await cards.first().boundingBox())!, b = (await cards.last().boundingBox())!
      return a.y + a.height <= b.y || b.y + b.height <= a.y || a.x + a.width <= b.x || b.x + b.width <= a.x
    }).toBe(true)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await cards.first().click()
  await expect(tip).toContainText('Гречка, курица · 150 г')
  if (process.env.DIARY_ACCEPTANCE_DIR) await chart.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/calendar-meal-cards-${info.project.name}.png` })
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

test('meal timeline keeps day edges, unknown carbs and food-only selection', async ({ page }, info) => {
  const day = '2089-01-12'
  const lunchFoods = ['Гречка с овощами и грибами', 'Куриная грудка', 'Салат из свежих овощей', 'Цельнозерновой хлеб', 'Чай без сахара']
  const total = (value: string | null, incomplete = false) => ({ value, incomplete, known_count: value === null ? 0 : 1, unknown_count: incomplete || value === null ? 1 : 0 })
  const totals = { calories: total('350'), protein: total('15'), fat: total('10'), carbohydrate: total('40') }
  await page.route('**/api/nutrition-day?*', route => route.fulfill({ json: {
    day, totals, water_total_ml: null, water: [],
    meals: ['00:00:00.000', '08:00:00.000', '12:30:00.000', '12:31:00.000', '23:59:59.999'].map((time, index) => ({
      id: `meal-${index}`, occurred_at: `${day}T${time}+03:00`,
      totals: { ...totals, carbohydrate: index === 0 ? total('0') : index === 4 ? total(null, true) : total('40', index === 3) },
      lines: (index === 2 ? lunchFoods : [['Чай', 'Омлет, хлеб', '', 'Яблоко', 'Кефир'][index]]).map((name, line) => ({ id: `line-${index}-${line}`, name, quantity: '150', unit: 'g' })),
    })),
  } }))
  await page.route('**/api/day?*', route => route.fulfill({ json: { basal: null, basal_changes: [], temporary_basals: [], temporary_percent: null, entries: [] } }))
  await page.goto(`/?section=calendar&day=${day}`)
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const chart = page.getByRole('region', { name: 'Общий график дня', exact: true })
  const track = chart.getByRole('list', { name: 'События дня по времени' })
  const cards = track.getByRole('button')
  await expect(cards).toHaveCount(5)
  await expect(cards.first()).toHaveAccessibleName('00:00 · Еда: Чай')
  await expect(cards.last()).toHaveAccessibleName('23:59 · Еда: Кефир')
  await expect(cards.nth(2).locator('svg')).toHaveCount(3)
  await expect(cards.nth(2).locator('svg title')).toHaveText(['Крупы и паста', 'Мясо', 'Овощи'])
  await expect(cards.nth(1).locator('svg title')).toHaveText('Яйца')
  await expect(cards.nth(2)).toContainText('+2')
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(cards.nth(2)).toHaveAccessibleName(`12:30 · Еда: ${lunchFoods.join(', ')}`)
    await expect.poll(async () => {
      const bounds = (await track.boundingBox())!
      const boxes = await cards.evaluateAll(elements => elements.map(element => {
        const { x, y, width, height } = element.getBoundingClientRect()
        return { x, y, width, height }
      }))
      return boxes.every((a, index) => a.width > 0 && a.x >= bounds.x - 1 && a.x + a.width <= bounds.x + bounds.width + 1 && boxes.slice(index + 1).every(b => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y))
    }).toBe(true)
  }
  for (const name of ['Сахар', 'Подколки', 'База']) await chart.getByRole('checkbox', { name, exact: true }).uncheck()
  await cards.nth(2).click()
  for (const food of lunchFoods) await expect(chart.getByRole('tooltip')).toContainText(food)
  await cards.last().click()
  const tip = chart.getByRole('tooltip')
  await expect(tip).toContainText('Углеводы: Неизвестно · Неполные данные')
  await expect(chart.locator('.recharts-reference-line')).toHaveCount(1)
  await cards.last().press('Escape')
  await expect(tip).toHaveCount(0)
  await chart.getByRole('checkbox', { name: 'Сахар', exact: true }).check()
  await chart.getByRole('checkbox', { name: 'Сахар', exact: true }).blur()
  if (info.project.name === 'phone') await page.setViewportSize({ width: 390, height: 844 })
  if (process.env.DIARY_ACCEPTANCE_DIR) await chart.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/calendar-meals-day-${info.project.name}.png` })
})

test('event timeline groups foods, shows water and boluses, and does not snap to basal changes', async ({ page }, info) => {
  const day = '2089-03-12'
  const occurred_at = `${day}T16:01:00+03:00`
  const total = { value: '40', incomplete: false, known_count: 1, unknown_count: 0 }
  const totals = { calories: total, protein: total, fat: total, carbohydrate: total }
  await page.route('**/api/nutrition-day?*', route => route.fulfill({ json: {
    day, totals, water_total_ml: 750,
    water: [{ id: 'water-1', occurred_at, volume_ml: 250 }, { id: 'water-2', occurred_at, volume_ml: 500 }],
    meals: [{ id: 'meal', occurred_at, totals, lines: ['Гречка', 'Куриная грудка', 'Авторское блюдо', 'Чай'].map((name, index) => ({ id: `line-${index}`, name, quantity: '150', unit: 'g' })) }],
  } }))
  await page.route('**/api/day?*', route => route.fulfill({ json: {
    basal: '0.50', temporary_percent: null, temporary_basals: [],
    basal_changes: [{ occurred_at: `${day}T16:00:00+03:00`, basal: '0.60' }, { occurred_at: `${day}T20:00:00+03:00`, basal: '0.70' }],
    entries: [{ id: 'bolus', occurred_at, glucose: '5.6', bolus: '1.2' }, { id: 'zero', occurred_at, glucose: null, bolus: '0.0' }],
  } }))
  await page.goto(`/?section=calendar&day=${day}`)
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const chart = page.getByRole('region', { name: 'Общий график дня', exact: true })
  const track = chart.getByRole('list', { name: 'События дня по времени' })
  const meal = track.getByRole('button', { name: /Еда:/ })
  const water = track.getByRole('button', { name: /Вода:/ })
  const bolus = track.getByRole('button', { name: /Подколка:/ })
  const tip = chart.getByRole('tooltip')
  await expect(track.getByRole('button')).toHaveCount(4)
  await expect(meal.locator('svg title')).toHaveText(['Крупы и паста', 'Мясо', 'Еда'])
  await expect(meal).toContainText('+1')
  await expect(water).toHaveCount(2)
  await expect(water.first().locator('svg title')).toHaveText('Вода')
  await expect(bolus).toHaveAccessibleName('16:01 · Подколка: 1,2 ед.')
  await water.first().click()
  for (const value of ['16:01', '250 мл', '500 мл', 'Авторское блюдо', '1,2 ед.']) await expect(tip).toContainText(value)
  await water.first().press('Escape')
  await expect(tip).toHaveCount(0)
  await meal.focus()
  await expect(tip).toContainText('Гречка · 150 г')
  await meal.press('Escape')
  const plot = chart.getByRole('slider')
  await plot.scrollIntoViewIfNeeded()
  const bounds = (await plot.boundingBox())!
  async function selectMinute(minute: number) {
    const x = bounds.x + 16 + (bounds.width - 32) * minute / 1440, y = bounds.y + 80
    if (info.project.name === 'phone') await page.touchscreen.tap(x, y)
    else await page.mouse.move(x, y)
  }
  await selectMinute(16 * 60)
  await expect(tip).toContainText('16:01')
  await expect(tip).toContainText('Гречка · 150 г')
  await expect(tip).toContainText('16:00–20:00 · 0,60 ед/ч')
  await page.keyboard.press('Escape')
  await selectMinute(19 * 60 + 50)
  const selectedTime = Number(await plot.getAttribute('aria-valuenow'))
  expect(selectedTime).toBeLessThan(Date.parse(`${day}T20:00:00+03:00`))
  expect(Math.abs(selectedTime - Date.parse(`${day}T19:50:00+03:00`))).toBeLessThan(86400000 / (bounds.width - 32) + 1)
  await expect(tip).not.toContainText('Гречка')
  await chart.getByRole('checkbox', { name: 'Вода', exact: true }).uncheck()
  await expect(water).toHaveCount(0)
  await meal.click()
  await expect(tip).not.toContainText('мл')
  await chart.getByRole('checkbox', { name: 'Подколки', exact: true }).uncheck()
  await expect(bolus).toHaveCount(0)
  await meal.click()
  await expect(tip).not.toContainText('Подколки')
  await chart.getByRole('checkbox', { name: 'Вода', exact: true }).check()
  await chart.getByRole('checkbox', { name: 'Подколки', exact: true }).check()
  await meal.press('Escape')
  if (process.env.DIARY_ACCEPTANCE_DIR) await chart.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/calendar-events-${info.project.name}.png` })
})
