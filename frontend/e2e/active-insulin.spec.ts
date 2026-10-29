import { test, expect } from '@playwright/test'

test.use({ timezoneId: 'America/Los_Angeles' })

test.beforeEach(async ({ page }) => {
  const total = { value: null, incomplete: false, known_count: 0, unknown_count: 0 }
  const totals = { calories: total, protein: total, fat: total, carbohydrate: total }
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/session') return route.fulfill({ status: 401, json: {} })
    const responses: Record<string, unknown> = {
      '/api/auth/csrf': { csrf_token: 'test-token' },
      '/api/auth/login': { login: 'synthetic-owner' },
      '/api/backup-status': { overdue: false, error: null, verification_error: null },
      '/api/entry-form': { local_time: '2026-10-29T12:00' },
      '/api/glucose-summary': { start: '2026-10-23', end: '2026-10-29', count: 0, average: null, days: [] },
      '/api/nutrition-day': { day: '2026-10-29', totals, meals: [], water: [], water_total_ml: null },
      '/api/nutrition-summary': { days: [] },
    }
    return route.fulfill({ json: responses[path] ?? {} })
  })
})

test('analysis shows Fiasp carryover, delivery jumps and an accessible tooltip only in analysis', async ({ page }, info) => {
  const day = '2026-10-29'
  const requests: string[] = []
  await page.route('**/api/day?*', route => {
    const selected = new URL(route.request().url()).searchParams.get('day')!
    requests.push(selected)
    return route.fulfill({ json: {
      basal: '0.50', basal_changes: [], temporary_basals: [], temporary_percent: null,
      entries: selected === '2026-10-28'
        ? [{ id: 'evening', occurred_at: '2026-10-28T23:00:00+03:00', glucose: null, bolus: '2.0', comment: '', reason: null, basal: '0.50' }]
        : [{ id: 'morning', occurred_at: `${day}T01:02:30+03:00`, glucose: '5.6', bolus: '1.5', comment: '', reason: null, basal: '0.50' }],
    } })
  })
  await page.goto(`/?section=charts&day=${day}`)
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const chart = page.getByRole('region', { name: 'Сахар, подколки и активный Фиасп', exact: true })
  const plot = chart.getByRole('slider', { name: 'Сахар и инсулин по времени' })
  const tip = chart.getByRole('tooltip', { name: 'Активный Фиасп', exact: true })
  await expect(plot).toBeVisible()
  expect(requests).toContain('2026-10-28')
  await expect(chart.locator('.recharts-wrapper')).toHaveCount(1)
  await expect(chart.locator('.recharts-line')).toHaveCount(2)
  await expect(chart.locator('.recharts-bar')).toHaveCount(1)
  expect(await chart.locator('.recharts-bar-rectangle path').first().evaluate(path => (path as SVGGraphicsElement).getBBox().width)).toBeCloseTo(8)
  expect(await chart.locator('.recharts-line-curve').evaluateAll(paths => paths.every(path => getComputedStyle(path).stroke !== 'none'))).toBe(true)
  await plot.focus()
  await plot.press('Home')
  await expect(tip).toContainText('00:00')
  await expect(tip).toContainText('1,51 ед.')
  await expect(plot).toHaveAttribute('aria-valuetext', /00:00.*Активный Фиасп 1,51 ед./)
  await plot.press('ArrowRight')
  await expect(chart.getByRole('tooltip', { name: 'Сахар', exact: true })).toContainText('5,6 ммоль/л')
  await expect(chart.getByRole('tooltip', { name: 'Подколки', exact: true })).toContainText('1,5 ед.')
  await expect(tip).toContainText('01:02')
  await plot.press('End')
  await expect(tip).toContainText('24:00')
  await expect(tip).toContainText('0,00 ед.')
  await plot.press('Escape')
  await expect(tip).toHaveCount(0)
  await plot.scrollIntoViewIfNeeded()
  const bounds = (await plot.boundingBox())!
  if (info.project.name === 'phone') await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + 80)
  else await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 80)
  await expect(tip).toBeVisible()
  await plot.press('Escape')
  await chart.screenshot({ path: `test-results/active-insulin-${info.project.name}.png` })
  await page.getByRole('link', { name: 'Календарь', exact: true }).click()
  await expect(plot).toBeHidden()
  await expect(page.getByRole('region', { name: 'Общий график дня', exact: true }).getByRole('checkbox')).toHaveCount(4)
})

test('does not display an underestimated IOB when the preceding day fails to load', async ({ page }) => {
  await page.route('**/api/day?*', route => new URL(route.request().url()).searchParams.get('day') === '2026-10-28'
    ? route.fulfill({ status: 500, json: { message: 'Unavailable' } })
    : route.fulfill({ json: { entries: [], basal: null, basal_changes: [], temporary_basals: [], temporary_percent: null } }))
  await page.goto('/?section=charts&day=2026-10-29')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByText('Не удалось загрузить день. Перезагрузите страницу.', { exact: true })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Сахар и инсулин по времени' })).toBeHidden()
})
