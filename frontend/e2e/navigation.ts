import type { Page } from '@playwright/test'

export async function openSection(page: Page, title: string) {
  const destinations: Record<string, [string, string, string]> = {
    'Ввод сахара': ['Диабет', 'Страницы диабета', 'Ввод'],
    'Аналитика сахара': ['Диабет', 'Страницы диабета', 'Анализ'],
    'База': ['Диабет', 'Страницы диабета', 'База'],
    'Ввод питания': ['Питание', 'Страницы питания', 'Ввод'],
    'Аналитика питания': ['Питание', 'Страницы питания', 'Анализ'],
    'Каталог': ['Питание', 'Страницы питания', 'Каталог'],
  }
  const destination = destinations[title]
  if (!destination) {
    await page.getByRole('link', { name: title, exact: true }).click()
    return
  }
  const [group, navigation, label] = destination
  const pages = page.getByRole('navigation', { name: navigation, exact: true })
  if (!await pages.isVisible()) {
    await page.getByRole('link', { name: group, exact: true }).click()
    if (label === 'Ввод') return
  }
  await pages.getByRole('link', { name: label, exact: true }).click()
}
