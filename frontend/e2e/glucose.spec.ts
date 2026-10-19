import { test, expect } from '@playwright/test'

test.use({ timezoneId: 'America/Los_Angeles' })

test('glucose periods, gaps, keyboard day navigation and updated summaries', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByLabel('Сахар, ммоль/л')).toBeVisible()
  const month = testInfo.project.name === 'phone' ? '08' : '07'
  const first = `2010-${month}-01`
  const second = `2010-${month}-02`
  const third = `2010-${month}-03`
  await page.evaluate(async ({ first, third }) => {
    const { csrf_token } = await (await fetch('/api/auth/csrf')).json()
    for (const [day, glucose] of [[first, '4.0'], [first, '8.0'], [third, '12.0']]) {
      const response = await fetch('/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf_token },
        body: JSON.stringify({ operation_id: crypto.randomUUID(), occurred_at: `${day}T12:00:00+04:00`, glucose }) })
      if (!response.ok) throw new Error('Could not create measurement')
    }
  }, { first, third })
  const charts = page.getByRole('region', { name: 'Графики сахара' })
  await expect(charts).toBeVisible()
  await charts.getByLabel('Конец периода — Москва').fill(third)
  await charts.getByRole('button', { name: 'Показать период' }).click()
  await expect(charts.getByRole('table').getByRole('row')).toHaveCount(8)
  await expect(charts.getByTestId('period-average')).toHaveText('Среднее за период: 8,0 ммоль/л · измерений: 3')
  await charts.getByLabel('Период', { exact: true }).selectOption('month')
  await charts.getByRole('button', { name: 'Показать период' }).click()
  await expect(charts.getByRole('table').getByRole('row')).toHaveCount(31)
  await charts.getByLabel('Период', { exact: true }).selectOption('custom')
  await charts.getByLabel('Начало периода — Москва').fill(first)
  await charts.getByRole('button', { name: 'Показать период' }).click()
  await expect(charts.getByRole('table').getByRole('row')).toHaveCount(4)
  await expect(charts.getByTestId('period-bounds')).toHaveText(`${first} — ${third} · Москва · обе даты включены`)
  const rows = charts.getByRole('table').getByRole('row')
  await expect(rows.nth(1)).toContainText('6,0')
  await expect(rows.nth(1)).toContainText('4,0')
  await expect(rows.nth(1)).toContainText('8,0')
  await expect(rows.nth(2)).toContainText('Нет измерений')
  // All three glucose series must break across the empty day.
  const paths = charts.locator('.recharts-line-curve')
  await expect(paths).toHaveCount(3)
  for (const path of await paths.all()) expect((await path.getAttribute('d'))?.match(/M/g)).toHaveLength(2)
  await charts.locator('.recharts-line-dot').last().click()
  await expect(page.getByLabel('День — Москва')).toHaveValue(third)
  await expect(page.locator('.entries > .entry')).toHaveCount(1)
  await charts.screenshot({ path: `/app/frontend/test-results/glucose-${testInfo.project.name}.png` })
  await charts.getByRole('button', { name: `Открыть день ${first}` }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('День — Москва')).toHaveValue(first)
  await expect(page.locator('.entries > .entry')).toHaveCount(2)
  await page.locator('.entries > .entry').first().getByRole('button', { name: 'Изменить', exact: true }).click()
  await page.getByLabel('Сахар, ммоль/л').fill('10.0')
  await page.getByLabel('Время события — Москва').fill(`${second}T12:00`)
  await page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()
  await expect(charts.getByTestId('period-average')).toContainText('10,0 ммоль/л · измерений: 3')
  await expect(rows.nth(1)).toContainText('8,0')
  await expect(rows.nth(2)).toContainText('10,0')
  await page.locator('.entries > .entry').getByRole('button', { name: 'Удалить', exact: true }).click()
  await expect(charts.getByTestId('period-average')).toContainText('10,0 ммоль/л · измерений: 2')
  await expect(rows.nth(2)).toContainText('Нет измерений')
  await page.getByRole('button', { name: 'Отменить удаление', exact: true }).click()
  await expect(rows.nth(2)).toContainText('10,0')
  await expect(charts.getByTestId('period-average')).toContainText('измерений: 3')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
