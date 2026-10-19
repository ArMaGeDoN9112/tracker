import { privateFetch } from './access'
import { useEffect, useState } from 'react'

type Status = {
  last_external_success: string | null
  last_local_success: string | null
  last_verification: string | null
  verification_error: string | null
  error: string | null
  overdue: boolean
}

const when = (value: string | null) => value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК' : 'ещё не было'

export function BackupStatus() {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const response = await privateFetch('/api/backup-status', { cache: 'no-store' })
        if (!response.ok) throw new Error()
        const result: Status = await response.json()
        if (!cancelled) { setStatus(result); setError('') }
      } catch {
        if (!cancelled) setError('Не удалось получить состояние резервирования.')
      }
    }
    void load()
    const timer = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])
  return <section aria-labelledby="backup-title">
    <h3 id="backup-title">Резервное копирование</h3>
    {status ? <>
      <p>Последняя успешная внешняя копия: {when(status.last_external_success)}.</p>
      {status.last_local_success && <p>Локальная тестовая копия: {when(status.last_local_success)}. Внешняя доставка не подтверждена этим запуском.</p>}
      <p>Последняя успешная проверка восстановления: {when(status.last_verification)}.</p>
      {status.overdue && <p role="alert" className="error">Нет успешной внешней копии за последние 26 часов. Сохранность последних данных не подтверждена.</p>}
      {status.error && <p role="alert" className="error">{status.error}</p>}
      {status.verification_error && <p role="alert" className="error">{status.verification_error}</p>}
    </> : !error && <p role="status">Проверяем резервирование…</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>
}
