import { privateFetch } from './access'
import { useEffect, useState } from 'react'
import { moscowLabel } from './time'

type Status = {
  last_external_success: string | null
  last_local_success: string | null
  last_verification: string | null
  verification_error: string | null
  error: string | null
  overdue: boolean
}

const when = (value: string | null) => value ? moscowLabel(value) : 'ещё не было'

export function useBackupStatus(active: boolean) {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    if (!active) { setStatus(null); setError(''); return }
    async function load() {
      try {
        const response = await privateFetch('/api/backup-status', { cache: 'no-store' })
        if (!response.ok) throw new Error()
        const result: Status = await response.json()
        if (!cancelled) { setStatus(result); setError('') }
      } catch {
        if (!cancelled) { setStatus(null); setError('Состояние резервирования неизвестно. Не удалось получить состояние резервирования.') }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [active])
  return { status, error }
}

export function BackupStatus({ status, error }: ReturnType<typeof useBackupStatus>) {
  return <section aria-labelledby="backup-title">
    <h3 id="backup-title">Резервное копирование</h3>
    {status ? <>
      <p className={`backup-state${status.overdue || status.error || status.verification_error ? ' needs-attention' : ''}`}><span aria-hidden="true">{status.overdue || status.error || status.verification_error ? '!' : status.last_external_success ? '✓' : '—'}</span> {status.overdue || status.error || status.verification_error ? 'Требует внимания' : status.last_external_success ? 'Внешняя копия создана' : 'Внешней копии ещё нет'}</p>
      <dl className="backup-facts"><div><dt>Последняя успешная внешняя копия: </dt><dd>{when(status.last_external_success)}.</dd></div>
      <div><dt>Последняя успешная проверка восстановления: </dt><dd>{when(status.last_verification)}.</dd></div></dl>
      {status.last_local_success && <p className="muted">Локальная тестовая копия: {when(status.last_local_success)}. Внешняя доставка не подтверждена этим запуском.</p>}
      {status.overdue && <p role="alert" className="error">Нет успешной внешней копии за последние 26 часов. Сохранность последних данных не подтверждена.</p>}
      {status.error && <p role="alert" className="error">{status.error}</p>}
      {status.verification_error && <p role="alert" className="error">{status.verification_error}</p>}
    </> : !error && <p role="status">Проверяем резервирование…</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>
}
