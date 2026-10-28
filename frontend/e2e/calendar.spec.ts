import { openSection } from './navigation'
import { test, expect } from '@playwright/test'

test.use({ timezoneId: 'America/Los_Angeles' })

test('month calendar opens the complete Moscow day and clears unfinished input', async ({ page }, info) => {
  await page.goto('/?section=diary')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByLabel('Время события — Москва')).not.toHaveValue('')
  const calendar = page.getByRole('region', { name: 'Календарь дней', exact: true })
  const server = await (await page.request.get('/api/entry-form')).json()
  await expect(calendar).toBeHidden()
  const day = info.project.name === 'phone' ? '2024-02-29' : '2024-02-28'
  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).csrf_token
  const headers = { Origin: 'https://localhost:5173', 'X-CSRF-Token': csrf }
  for (const [path, data] of [
    ['/api/meals', { lines: [{ id: crypto.randomUUID(), kind: 'one_off', name: 'Обед в календаре', calories: '123.45', protein: '7' }] }],
    ['/api/water', { volume_ml: 750 }],
    ['/api/entries', { glucose: '5.6', bolus: '1.2', reason: 'food', comment: 'Запись календаря' }],
    ['/api/entries', { glucose: '7.0' }],
    ['/api/entries', { bolus: '0.5' }],
  ] as const) {
    expect((await page.request.post(path, { headers, data: { operation_id: crypto.randomUUID(), occurred_at: `${day}T23:59:59.999+03:00`, ...data } })).ok()).toBeTruthy()
  }
  await page.getByLabel('Комментарий', { exact: true }).fill('Черновик остаётся')
  await page.getByRole('link', { name: 'Календарь', exact: true }).click()
  await expect(page).toHaveURL(/section=calendar/)
  await expect(page.getByRole('heading', { name: 'Календарь', exact: true, level: 1 })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Ввод записи', exact: true })).toBeHidden()
  await expect(calendar.getByLabel('Месяц — Москва')).toHaveValue(server.local_time.slice(0, 7))
  await calendar.getByLabel('Месяц — Москва').fill('2024-02')
  const days = calendar.locator('.calendar-day')
  await expect(days).toHaveCount(29)
  await expect(days.first()).toHaveCSS('grid-column-start', '4')
  const open = calendar.getByRole('button', { name: `Открыть сводку за ${day}:` })
  await expect(open).toContainText('123.45')
  await expect(open).toContainText('750')
  await expect(open.locator('.calendar-glucose')).toHaveText('6,3')
  await expect(open).toHaveAccessibleName(/средний сахар 6,3 ммоль\/л/)
  await expect(days.first().locator('.calendar-glucose')).toHaveText('—')
  await expect(days.first()).toHaveAccessibleName(/нет измерений сахара/)
  await open.focus(); await page.keyboard.press('Enter')
  const details = calendar.getByRole('region', { name: 'Подробная сводка дня', exact: true })
  await expect(details.getByRole('heading', { name: `Сводка за ${day}` })).toBeFocused()
  await expect(details).not.toContainText('Обед в календаре')
  await expect(details).toContainText('123.45 ккал')
  await expect(details).toContainText('750 мл')
  const glucoseChart = details.getByRole('slider', { name: 'Сахар · ммоль/л' })
  await glucoseChart.focus()
  await expect(details.getByRole('tooltip', { name: 'Сахар' })).toContainText('5,6 ммоль/л')
  await expect(details.getByRole('tooltip', { name: 'Сахар' })).toContainText('7,0 ммоль/л')
  await expect(details.getByRole('tooltip', { name: 'Подколки' })).toContainText('1,2 ед.')
  await expect(details).not.toContainText('Запись календаря')
  await expect(details).not.toContainText('Известных строк')
  await expect(details).not.toContainText('Основа:')
  await expect(details).not.toContainText('редакция')
  await expect(details.getByRole('group', { name: 'График базы с 00 до 24 часов, Москва' })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`section=calendar&day=${day}`))
  await openSection(page, 'Ввод сахара')
  await expect(calendar).toBeHidden()
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('')
  await page.goBack()
  await expect(calendar).toBeVisible()
  await expect(glucoseChart).toBeVisible()
  for (const width of [375, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const box = await days.first().boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)
    const water = await open.locator('.calendar-water').boundingBox()
    const selected = await open.boundingBox()
    expect(water!.y + water!.height).toBeLessThanOrEqual(selected!.y + selected!.height)
    const glucose = await open.locator('.calendar-glucose').boundingBox()
    expect(glucose!.y + glucose!.height).toBeLessThanOrEqual(selected!.y + selected!.height)
    expect((await open.locator('.calendar-calories').boundingBox())!.height).toBeLessThanOrEqual(21)
    if (process.env.DIARY_ACCEPTANCE_DIR) await calendar.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/calendar-${info.project.name}-${width}.png` })
  }
  await calendar.getByRole('button', { name: 'Следующий месяц' }).click()
  await expect(days).toHaveCount(31)
  await expect(details).toHaveCount(0)
  await calendar.getByLabel('Месяц — Москва').fill('2025-02')
  await expect(days).toHaveCount(28)
  await days.first().click()
  await expect(details).toContainText('Нет записей еды')
  await expect(details).toContainText('Нет записей воды')
  await expect(details).toContainText('Нет записей сахара и подколок')
  await page.reload()
  await expect(page.getByRole('link', { name: 'Календарь', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(calendar).toBeVisible()
  await expect(page.getByRole('region', { name: 'Ввод записи', exact: true })).toBeHidden()
})

test('calendar shows basal gaps and zero rates, meal results and water volumes', async ({ page }, info) => {
  await page.goto('/?section=diary')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const total = (value: string | null, incomplete = false) => ({ value, incomplete, known_count: value === null ? 0 : 1, unknown_count: incomplete || value === null ? 1 : 0 })
  const totals = { calories: total('350', true), protein: total('15'), fat: total(null), carbohydrate: total('40') }
  await page.route('**/api/nutrition-day?*', route => route.fulfill({ json: {
    day: '2026-10-20', totals, meals: [{ id: 'meal', occurred_at: '2026-10-20T09:00:00Z', category: 'lunch', totals,
      lines: [{ id: 'food', name: 'Рис с овощами', quantity: '250', unit: 'g' }] }],
    water_total_ml: 750, water: [{ id: 'water-1', occurred_at: '2026-10-20T06:00:00Z', volume_ml: 250 }, { id: 'water-2', occurred_at: '2026-10-20T09:00:00Z', volume_ml: 500 }],
  } }))
  await page.route('**/api/day?*', route => route.fulfill({ json: {
    basal: '0.50', temporary_percent: null, entries: [], temporary_basals: [],
    basal_changes: [{ occurred_at: '2026-10-19T22:40:12.345Z', basal: '0.60' }, { occurred_at: '2026-10-20T03:00:00Z', basal: null }, { occurred_at: '2026-10-20T09:00:00Z', basal: '0.00' }, { occurred_at: '2026-10-20T15:00:00Z', basal: '0.80' }],
  } }))
  await page.getByRole('link', { name: 'Календарь', exact: true }).click()
  await page.getByLabel('Месяц — Москва').fill('2026-10')
  await page.getByRole('button', { name: 'Открыть сводку за 2026-10-20:' }).click()
  const details = page.getByRole('region', { name: 'Подробная сводка дня', exact: true })
  for (const text of ['350 ккал', 'Неполные данные', 'Неизвестно']) await expect(details.locator('.calendar-day-totals')).toContainText(text)
  await expect(details).not.toContainText('Рис с овощами')
  await details.getByRole('slider', { name: 'КБЖУ по времени' }).focus()
  await expect(details.getByRole('tooltip', { name: 'Питание' })).toContainText('12:00')
  await expect(details.getByRole('tooltip', { name: 'Питание' })).toContainText('Калории: 350 ккал · Неполные данные')
  await expect(details).not.toContainText('Известных строк')
  await expect(details).not.toContainText('Основа:')
  await expect(details).toContainText('750 мл')
  const chart = details.getByRole('group', { name: 'График базы с 00 до 24 часов, Москва' })
  await expect(chart).toBeVisible()
  await expect(details.getByText('Интервалы и скорости', { exact: true })).toHaveCount(0)
  for (const interval of ['00:00–01:40 · 0,50 ед/ч', '01:40–06:00 · 0,60 ед/ч', '06:00–12:00 · неизвестна', '12:00–18:00 · 0,00 ед/ч', '18:00–24:00 · 0,80 ед/ч']) {
    const target = chart.getByRole('button', { name: interval, exact: true })
    await target.hover()
    const [period, rate] = interval.split(' · ')
    await expect(chart.getByRole('tooltip')).toContainText(period)
    await expect(chart.getByRole('tooltip')).toContainText(rate)
  }
  if (process.env.DIARY_ACCEPTANCE_DIR) await chart.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/basal-tooltip-${info.project.name}.png` })
  await page.keyboard.press('Escape')
  await expect(chart.getByRole('tooltip')).toHaveCount(0)
  await details.getByRole('heading', { name: 'Питание', exact: true }).hover()
  await expect(chart.getByRole('tooltip')).toHaveCount(0)
  const zero = chart.getByRole('button', { name: '12:00–18:00 · 0,00 ед/ч', exact: true })
  if (info.project.name === 'phone') await zero.tap()
  else await zero.focus()
  await expect(zero).toBeFocused()
  await expect(chart.getByRole('tooltip')).toContainText('0,00 ед/ч')
  await page.keyboard.press('Escape')
  await expect(chart.getByRole('tooltip')).toHaveCount(0)
  await chart.getByRole('button', { name: '01:40–06:00 · 0,60 ед/ч', exact: true }).dispatchEvent('click')
  await expect(chart.getByRole('tooltip')).toContainText('0,60 ед/ч')
  await expect(details.locator('.calendar-water-events')).toHaveCount(0)
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (process.env.DIARY_ACCEPTANCE_DIR) await details.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/summary-${info.project.name}-${width}.png` })
  }
  await page.route('**/api/day?*', route => route.fulfill({ json: {
    basal: '0.50', temporary_percent: null, entries: [], temporary_basals: [], basal_changes: [
      { occurred_at: '2014-10-25T21:15:00Z', basal: '1.00' },
      { occurred_at: '2014-10-25T21:45:00Z', basal: '0.50' },
      { occurred_at: '2014-10-25T22:15:00Z', basal: '1.00' },
      { occurred_at: '2014-10-25T22:45:00Z', basal: '0.50' },
    ],
  } }))
  await page.getByLabel('Месяц — Москва').fill('2014-10')
  await page.getByRole('button', { name: 'Открыть сводку за 2014-10-26:' }).click()
  await expect(details).toContainText('В этот день переводились часы')
  await expect(chart).toBeVisible()
  await chart.getByRole('button', { name: '01:15–01:45 · 1,00 ед/ч', exact: true }).first().focus()
  await expect(chart.getByRole('tooltip')).toContainText('1,00 ед/ч')
  await expect(details).not.toContainText(/GMT|МСК|\d{2}:\d{2}:\d{2}/)
  await expect(details.getByRole('listitem').filter({ hasText: 'ед/ч' })).toHaveCount(0)
})

test('day diabetes charts share actual times, values and selection with keyboard and pointer', async ({ page }, info) => {
  const day = info.project.name === 'phone' ? '2088-06-13' : '2088-06-12'
  await page.goto(`/?section=calendar&day=${day}`)
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('heading', { name: `Сводка за ${day}` })).toBeVisible()
  const headers = { Origin: 'https://localhost:5173', 'X-CSRF-Token': (await (await page.request.get('/api/auth/csrf')).json()).csrf_token }
  for (const data of [
    { occurred_at: `${day}T00:00:00.000+03:00`, glucose: '4.1' },
    { occurred_at: `${day}T06:00:00.001+03:00`, bolus: '2.3' },
    { occurred_at: `${day}T06:00:00.002+03:00`, glucose: '8.2' },
    { occurred_at: `${day}T12:00:00.000+03:00`, glucose: '5.5', bolus: '1.1' },
    { occurred_at: `${day}T12:00:00.000+03:00`, glucose: '6.6', bolus: '3.3' },
    { occurred_at: `${day}T23:59:59.999+03:00`, glucose: '7.7', bolus: '0.0' },
  ]) {
    const response = await page.request.post('/api/entries', { headers, data: { operation_id: crypto.randomUUID(), ...data } })
    expect(response.ok(), await response.text()).toBeTruthy()
  }
  await page.reload()
  const details = page.getByRole('region', { name: 'Подробная сводка дня' })
  const glucose = details.getByRole('slider', { name: 'Сахар · ммоль/л' })
  const bolus = details.getByRole('slider', { name: 'Подколки · ед.' })
  const sugarTip = details.getByRole('tooltip', { name: 'Сахар', exact: true })
  const bolusTip = details.getByRole('tooltip', { name: 'Подколки', exact: true })
  await glucose.focus()
  await expect(sugarTip).toHaveText('00:004,1 ммоль/л')
  await expect(bolusTip).toHaveText('00:000,0 ед.')
  await page.keyboard.press('ArrowRight')
  await expect(sugarTip).toHaveText('06:00Сахар не указан')
  await expect(bolusTip).toHaveText('06:002,3 ед.')
  await page.keyboard.press('ArrowRight')
  await expect(sugarTip).toHaveText('06:008,2 ммоль/л')
  await expect(bolusTip).toHaveText('06:000,0 ед.')
  await bolus.focus()
  await page.keyboard.press('ArrowRight')
  await expect(sugarTip).toContainText('Запись 1: 5,5 ммоль/л')
  await expect(sugarTip).toContainText('Запись 2: 6,6 ммоль/л')
  await expect(bolusTip).toContainText('Запись 1: 1,1 ед.')
  await expect(bolusTip).toContainText('Запись 2: 3,3 ед.')
  await page.keyboard.press('End')
  await expect(sugarTip).toHaveText('23:597,7 ммоль/л')
  await page.keyboard.press('Home')
  await expect(sugarTip).toContainText('00:00')
  await page.keyboard.press('Escape')
  await expect(sugarTip).toHaveCount(0)
  await expect(bolusTip).toHaveCount(0)

  // Use the rendered clock marks to exercise the same time on each chart.
  const boxes: number[][] = []
  for (const slider of [glucose, bolus]) {
    await slider.scrollIntoViewIfNeeded()
    const left = await slider.getByText('00:00', { exact: true }).boundingBox()
    const middle = await slider.getByText('12:00', { exact: true }).boundingBox()
    const right = await slider.getByText('24:00', { exact: true }).boundingBox()
    boxes.push([left!.x + left!.width / 2, middle!.x + middle!.width / 2, right!.x + right!.width / 2])
    const area = await slider.boundingBox()
    const y = area!.y + 80
    if (info.project.name === 'phone') {
      const session = await page.context().newCDPSession(page)
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: boxes.at(-1)![0], y }] })
      await expect(sugarTip).toContainText('4,1 ммоль/л')
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: boxes.at(-1)![1], y }] })
      await expect(sugarTip).toContainText('5,5 ммоль/л')
      await expect(bolusTip).toContainText('3,3 ед.')
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await session.detach()
    } else {
      await page.mouse.move(boxes.at(-1)![0], y)
      await expect(sugarTip).toContainText('4,1 ммоль/л')
      await page.mouse.move(boxes.at(-1)![1], y)
      await expect(sugarTip).toContainText('5,5 ммоль/л')
      await expect(bolusTip).toContainText('3,3 ед.')
    }
  }
  boxes[0].forEach((x, index) => expect(x).toBeCloseTo(boxes[1][index], 0))
  for (const slider of [glucose, bolus]) {
    const line = slider.locator('.recharts-line-curve')
    await expect(line).toBeVisible()
    await expect(line).not.toHaveCSS('stroke', 'none')
  }
  await details.getByRole('heading', { name: `Сводка за ${day}` }).focus()
  await glucose.hover()
  await expect(sugarTip).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sugarTip).toHaveCount(0)
  await expect(bolusTip).toHaveCount(0)
  for (const width of [375, 844, 1280]) {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (process.env.DIARY_ACCEPTANCE_DIR) await details.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/05-charts-${info.project.name}-${width}.png` })
  }
  await details.getByRole('link', { name: 'Записи диабета' }).click()
  await expect(page.getByLabel('День — Москва')).toHaveValue(day)
  await expect(page.locator('.entries > .entry')).toHaveCount(6)
})

test('historical repeated hours and single indicators retain every event within Moscow boundaries', async ({ page }, info) => {
  const day = '2010-10-31'
  await page.goto(`/?section=calendar&day=${day}`)
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('heading', { name: `Сводка за ${day}` })).toBeVisible()
  const headers = { Origin: 'https://localhost:5173', 'X-CSRF-Token': (await (await page.request.get('/api/auth/csrf')).json()).csrf_token }
  // Distinct dates avoid sharing single-point fixtures between device projects.
  const single = info.project.name === 'phone' ? '2087-05-15' : '2087-05-14'
  const dates = [
    { occurred_at: `${day}T00:00:00.000+04:00`, glucose: '3.1' },
    { occurred_at: `${day}T02:30:00.000+04:00`, glucose: '4.2' },
    { occurred_at: `${day}T02:30:00.000+03:00`, glucose: '9.3', bolus: '2.0' },
    { occurred_at: `${day}T23:59:59.999+03:00`, glucose: '5.4' },
    { occurred_at: '2010-10-30T23:59:59.999+04:00', glucose: '99.1' },
    { occurred_at: '2010-11-01T00:00:00.000+03:00', glucose: '99.2' },
    { occurred_at: `${single}T12:00:00+03:00`, glucose: '5.9' },
    { occurred_at: `${single}T12:00:00+03:00`.replace('-05-', '-06-'), bolus: '1.7' },
  ]
  for (const data of dates) {
    const response = await page.request.post('/api/entries', { headers, data: { operation_id: crypto.randomUUID(), ...data } })
    expect(response.ok(), await response.text()).toBeTruthy()
  }
  await page.reload()
  const details = page.getByRole('region', { name: 'Подробная сводка дня' })
  const glucose = details.getByRole('slider', { name: 'Сахар · ммоль/л' })
  const sugarTip = details.getByRole('tooltip', { name: 'Сахар', exact: true })
  const bolusTip = details.getByRole('tooltip', { name: 'Подколки', exact: true })
  await glucose.focus()
  await expect(sugarTip).toContainText('3,1 ммоль/л')
  await expect(glucose.getByText('05:15', { exact: true })).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(sugarTip).toContainText('02:30')
  await expect(sugarTip).toContainText('4,2 ммоль/л')
  await page.keyboard.press('ArrowRight')
  await expect(sugarTip).toContainText('02:30')
  await expect(sugarTip).toContainText('9,3 ммоль/л')
  await expect(bolusTip).toContainText('2,0 ед.')
  await page.keyboard.press('End')
  await expect(sugarTip).toContainText('23:59')
  await expect(sugarTip).toContainText('5,4 ммоль/л')
  await expect(sugarTip).not.toContainText('99,')
  for (const [month, expected] of [['05', '5,9 ммоль/л'], ['06', 'Сахар не указан'], ['07', 'Нет записей сахара и подколок.']]) {
    const date = single.replace('-05-', `-${month}-`)
    await page.getByLabel('Месяц — Москва').fill(date.slice(0, 7))
    await page.getByRole('button', { name: `Открыть сводку за ${date}:` }).click()
    if (month === '07') {
      await expect(details).toContainText(expected)
      await glucose.focus()
      await page.keyboard.press('ArrowRight')
      await expect(sugarTip).toHaveCount(0)
    } else {
      await glucose.focus()
      await expect(sugarTip).toContainText(expected)
      await expect(bolusTip).toContainText(month === '05' ? '0,0 ед.' : '1,7 ед.')
      await page.keyboard.press('End')
      await expect(sugarTip).toContainText(expected)
    }
  }
})

test('calendar charts show loading and errors and discard a late response for a closed day', async ({ page }) => {
  await page.goto('/?section=calendar&day=2086-01-01')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const details = page.getByRole('region', { name: 'Подробная сводка дня' })
  await expect(details).toContainText('Нет записей сахара и подколок.')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let received!: () => void
  const held = new Promise<void>(resolve => { received = resolve })
  await page.route('**/api/nutrition-day?day=2086-01-02', async route => {
    const response = await route.fetch()
    received()
    await gate
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: 'Открыть сводку за 2086-01-02:' }).click()
  await held
  await expect(details).toContainText('Загружаем сводку дня…')
  await expect(details.getByRole('slider')).toHaveCount(0)
  await page.route('**/api/nutrition-day?day=2086-01-03', route => route.fulfill({ status: 503, json: { message: 'Synthetic read failure' } }))
  await page.getByRole('button', { name: 'Открыть сводку за 2086-01-03:' }).click()
  await expect(details.getByRole('alert')).toContainText('Не удалось загрузить сводку дня.')
  const late = page.waitForResponse('**/api/nutrition-day?day=2086-01-02')
  release()
  await late
  await expect(details.getByRole('alert')).toBeVisible()
  await expect(details.getByRole('slider')).toHaveCount(0)
  await page.unroute('**/api/nutrition-day?day=2086-01-03')
  await page.getByRole('button', { name: 'Открыть сводку за 2086-01-04:' }).click()
  await expect(details.getByRole('slider')).toHaveCount(2)
  await page.getByRole('button', { name: 'Открыть сводку за 2086-01-03:' }).click()
  await expect(details.getByRole('slider')).toHaveCount(2)
  await expect(details.getByRole('alert')).toHaveCount(0)
})
