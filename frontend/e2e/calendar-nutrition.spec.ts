import { test, expect } from '@playwright/test'

test.use({ timezoneId: 'America/Los_Angeles' })

test('calendar nutrition shows four series, exact meal times, incomplete values and total water', async ({ page }, info) => {
  const day = info.project.name === 'phone' ? '2087-02-02' : '2087-02-01'
  await page.goto(`/?section=calendar&day=${day}`)
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('heading', { name: `Сводка за ${day}` })).toBeVisible()
  const headers = { Origin: 'https://localhost:5173', 'X-CSRF-Token': (await (await page.request.get('/api/auth/csrf')).json()).csrf_token }
  for (const [time, values] of [
    ['00:00:00.000', { calories: '0', protein: '0', fat: '0', carbohydrate: '0' }],
    ['06:00:00.001', { calories: '100', protein: '10', fat: '2', carbohydrate: '20' }],
    ['06:00:00.002', { protein: '3' }],
    ['12:00:00.000', { calories: '200', protein: '20', fat: '4', carbohydrate: '40' }],
    ['12:00:00.000', { calories: '300', protein: '30', fat: '6', carbohydrate: '60' }],
    ['23:59:59.999', { calories: '400', protein: '40', fat: '8', carbohydrate: '80' }],
  ] as const) {
    const response = await page.request.post('/api/meals', { headers, data: { operation_id: crypto.randomUUID(), occurred_at: `${day}T${time}+03:00`, lines: [{ id: crypto.randomUUID(), kind: 'one_off', name: 'Еда только в анализе', ...values }] } })
    expect(response.ok(), await response.text()).toBeTruthy()
  }
  for (const volume_ml of [250, 500]) {
    expect((await page.request.post('/api/water', { headers, data: { operation_id: crypto.randomUUID(), occurred_at: `${day}T12:00:00+03:00`, volume_ml } })).ok()).toBeTruthy()
  }
  await page.reload()
  const details = page.getByRole('region', { name: 'Подробная сводка дня' })
  const plot = details.getByRole('slider', { name: 'КБЖУ по времени' })
  await expect(plot).toBeVisible()
  await expect(details).not.toContainText('Еда только в анализе')
  await expect(details.locator('.calendar-day-totals')).toContainText('1000.00 ккал')
  await expect(details.locator('.calendar-day-totals')).toContainText('103.00 г')
  await expect(details.locator('.calendar-day-totals')).toContainText('Неполные данные')
  await expect(details).toContainText('750 мл')
  await expect(details.locator('.calendar-water-events, .calendar-meal')).toHaveCount(0)
  const legend = details.getByRole('list', { name: 'Показатели питания' })
  await expect(legend.getByRole('listitem')).toHaveText(['Калории · ккал', 'Белки · г', 'Жиры · г', 'Углеводы · г'])
  await expect(plot.getByText('ккал', { exact: true })).toBeVisible()
  await expect(plot.getByText('г', { exact: true })).toBeVisible()
  const lines = plot.locator('.recharts-line')
  await expect(lines).toHaveCount(4)
  const strokes = []
  for (const line of await lines.all()) {
    const curve = line.locator('.recharts-line-curve')
    await expect(curve).toBeVisible()
    strokes.push(await curve.evaluate(element => getComputedStyle(element).stroke))
  }
  expect(new Set(strokes).size).toBe(4)
  expect(strokes).not.toContain('none')
  const tip = details.getByRole('tooltip', { name: 'Питание' })
  await plot.focus()
  await expect(tip).toContainText('00:00')
  await expect(tip).toContainText('Калории: 0.00 ккал')
  await page.keyboard.press('ArrowRight')
  await expect(tip).toContainText('06:00')
  await expect(tip).toContainText('Калории: 100.00 ккал')
  await page.keyboard.press('ArrowRight')
  await expect(tip).toContainText('06:00')
  await expect(tip).toContainText('Калории: Неизвестно')
  await expect(tip).toContainText('Неполные данные')
  await expect(tip).toContainText('Белки: 3.00 г')
  await page.keyboard.press('ArrowRight')
  await expect(tip).toContainText('Приём 1')
  await expect(tip).toContainText('Приём 2')
  await expect(tip).toContainText('Калории: 200.00 ккал')
  await expect(tip).toContainText('Калории: 300.00 ккал')
  await page.keyboard.press('End')
  await expect(tip).toContainText('23:59')
  await page.keyboard.press('Escape')
  await expect(tip).toHaveCount(0)
  await plot.scrollIntoViewIfNeeded()
  const first = await plot.getByText('00:00', { exact: true }).boundingBox()
  const middle = await plot.getByText('12:00', { exact: true }).boundingBox()
  const area = await plot.boundingBox()
  const x1 = first!.x + first!.width / 2, x2 = middle!.x + middle!.width / 2, y = area!.y + 90
  if (info.project.name === 'phone') {
    const session = await page.context().newCDPSession(page)
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y }] })
    await expect(tip).toContainText('00:00')
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x2, y }] })
    await expect(tip).toContainText('12:00')
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await session.detach()
  } else {
    await page.mouse.move(x1, y)
    await expect(tip).toContainText('00:00')
    await page.mouse.move(x2, y)
    await expect(tip).toContainText('12:00')
  }
  for (const width of [375, 844, 1280]) {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (process.env.DIARY_ACCEPTANCE_DIR) await details.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/06-nutrition-${info.project.name}-${width}.png` })
  }
  await details.getByRole('link', { name: 'Записи питания' }).click()
  await expect(page.getByLabel('День — Москва')).toHaveValue(day)
  await expect(page.getByText('Еда только в анализе', { exact: true })).toHaveCount(6)
})

test('nutrition empty, unknown, partial and historical repeated hours preserve the server meaning', async ({ page }, info) => {
  const day = info.project.name === 'phone' ? '2010-10-31' : '2014-10-26'
  const clock = info.project.name === 'phone' ? '02:30' : '01:30'
  await page.goto(`/?section=calendar&day=${day}`)
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const details = page.getByRole('region', { name: 'Подробная сводка дня' })
  await expect(details).toContainText('Нет записей еды.')
  await expect(details).toContainText('Нет записей воды.')
  await expect(details.getByRole('slider', { name: 'КБЖУ по времени' })).toHaveCount(0)
  const headers = { Origin: 'https://localhost:5173', 'X-CSRF-Token': (await (await page.request.get('/api/auth/csrf')).json()).csrf_token }
  const unknown = { id: crypto.randomUUID(), kind: 'one_off', name: 'Неизвестная еда' }
  for (const [occurred_at, lines] of [
    [new Date(Date.parse(`${day}T00:00:00+04:00`) - 1).toISOString(), [{ ...unknown, calories: '900' }]],
    [`${day}T${clock}:00+04:00`, [unknown]],
    [`${day}T${clock}:00+03:00`, [unknown, { ...unknown, id: crypto.randomUUID(), protein: '5' }]],
    [new Date(Date.parse(`${day}T23:00:00+03:00`) + 3600000).toISOString(), [{ ...unknown, calories: '800' }]],
  ] as const) {
    const response = await page.request.post('/api/meals', { headers, data: { operation_id: crypto.randomUUID(), occurred_at, lines } })
    expect(response.ok(), await response.text()).toBeTruthy()
  }
  await page.reload()
  const plot = details.getByRole('slider', { name: 'КБЖУ по времени' })
  await expect(plot).toBeVisible()
  const totals = details.locator('.calendar-day-totals')
  await expect(totals).toContainText('5.00 г')
  await expect(totals).not.toContainText('ккал')
  await expect(totals).toContainText('Неизвестно')
  await expect(totals).toContainText('Неполные данные')
  await expect(details).toContainText('В этот день переводились часы')
  const tip = details.getByRole('tooltip', { name: 'Питание' })
  await plot.focus()
  await expect(tip).toContainText(clock)
  await expect(tip).toContainText('Белки: Неизвестно · Неполные данные')
  await page.keyboard.press('ArrowRight')
  await expect(tip).toContainText(clock)
  await expect(tip).toContainText('Белки: 5.00 г · Неполные данные')
  await expect(plot).toHaveAttribute('aria-valuemax', '1')
  if (process.env.DIARY_ACCEPTANCE_DIR) await details.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/06-historical-${info.project.name}.png` })
})
