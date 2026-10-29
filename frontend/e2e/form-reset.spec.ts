import { openSection } from './navigation'
import { test, expect, type Page } from '@playwright/test'

async function signIn(page: Page) {
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible()
}

for (const [section, label] of [['nutrition', 'Время приёма — Москва'], ['basal', 'Начало расписания — Москва'], ['basal&view=temporary', 'Начало временной базы — Москва']]) {
  test(`${section}: delayed default time does not overwrite ordinary input`, async ({ page }) => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let reached = 0, completed = 0
    await page.route('**/api/entry-form', async route => {
      const response = await route.fetch()
      reached++
      await gate
      await route.fulfill({ response })
      completed++
    })
    await page.goto(`/?section=${section}&day=2049-01-02`)
    await signIn(page)
    await expect.poll(() => reached).toBeGreaterThan(0)
    await page.getByLabel(label, { exact: true }).fill('2049-01-02T12:34')
    release()
    await expect.poll(() => completed).toBe(reached)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(page.getByLabel(label, { exact: true })).toHaveValue('2049-01-02T12:34')
  })
}

test('late water comparison cannot reopen a discarded editor', async ({ page }, info) => {
  const day = info.project.name === 'phone' ? '2051-01-02' : '2050-01-02'
  await page.goto(`/?section=nutrition&day=${day}`)
  await signIn(page)
  await page.getByLabel('Объём воды, мл', { exact: true }).fill('234')
  await page.getByLabel('Время воды — Москва', { exact: true }).fill(`${day}T10:00`)
  await page.getByRole('button', { name: 'Сохранить воду', exact: true }).click()
  await openSection(page, 'Аналитика питания')
  await page.getByRole('button', { name: 'Изменить воду', exact: true }).click()
  const row = (await (await page.request.get(`/api/nutrition-day?day=${day}`)).json()).water[0]
  const headers = { Origin: 'https://localhost:5173', 'X-CSRF-Token': (await (await page.request.get('/api/auth/csrf')).json()).csrf_token }
  expect((await page.request.put(`/api/water/${row.id}`, { headers, data: {
    operation_id: crypto.randomUUID(), expected_revision: row.revision, volume_ml: 456, occurred_at: row.occurred_at,
  } })).ok()).toBeTruthy()
  await page.getByLabel('Объём воды, мл', { exact: true }).fill('345')
  await page.getByRole('button', { name: 'Сохранить воду', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Загрузить актуальные данные воды', exact: true })).toBeVisible()
  let release!: () => void
  let reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const captured = new Promise<void>(resolve => { reached = resolve })
  await page.route(`**/api/water/${row.id}`, async route => {
    const response = await route.fetch()
    reached()
    await gate
    await route.fulfill({ response })
  }, { times: 1 })
  await page.getByRole('button', { name: 'Загрузить актуальные данные воды', exact: true }).click()
  await captured
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await page.goBack()
  const response = page.waitForResponse(`**/api/water/${row.id}`)
  release()
  await response
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(page.getByLabel('Актуальная вода', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Объём воды, мл', { exact: true })).toBeHidden()
})

test('a late committed entry response cannot change the page or reopen the closed form', async ({ page }) => {
  await page.goto('/?section=diary&day=2043-01-02')
  await signIn(page)
  await page.getByLabel('Комментарий', { exact: true }).fill('Сохраняемая запись')
  await page.getByLabel('Время события — Москва').fill('2043-01-02T10:00')
  let release!: () => void
  let reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const captured = new Promise<void>(resolve => { reached = resolve })
  await page.route('**/api/entries', async route => {
    const response = await route.fetch()
    expect(response.ok()).toBeTruthy()
    reached()
    await gate
    await route.fulfill({ response })
  }, { times: 1 })
  await page.getByRole('button', { name: 'Сохранить запись', exact: true }).click()
  await captured
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  const response = page.waitForResponse('**/api/entries')
  release()
  await response
  await expect(page.getByRole('link', { name: 'Настройки', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.goBack()
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Сохранить запись', exact: true })).toBeEnabled()
  await page.getByLabel('Комментарий', { exact: true }).fill('Новый ввод')
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('Новый ввод')
  await openSection(page, 'Аналитика сахара')
  await expect(page.locator('.entries')).toContainText('Сохраняемая запись')
})

test('a late repeat response does not refill a meal after leaving it', async ({ page }, info) => {
  const day = info.project.name === 'phone' ? '2047-01-02' : '2046-01-02'
  await page.goto(`/?section=nutrition&day=${day}`)
  await signIn(page)
  await page.getByRole('button', { name: 'Добавить разовую еду', exact: true }).click()
  await page.getByLabel('Название строки 1', { exact: true }).fill('Еда для повтора')
  await page.getByLabel('Время приёма — Москва').fill(`${day}T10:00`)
  await page.getByRole('button', { name: 'Сохранить приём пищи', exact: true }).click()
  await openSection(page, 'Аналитика питания')
  await expect(page.getByRole('button', { name: 'Повторить приём', exact: true })).toBeVisible()
  let release!: () => void
  let reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const captured = new Promise<void>(resolve => { reached = resolve })
  await page.route('**/repeat-form', async route => {
    const response = await route.fetch()
    reached()
    await gate
    await route.fulfill({ response })
  }, { times: 1 })
  await page.getByRole('button', { name: 'Повторить приём', exact: true }).click()
  await captured
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await page.goBack()
  const response = page.waitForResponse('**/repeat-form')
  release()
  await response
  await expect(page.getByLabel('Время приёма — Москва')).toBeHidden()
  await expect(page.getByLabel('Название строки 1', { exact: true })).toHaveCount(0)
})

test('an unknown entry edit retries its original PUT after the editor is discarded', async ({ page }) => {
  const name = `Правка ${crypto.randomUUID()}`
  await page.goto('/?section=diary&day=2048-01-02')
  await signIn(page)
  await page.getByLabel('Комментарий', { exact: true }).fill(name)
  await page.getByLabel('Время события — Москва').fill('2048-01-02T10:00')
  await page.getByRole('button', { name: 'Сохранить запись', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Запись сохранена.' })).toBeVisible()
  await openSection(page, 'Аналитика сахара')
  const row = page.locator('.entries > .entry').filter({ hasText: name })
  await row.getByRole('button', { name: 'Изменить', exact: true }).click()
  await page.getByLabel('Комментарий', { exact: true }).fill(name + ' изменена')
  const requests: { url: string; method: string; body: string | null }[] = []
  page.on('request', request => {
    if (request.url().includes('/api/entries') && ['POST', 'PUT'].includes(request.method())) requests.push({ url: request.url(), method: request.method(), body: request.postData() })
  })
  await page.route('**/api/entries/*', async route => {
    if (route.request().method() !== 'PUT') return route.continue()
    expect((await route.fetch()).ok()).toBeTruthy()
    await route.abort()
  }, { times: 1 })
  await page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Повторить сохранение', exact: true })).toBeEnabled()
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await signIn(page)
  await openSection(page, 'Ввод сахара')
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('')
  expect(requests).toHaveLength(1)
  await page.getByRole('button', { name: 'Повторить сохранение', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Сохранить запись', exact: true })).toBeEnabled()
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect(requests[1].method).toBe('PUT')
  await openSection(page, 'Аналитика сахара')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(name + ' изменена')
})

for (const section of ['diary', 'nutrition', 'catalog', 'basal', 'temporary'] as const) {
  test(`${section}: unfinished forms reset through history, reload, logout and expiry`, async ({ page, context }) => {
    await page.goto(`/?section=${section === 'temporary' ? 'basal&view=temporary' : section}&day=2042-03-05`)
    await signIn(page)
    const field = (name: string) => page.getByLabel(name, { exact: true })
    const button = (name: string) => page.getByRole('button', { name, exact: true })
    async function fill() {
      if (section === 'diary') {
        await field('Сахар, ммоль/л').fill('8,7')
        await field('Подколка, ед.').fill('1,2')
        await field('Комментарий').fill('Несохранённый ввод')
      } else if (section === 'nutrition') {
        await button('Добавить разовую еду').click()
        await field('Название строки 1').fill('Несохранённая еда')
        await expect(page.getByLabel('Категория приёма')).toHaveCount(0)
        await field('Объём воды, мл').fill('321')
        await button('Настроить кнопки воды').click()
        await field('Объёмы кнопок воды, мл').fill('123, 456')
      } else if (section === 'catalog') {
        await button('Новый продукт').click()
        await field('Название продукта').fill('Несохранённый продукт')
        await button('Добавить порцию').click()
        await field('Название порции 1').fill('Несохранённая порция')
        await field('Количество порции 1, г').fill('42')
      } else if (section === 'basal') {
        await field('Скорость 1, ед/ч').fill('0,42')
        await button('Добавить интервал').click()
      } else {
        await field('Процент от расписания').fill('142')
        await field('Длительность, мин').fill('42')
      }
    }
    async function cleared() {
      if (section === 'diary') {
        for (const name of ['Сахар, ммоль/л', 'Подколка, ед.', 'Комментарий']) await expect(field(name)).toHaveValue('')
      } else if (section === 'nutrition') {
        await expect(field('Название строки 1')).toHaveCount(0)
        await expect(page.getByLabel('Категория приёма')).toHaveCount(0)
        await expect(field('Объём воды, мл')).toHaveValue('')
        await expect(field('Объёмы кнопок воды, мл')).toHaveCount(0)
      } else if (section === 'catalog') {
        await expect(field('Название продукта')).toHaveCount(0)
        await expect(field('Название порции 1')).toHaveCount(0)
      } else if (section === 'basal') {
        await expect(field('Скорость 1, ед/ч')).toHaveValue('')
        await expect(field('Скорость 2, ед/ч')).toHaveCount(0)
      } else {
        await expect(field('Процент от расписания')).toHaveValue('100')
        await expect(field('Длительность, мин')).toHaveValue('60')
      }
    }
    let writes = 0
    page.on('request', request => {
      if (['POST', 'PUT'].includes(request.method()) && !request.url().includes('/auth/')) writes++
    })
    await fill()
    await page.getByRole('link', { name: 'Настройки', exact: true }).click()
    await page.goBack()
    await cleared()
    await page.goForward()
    await page.goBack()
    await cleared()
    await fill()
    await page.reload()
    await cleared()
    await fill()
    await button('Выйти').click()
    await signIn(page)
    await cleared()
    await fill()
    await context.clearCookies()
    await page.getByRole('link', { name: 'Календарь', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Вход в дневник' })).toBeVisible()
    await page.goBack()
    await signIn(page)
    await cleared()
    expect(writes).toBe(0)
  })
}

for (const kind of ['entries', 'meals', 'water', 'products', 'temporary-basals'] as const) {
  test(`${kind}: leaving an edit discards changes without changing the saved record`, async ({ page, context }, info) => {
    const day = info.project.name === 'phone' ? '2045-03-05' : '2044-03-05'
    const name = `Исходная запись ${crypto.randomUUID()}`
    const section = { entries: 'diary', meals: 'nutrition', water: 'nutrition', products: 'catalog', 'temporary-basals': 'basal&view=temporary' }[kind]
    await page.goto(`/?section=${section}&day=${day}`)
    await signIn(page)
    const headers = { Origin: 'https://localhost:5173', 'X-CSRF-Token': (await (await page.request.get('/api/auth/csrf')).json()).csrf_token }
    const values = {
      entries: { glucose: '5.6', bolus: '0.5', comment: name },
      meals: { lines: [{ id: crypto.randomUUID(), kind: 'one_off', name }] },
      water: { volume_ml: 234 },
      products: { name, unit: 'g', photo: null, protein: null, fat: null, carbohydrate: null, calories: null, portions: [{ id: crypto.randomUUID(), name: 'Порция', quantity: '30' }] },
      'temporary-basals': { starts_at: `${day}T10:00:00+03:00`, duration_minutes: 60, percent: 123 },
    }[kind]
    const created = await page.request.post(`/api/${kind}`, { headers, data: {
      operation_id: crypto.randomUUID(), ...(kind !== 'products' && kind !== 'temporary-basals' ? { occurred_at: `${day}T10:00:00+03:00` } : {}), ...values,
    } })
    expect(created.ok(), await created.text()).toBeTruthy()
    const id = (await created.json()).result_id
    const original = await (await page.request.get(`/api/${kind}/${id}`)).json()
    await page.reload()
    for (const exit of ['history', 'reload', 'logout', 'expiry']) {
      if (kind === 'entries') await openSection(page, 'Аналитика сахара')
      if (kind === 'meals' || kind === 'water') await openSection(page, 'Аналитика питания')
      if (kind === 'products') {
        const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) })
        await expect(card).toBeVisible()
        if (!await card.getByRole('button', { name: 'Изменить', exact: true }).isVisible()) await card.locator('summary').click()
        await card.getByRole('button', { name: 'Изменить', exact: true }).click()
        await page.getByLabel('Название продукта', { exact: true }).fill('Несохранённое изменение')
        await page.getByLabel('Количество порции 1, г', { exact: true }).fill('99')
      } else {
        const label = { entries: 'Изменить', meals: 'Изменить приём', water: 'Изменить воду', 'temporary-basals': 'Изменить / завершить' }[kind]
        const row = kind === 'entries' ? page.locator('.entries > .entry').filter({ hasText: name })
          : kind === 'meals' ? page.locator('.meal-history').filter({ hasText: name })
          : kind === 'water' ? page.getByLabel('История воды').getByRole('article') : page.locator('.temporary-history').getByRole('article').filter({ hasText: `${day} · 10:00` })
        await row.getByRole('button', { name: label, exact: true }).click()
        const field = { entries: 'Комментарий', meals: 'Название строки 1', water: 'Объём воды, мл', 'temporary-basals': 'Процент от расписания' }[kind]
        await page.getByLabel(field, { exact: true }).fill(kind === 'water' || kind === 'temporary-basals' ? '999' : 'Несохранённое изменение')
      }
      if (exit === 'history') {
        await page.getByRole('link', { name: 'Настройки', exact: true }).click()
        await page.goBack()
      } else if (exit === 'reload') await page.reload()
      else if (exit === 'logout') {
        await page.getByRole('button', { name: 'Выйти', exact: true }).click()
        await signIn(page)
      } else {
        await context.clearCookies()
        await page.getByRole('link', { name: 'Календарь', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'Вход в дневник' })).toBeVisible()
        await page.goBack()
        await signIn(page)
      }
      if (kind === 'entries') {
        await expect(page.getByLabel('Комментарий', { exact: true })).toBeHidden()
        await expect(page.getByRole('button', { name: 'Сохранить изменения', exact: true })).toHaveCount(0)
      } else if (kind === 'meals') await expect(page.getByLabel('Название строки 1', { exact: true })).toHaveCount(0)
      else if (kind === 'products') await expect(page.getByLabel('Название продукта', { exact: true })).toHaveCount(0)
      else if (kind === 'water') await expect(page.getByLabel('Объём воды, мл', { exact: true })).toBeHidden()
      else await expect(page.getByLabel('Процент от расписания', { exact: true })).toHaveValue('100')
      expect(await (await page.request.get(`/api/${kind}/${id}`)).json()).toEqual(original)
    }
  })
}
