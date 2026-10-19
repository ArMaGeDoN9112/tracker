import { test, expect } from '@playwright/test'

test('settings show backup delay, local-only copy and sanitized failure', async ({ page }) => {
  await page.route('**/api/backup-status', route => route.fulfill({ json: {
    last_external_success: null, last_local_success: '2026-10-19T00:00:00Z',
    last_verification: '2026-10-19T01:00:00Z', overdue: true,
    error: 'Запуск не завершён: проверьте хранилище.', verification_error: 'Проверка восстановления не прошла.',
  } }))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Резервное копирование' })).toHaveCount(0)
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByLabel('Комментарий', { exact: true }).fill('Черновик перед проверкой копий')
  await page.getByRole('link', { name: 'Проверить резервирование' }).click()
  const backup = page.getByRole('region', { name: 'Резервное копирование' })
  await expect(backup).toContainText('внешняя копия: ещё не было')
  await expect(backup).toContainText('Локальная тестовая копия')
  await expect(backup).toContainText('19.10.2026, 03:00:00 МСК')
  await expect(backup.getByRole('alert')).toHaveCount(3)
  await expect(backup).toContainText('26 часов')
  await expect(backup).toContainText('Проверка восстановления не прошла')
  await page.getByRole('link', { name: 'Дневник', exact: true }).click()
  await expect(page.getByLabel('Комментарий', { exact: true })).toHaveValue('Черновик перед проверкой копий')
})

test('one backup state refreshes each minute and becomes unknown after a read failure', async ({ page }) => {
  await page.clock.install()
  let reads = 0
  let fail = false
  await page.route('**/api/backup-status', route => {
    reads++
    return fail ? route.abort('failed') : route.fulfill({ json: {
      last_external_success: '2026-10-19T12:00:00Z', last_local_success: null,
      last_verification: '2026-10-19T13:00:00Z', overdue: false, error: null, verification_error: null,
    } })
  })
  await page.goto('/')
  expect(reads).toBe(0)
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect.poll(() => reads).toBe(1)
  await expect(page.getByRole('link', { name: 'Проверить резервирование' })).toHaveCount(0)
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  const backup = page.getByRole('region', { name: 'Резервное копирование' })
  await expect(backup).toContainText('19.10.2026, 15:00:00 МСК')
  expect(reads).toBe(1)
  fail = true
  await page.clock.fastForward(60001)
  await expect(backup).toContainText('Состояние резервирования неизвестно')
  await expect(backup).not.toContainText('19.10.2026, 15:00:00 МСК')
  await page.getByRole('link', { name: 'Дневник', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Проверить резервирование' })).toBeVisible()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Вход в дневник' })).toBeVisible()
  await page.clock.fastForward(120001)
  expect(reads).toBe(2)
})

test('delayed older backup success cannot replace a newer unknown state', async ({ page }) => {
  await page.clock.install()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let reads = 0
  await page.route('**/api/backup-status', async route => {
    if (++reads > 1) { await route.abort('failed'); return }
    await gate
    await route.fulfill({ json: { last_external_success: '2026-10-19T12:00:00Z', last_local_success: null,
      last_verification: null, overdue: false, error: null, verification_error: null } })
  })
  await page.goto('/?section=settings')
  await page.getByLabel('Логин', { exact: true }).fill('synthetic-owner')
  await page.getByLabel('Пароль', { exact: true }).fill('😀'.repeat(600))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const backup = page.getByRole('region', { name: 'Резервное копирование' })
  await expect(backup.getByRole('status')).toContainText('Проверяем резервирование')
  await page.clock.fastForward(60001)
  await expect(backup).toContainText('Состояние резервирования неизвестно')
  const previous = page.waitForResponse('**/api/backup-status')
  release()
  await previous
  await page.clock.runFor(32)
  await expect(backup).toContainText('Состояние резервирования неизвестно')
  await expect(backup).not.toContainText('19.10.2026')
})
