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
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  const backup = page.getByRole('region', { name: 'Резервное копирование' })
  await expect(backup).toContainText('внешняя копия: ещё не было')
  await expect(backup).toContainText('Локальная тестовая копия')
  await expect(backup).toContainText('19.10.2026, 03:00:00 МСК')
  await expect(backup.getByRole('alert')).toHaveCount(3)
  await expect(backup).toContainText('26 часов')
  await expect(backup).toContainText('Проверка восстановления не прошла')
})
