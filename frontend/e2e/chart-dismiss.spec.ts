import { test, expect } from '@playwright/test'

for (const kind of ['calendar', 'diabetes', 'nutrition', 'basal', 'summary']) {
  test(`${kind}: mobile tooltip closes outside the chart and on scroll without reloading`, async ({ page }, info) => {
    test.skip(info.project.name !== 'phone', 'Touch regression')
    const day = '2089-02-12'
    const total = { value: '40.00', incomplete: false, known_count: 1, unknown_count: 0 }
    const totals = { calories: total, protein: total, fat: total, carbohydrate: total }
    await page.route('**/api/day?*', route => route.fulfill({ json: {
      basal: '0.50', basal_changes: [], temporary_basals: [], temporary_percent: null,
      entries: [{ id: 'entry', occurred_at: `${day}T12:00:00+03:00`, glucose: '5.6', bolus: '1.2', comment: '', reason: null, basal: '0.50' }],
    } }))
    await page.route('**/api/nutrition-day?*', route => route.fulfill({ json: {
      day, totals, water_total_ml: null, water: [], meals: [{ id: 'meal', occurred_at: `${day}T12:00:00+03:00`, totals, revision: 1, deleted_at: null,
        lines: [{ id: 'line', kind: 'one_off', name: 'Гречка', quantity: null, basis_quantity: null, unit: null, portion: null, ...Object.fromEntries(Object.keys(totals).map(key => [key, '40.00'])), totals: Object.fromEntries(Object.keys(totals).map(key => [key, '40.00'])) }],
      }],
    } }))
    await page.route('**/api/glucose-summary?*', route => route.fulfill({ json: {
      start: day, end: day, count: 1, average: '5.6', days: [{ day, count: 1, average: '5.6', minimum: '5.6', maximum: '5.6' }],
    } }))
    await page.goto(`/?section=${kind === 'calendar' ? 'calendar' : kind === 'nutrition' ? 'nutrition-summary' : 'charts'}&day=${day}`)
    await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
    await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
    await page.getByRole('button', { name: 'Войти', exact: true }).click()
    if (kind === 'basal') await page.getByText('График базы за день', { exact: true }).click()
    const plot = kind === 'calendar' ? page.getByRole('slider', { name: 'Показатели дня по времени' })
      : kind === 'diabetes' ? page.getByRole('slider', { name: 'Сахар и инсулин по времени' })
        : kind === 'nutrition' ? page.getByRole('slider', { name: 'Калории по времени' })
          : kind === 'basal' ? page.locator('.basal-hit').first() : page.locator('.glucose-plot')
    const tapX = kind === 'summary' ? 80 : 40
    const tooltip = page.locator(kind === 'basal' ? '.basal-tooltip' : kind === 'summary' ? '.recharts-tooltip-wrapper' : '.day-chart-tooltip').filter({ visible: true })
    async function select() {
      if (kind !== 'summary') return plot.tap({ position: { x: tapX, y: 40 } })
      await plot.tap({ position: { x: tapX, y: 80 } })
      const bounds = (await plot.boundingBox())!
      const session = await page.context().newCDPSession(page)
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + tapX, y: bounds.y + 80 }] })
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bounds.x + tapX + 2, y: bounds.y + 80 }] })
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await session.detach()
    }
    await select()
    await expect(tooltip).toBeVisible()
    if (kind === 'calendar') {
      await tooltip.tap()
      await expect(tooltip).toBeVisible()
    }
    await page.getByRole('heading', { level: 1 }).tap()
    await expect(tooltip).toHaveCount(0)
    await select()
    await expect(tooltip).toBeVisible()
    const bounds = (await plot.boundingBox())!
    const session = await page.context().newCDPSession(page)
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + tapX, y: bounds.y + 40 }] })
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bounds.x + tapX, y: bounds.y + 140 }] })
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await session.detach()
    await expect(tooltip).toHaveCount(0)
    await select()
    await expect(tooltip).toBeVisible()
    await plot.dispatchEvent('pointercancel', { pointerType: 'touch' })
    await expect(tooltip).toHaveCount(0)
  })
}
