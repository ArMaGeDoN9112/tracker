import { test, expect } from '@playwright/test'

test('shell visual evidence and keyboard access', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/')
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(page.getByLabel('Пароль', { exact: true })).toBeVisible()
  await page.screenshot({ path: '/artifacts/login-375.png', fullPage: true })
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByLabel('Сахар, ммоль/л')).toBeVisible()
  for (const width of [375, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const [section, label] of [['diary', 'Дневник'], ['charts', 'Графики'], ['basal', 'База'], ['settings', 'Настройки']]) {
      await page.getByRole('link', { name: label, exact: true }).click()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(label)
      if (section === 'charts') await expect(page.getByTestId('period-average')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: `/artifacts/${section}-${width}.png`, fullPage: true })
    }
  }
  await page.setViewportSize({ width: 375, height: 812 })
  const diary = page.getByRole('link', { name: 'Дневник', exact: true })
  await diary.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Дневник')
  expect(await diary.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none')
  for (const link of await page.getByRole('navigation', { name: 'Разделы' }).getByRole('link').all()) {
    const box = await link.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)
  }
  await page.screenshot({ path: '/artifacts/focus-375.png' })
  await page.getByLabel('Комментарий', { exact: true }).fill('Синтетическая запись для проверки отмены')
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.locator('.entries > .entry')).toHaveCount(1)
  await page.locator('.entries').getByRole('button', { name: 'Удалить', exact: true }).click()
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Отменить удаление', exact: true })).toBeVisible()
  await page.screenshot({ path: '/artifacts/undo-settings-375.png', fullPage: true })
})
