import { useEffect, useRef, useState, type FormEvent } from 'react'
import { moscowLabel } from './time'

export type TemporaryPeriod = { id: string; starts_at: string; ends_at: string; effective_ends_at: string; duration_minutes: number; percent: number }
type Preview = { startsAt: string; endsAt: string; effectiveEnd: string; affectedEnd: string }

export function TemporaryBasal({ active, initialTime, expired, csrfToken, onSaved }: {
  active: boolean; initialTime: string; expired: () => void; csrfToken: () => Promise<string>; onSaved: () => Promise<void>
}) {
  const [start, setStart] = useState('')
  const [duration, setDuration] = useState('60')
  const [percent, setPercent] = useState('100')
  const [candidates, setCandidates] = useState<string[]>([])
  const [instant, setInstant] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [field, setField] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const sending = useRef(false)

  useEffect(() => { if (!start && initialTime) setStart(initialTime) }, [initialTime])

  async function request(path: string, options?: RequestInit) {
    const response = await fetch(path, { cache: 'no-store', ...options })
    const result = await response.json()
    if (!response.ok) {
      if (response.status === 401) expired()
      if ([409, 422].includes(response.status)) { setPending(null); setPreview(null) }
      setField(result.field)
      throw new Error(result.message)
    }
    return result
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending.current || !active) return
    sending.current = true; setBusy(true); setError(''); setField(null); setSaved(false)
    try {
      if (!preview && !pending) {
        const result = await request(`/api/moscow-time?local_time=${encodeURIComponent(start)}`)
        setCandidates(result.candidates)
        if (result.candidates.length > 1 && !result.candidates.includes(instant)) {
          setField('starts_at')
          throw new Error('Московское время повторяется. Выберите смещение UTC.')
        }
        const startsAt = instant || result.candidates[0]
        const startMs = Date.parse(startsAt)
        const endMs = startMs + Number(duration) * 60000
        if (!Number.isFinite(endMs) || endMs > Date.parse('9999-12-31T20:59:59.999Z')) throw new Error('Окончание за пределами календаря. Уменьшите длительность.')
        const history: TemporaryPeriod[] = await request('/api/temporary-basals')
        if (history.some(row => Date.parse(row.starts_at) === startMs)) {
          setField('starts_at')
          throw new Error('Начало уже занято временной базой. Выберите другое время.')
        }
        const next = history.find(row => Date.parse(row.starts_at) > startMs)
        const previous = history.filter(row => Date.parse(row.starts_at) < startMs).at(-1)
        const effectiveEnd = Math.min(endMs, next ? Date.parse(next.starts_at) : endMs)
        const affectedEnd = Math.max(effectiveEnd, previous ? Date.parse(previous.effective_ends_at) : effectiveEnd)
        setPreview({ startsAt, endsAt: new Date(endMs).toISOString(), effectiveEnd: new Date(effectiveEnd).toISOString(), affectedEnd: new Date(affectedEnd).toISOString() })
      } else {
        const body = pending ?? JSON.stringify({ operation_id: crypto.randomUUID(), starts_at: preview!.startsAt,
          duration_minutes: Number(duration), percent: Number(percent) })
        setPending(body)
        const csrf = await csrfToken()
        await request('/api/temporary-basals', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body })
        await onSaved()
        setPending(null); setPreview(null); setSaved(true)
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Ошибка сети. Повторите сохранение временной базы.')
    } finally {
      sending.current = false; setBusy(false)
    }
  }

  const invalid = (name: string) => ({ 'aria-invalid': field === name, 'aria-describedby': field === name ? 'temporary-error' : undefined })
  return <section className="basal-schedules" aria-label="Временная база">
    <h2>Временная база</h2>
    <p>100% — обычная скорость, 120% — 1,2 от неё, 0% — нулевая скорость при известном расписании. До первого расписания скорость неизвестна. Все значения — по расписанию.</p>
    <form onSubmit={submit} onChange={() => { setPreview(null); setSaved(false) }} aria-busy={busy}>
      <fieldset disabled={busy || pending !== null}>
        <label htmlFor="temporary-start">Начало временной базы — Москва</label>
        <input id="temporary-start" type="datetime-local" step="60" required value={start} onChange={e => { setStart(e.target.value); setCandidates([]); setInstant('') }} {...invalid('starts_at')} />
        {candidates.length > 1 && <><label htmlFor="temporary-offset">Смещение UTC временной базы</label><select id="temporary-offset" required value={instant} onChange={e => setInstant(e.target.value)}><option value="">Выберите смещение</option>{candidates.map(value => <option key={value} value={value}>UTC{value.slice(-6)}</option>)}</select></>}
        <label htmlFor="temporary-duration">Длительность, мин</label>
        <input id="temporary-duration" type="number" inputMode="numeric" min="1" max="2147483647" step="1" required value={duration} onChange={e => setDuration(e.target.value)} {...invalid('duration_minutes')} />
        <label htmlFor="temporary-percent">Процент от расписания</label>
        <input id="temporary-percent" type="number" inputMode="numeric" min="0" max="2147483647" step="1" required value={percent} onChange={e => setPercent(e.target.value)} {...invalid('percent')} />
      </fieldset>
      {preview && <div role="status">
        <p>Заданное окончание: {moscowLabel(preview.endsAt)}. Эффективное окончание: {moscowLabel(preview.effectiveEnd)}.</p>
        <p>Затрагиваемый период: с {moscowLabel(preview.startsAt)} до {moscowLabel(preview.affectedEnd)} (не включая). Предыдущая временная база прекращается и не возобновляется. После окончания действует обычное расписание, если не началась следующая временная база. Период уточняется при сохранении с учётом других устройств.</p>
      </div>}
      {pending && !busy && <p role="status">Результат сохранения нужно проверить. Повтор использует те же данные и UUID.</p>}
      <button type="submit" disabled={busy}>{pending ? 'Повторить сохранение временной базы' : preview ? 'Сохранить временную базу' : 'Проверить период временной базы'}</button>
    </form>
    {error && <p id="temporary-error" role="alert" className="error">{error}</p>}
    {saved && <p role="status">Временная база сохранена. День и база формы обновлены.</p>}
  </section>
}
