import { openSection } from './navigation'
import { test, expect, type Page } from '@playwright/test'

test.use({ timezoneId: 'America/Los_Angeles' })

async function signIn(page: Page) {
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible()
}

test('home opens the Moscow day summary after login', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-27T22:30:00Z'))
  await page.goto('/')
  await expect(page.getByRole('navigation')).toHaveCount(0)
  await signIn(page)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Календарь')
  await expect(page.getByLabel('Месяц — Москва')).toHaveValue('2026-10')
  await expect(page.getByRole('region', { name: 'Подробная сводка дня', exact: true })).toContainText('Сводка за 2026-10-28')
  await expect(page.getByRole('link', { name: 'Календарь', exact: true })).toHaveAttribute('aria-current', 'page')
})

test('default home selects today at login after Moscow midnight', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-27T20:59:00Z'))
  await page.goto('/')
  await expect(page.getByLabel('Логин', { exact: true })).toBeVisible()
  await page.clock.setFixedTime(new Date('2026-10-27T21:01:00Z'))
  await signIn(page)
  await expect(page.getByRole('heading', { name: 'Сводка за 2026-10-28' })).toBeVisible()
})

for (const day of ['0001-01-01', '0001-01-15', '9999-12-01', '9999-12-31']) {
  test(`unsupported calendar boundary ${day} is explained before requesting data`, async ({ page }) => {
    const requests: string[] = []
    page.on('request', request => { if (request.url().includes('/api/') && /[?&](day|start|end)=/.test(request.url())) requests.push(request.url()) })
    await page.goto(`/?section=calendar&day=${day}`)
    await signIn(page)
    await expect(page.getByRole('alert').filter({ hasText: 'Некорректная дата' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Подробная сводка дня', exact: true })).toBeVisible()
    expect(requests.some(url => /[?&](day|start|end)=(0001|9999)-/.test(url))).toBe(false)
  })
}

for (const day of ['0001-01-15', '9999-12-01']) {
  test(`transition from diary day ${day} never requests an unsupported calendar month`, async ({ page }) => {
    await page.goto(`/?section=diary&day=${day}`)
    await signIn(page)
  await openSection(page, 'Аналитика сахара')
    await expect(page.getByLabel('День — Москва')).toHaveValue(day)
    const requests: string[] = []
    page.on('request', request => { if (request.url().includes('-summary?')) requests.push(request.url()) })
    await page.getByRole('link', { name: 'Календарь', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Некорректная дата' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Подробная сводка дня', exact: true })).toBeVisible()
    expect(requests.some(url => /[?&](start|end)=(0001|9999)-/.test(url))).toBe(false)
  })
}

test('grouped links preserve history, focus and opening another tab', async ({ page, context }, info) => {
  await page.goto('/?section=calendar&day=2024-02-29')
  await signIn(page)
  await expect(page.getByLabel('Месяц — Москва')).toHaveValue('2024-02')
  await expect(page.getByRole('heading', { name: 'Сводка за 2024-02-29' })).toBeVisible()
  const top = page.getByRole('navigation', { name: 'Разделы', exact: true })
  await expect(top.getByRole('link')).toHaveText(['Календарь', 'Диабет', 'Питание', 'Настройки'])
  await top.getByRole('link', { name: 'Диабет', exact: true }).focus()
  await page.keyboard.press('Enter')
  const diabetes = page.getByRole('navigation', { name: 'Страницы диабета', exact: true })
  await expect(diabetes.getByRole('link')).toHaveText(['Ввод', 'Анализ', 'База'])
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
  await page.getByLabel('Комментарий', { exact: true }).fill('Не сохранять')
  await diabetes.getByRole('link', { name: 'Анализ', exact: true }).click()
  await expect(diabetes.getByRole('link', { name: 'Анализ', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.goBack()
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('')
  await page.goForward()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Аналитика сахара')
  const another = await context.newPage()
  await another.goto((await diabetes.getByRole('link', { name: 'База', exact: true }).getAttribute('href'))!)
  await expect(another.getByRole('heading', { level: 1 })).toHaveText('База')
  await another.close()
  await top.getByRole('link', { name: 'Питание', exact: true }).click()
  const nutrition = page.getByRole('navigation', { name: 'Страницы питания', exact: true })
  await expect(nutrition.getByRole('link')).toHaveText(['Ввод', 'Анализ', 'Каталог'])
  await expect(nutrition.getByRole('link', { name: 'Ввод', exact: true })).toHaveAttribute('aria-current', 'page')
  await nutrition.getByRole('link', { name: 'Анализ', exact: true }).click()
  await top.getByRole('link', { name: 'Питание', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ввод питания')
  for (const section of ['Календарь', 'Диабет', 'Питание']) {
    await top.getByRole('link', { name: section, exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (process.env.DIARY_ACCEPTANCE_DIR) await page.screenshot({ path: `${process.env.DIARY_ACCEPTANCE_DIR}/navigation-${info.project.name}-${section}.png`, fullPage: true })
    const action = page.getByRole('button', { name: section === 'Диабет' ? 'Сохранить запись' : section === 'Питание' ? 'Сохранить приём пищи' : 'Закрыть сводку', exact: true })
    await action.scrollIntoViewIfNeeded()
    const box = await action.boundingBox()
    const nav = await top.boundingBox()
    if (info.project.name === 'phone') expect(box!.y + box!.height).toBeLessThanOrEqual(nav!.y)
  }
})

test('legacy links and calendar dates restore their addressed page', async ({ page }) => {
  await page.goto('/?section=calendar&day=2024-02-29')
  await signIn(page)
  for (const [section, heading] of [['diary', 'Ввод сахара'], ['charts', 'Аналитика сахара'], ['basal', 'База'], ['basal&view=temporary', 'База'], ['nutrition', 'Ввод питания'], ['nutrition-summary', 'Аналитика питания'], ['catalog', 'Каталог еды'], ['settings', 'Настройки']]) {
    await page.goto(`/?section=${section}&day=2024-02-29`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading)
    if (section === 'basal&view=temporary') await expect(page.getByRole('link', { name: 'Временная база', exact: true })).toHaveAttribute('aria-current', 'page')
  }
  await page.goto('/?section=calendar&day=2024-02-29')
  await page.getByRole('button', { name: 'Следующий месяц' }).click()
  await page.getByRole('button', { name: 'Открыть сводку за 2024-03-01:' }).click()
  await page.goBack()
  await expect(page.getByLabel('Месяц — Москва')).toHaveValue('2024-02')
  await expect(page.getByRole('heading', { name: 'Сводка за 2024-02-29' })).toBeVisible()
  await page.goForward()
  await expect(page.getByLabel('Месяц — Москва')).toHaveValue('2024-03')
  await expect(page.getByRole('heading', { name: 'Сводка за 2024-03-01' })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Месяц — Москва')).toHaveValue('2024-03')
  const invalid: string[] = []
  page.on('request', request => { if (request.url().includes('/api/') && request.url().includes('2024-02-30')) invalid.push(request.url()) })
  await page.goto('/?section=unknown&day=2024-02-30')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Календарь')
  await expect(page.getByRole('alert').filter({ hasText: 'Некорректная дата' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Подробная сводка дня', exact: true })).toBeVisible()
  expect(invalid).toEqual([])
})
