import { test, expect } from '@playwright/test'

test.use({ timezoneId: 'America/Los_Angeles' })

test('day diabetes charts share actual times, values and selection with keyboard and pointer', async ({ page }, info) => {
  const day = info.project.name === 'phone' ? '2088-06-13' : '2088-06-12'
  await page.goto(`/?section=charts&day=${day}`)
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Аналитика сахара', exact: true })).toBeVisible()
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
  const details = page.getByRole('region', { name: 'Хронология дня' })
  const glucose = details.getByRole('slider', { name: 'Сахар и инсулин по времени' })
  const bolus = glucose
  const sugarTip = details.getByRole('tooltip', { name: 'Сахар', exact: true })
  const bolusTip = details.getByRole('tooltip', { name: 'Подколки', exact: true })
  await expect(glucose.getByText('30', { exact: true })).toBeVisible()
  await glucose.focus()
  await expect(sugarTip).toHaveText('00:00 · Сахар4,1 ммоль/л')
  await expect(bolusTip).toHaveText('00:00 · Подколки0,0 ед.')
  await page.keyboard.press('ArrowRight')
  await expect(sugarTip).toHaveText('06:00 · СахарСахар не указан')
  await expect(bolusTip).toHaveText('06:00 · Подколки2,3 ед.')
  await page.keyboard.press('ArrowRight')
  await expect(sugarTip).toHaveText('06:00 · Сахар8,2 ммоль/л')
  await expect(bolusTip).toHaveText('06:00 · Подколки0,0 ед.')
  await bolus.focus()
  await page.keyboard.press('ArrowRight')
  await expect(sugarTip).toContainText('Запись 1: 5,5 ммоль/л')
  await expect(sugarTip).toContainText('Запись 2: 6,6 ммоль/л')
  await expect(bolusTip).toContainText('Запись 1: 1,1 ед.')
  await expect(bolusTip).toContainText('Запись 2: 3,3 ед.')
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  await expect(sugarTip).toHaveText('23:59 · Сахар7,7 ммоль/л')
  await page.keyboard.press('Home')
  await expect(sugarTip).toContainText('00:00')
  await page.keyboard.press('Escape')
  await expect(sugarTip).toHaveCount(0)
  await expect(bolusTip).toHaveCount(0)

  // Use the rendered clock marks to exercise selection on the combined chart.
  const boxes: number[][] = []
  const origins: number[] = []
  for (const slider of [glucose]) {
    await slider.scrollIntoViewIfNeeded()
    const left = await slider.getByText('00:00', { exact: true }).boundingBox()
    const middle = await slider.getByText('12:00', { exact: true }).boundingBox()
    const right = await slider.getByText('24:00', { exact: true }).boundingBox()
    boxes.push([left!.x + left!.width / 2, middle!.x + middle!.width / 2, right!.x + right!.width / 2])
    const area = await slider.boundingBox()
    origins.push(area!.x)
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
  await expect(glucose.locator('.recharts-line-curve').first()).toHaveAttribute('d', /C/)
  await expect(glucose.locator('.recharts-line-dot')).toHaveCount(5)
  await expect(bolus.locator('.recharts-line')).toHaveCount(2)
  await expect(bolus.locator('.recharts-bar')).toHaveCount(1)
  expect(await bolus.locator('.recharts-bar-rectangle').count()).toBeGreaterThan(0)
  await page.getByRole('heading', { level: 1 }).focus()
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
  await expect(page.getByLabel('День — Москва')).toHaveValue(day)
  await expect(page.locator('.entries > .entry')).toHaveCount(6)
})

test('historical repeated hours and single indicators retain every event within Moscow boundaries', async ({ page }, info) => {
  const day = '2010-10-31'
  await page.goto(`/?section=charts&day=${day}`)
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Аналитика сахара', exact: true })).toBeVisible()
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
  const details = page.getByRole('region', { name: 'Хронология дня' })
  const glucose = details.getByRole('slider', { name: 'Сахар и инсулин по времени' })
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
  await page.keyboard.press('ArrowLeft')
  await expect(sugarTip).toContainText('23:59')
  await expect(sugarTip).toContainText('5,4 ммоль/л')
  await expect(sugarTip).not.toContainText('99,')
  for (const [month, expected] of [['05', '5,9 ммоль/л'], ['06', 'Сахар не указан'], ['07', 'Нет записей сахара и подколок.']]) {
    const date = single.replace('-05-', `-${month}-`)
    await page.getByLabel('День — Москва', { exact: true }).fill(date)
    if (month === '07') {
      await expect(details).toContainText(expected)
      await glucose.focus()
      await page.keyboard.press('ArrowRight')
      await expect(sugarTip).toContainText('Нет записи в этот момент')
    } else {
      await glucose.focus()
      await page.keyboard.press('ArrowRight')
      await expect(sugarTip).toContainText(expected)
      await expect(bolusTip).toContainText(month === '05' ? '0,0 ед.' : '1,7 ед.')
      await page.keyboard.press('End')
      await page.keyboard.press('ArrowLeft')
      await expect(sugarTip).toContainText(expected)
    }
  }
})

