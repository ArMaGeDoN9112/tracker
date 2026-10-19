import { privateFetch } from './access'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { moscowLabel } from './time'

type Version = { id: string; starts_at: string; ends_at: string | null; intervals: { minute: number; rate: string }[] }
type Preview = { startsAt: string; endsAt: string | null }
const clock = (minute: number) => `${Math.floor(minute / 60).toString().padStart(2, '0')}:${(minute % 60).toString().padStart(2, '0')}`

export function BasalSchedules({ active, initialTime, csrfToken, onSaved }: {
  active: boolean; initialTime: string; csrfToken: () => Promise<string>; onSaved: () => Promise<void>
}) {
  const [versions, setVersions] = useState<Version[]>([])
  const [start, setStart] = useState('')
  const [intervals, setIntervals] = useState([{ time: '00:00', rate: '' }])
  const [candidates, setCandidates] = useState<string[]>([])
  const [instant, setInstant] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [field, setField] = useState<string | null>(null)
  const [existingId, setExistingId] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const sending = useRef(false)

  async function request(path: string, options?: RequestInit) {
    const response = await privateFetch(path, { cache: 'no-store', ...options })
    const result = await response.json()
    if (!response.ok) {
      setField(result.field)
      if (result.existing_id) { setExistingId(result.existing_id); await loadHistory() }
      if ([409, 422].includes(response.status)) setPending(null)
      throw new Error(result.message)
    }
    return result
  }

  async function loadHistory(): Promise<Version[]> {
    const history: Version[] = await request('/api/basal-schedules')
    setVersions(history)
    return history
  }

  useEffect(() => {
    if (active) loadHistory().catch(() => setError('Не удалось загрузить историю расписаний. Обновите историю.'))
  }, [active])

  useEffect(() => {
    if (!start && initialTime) setStart(initialTime)
  }, [initialTime])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending.current) return
    sending.current = true; setBusy(true); setError(''); setField(null); setExistingId(null); setSaved(false)
    try {
      if (!preview && !pending) {
        const result = await request(`/api/moscow-time?local_time=${encodeURIComponent(start)}`)
        setCandidates(result.candidates)
        if (result.candidates.length > 1 && !result.candidates.includes(instant)) {
          setField('starts_at')
          throw new Error('Московское время повторяется. Выберите смещение UTC.')
        }
        const startsAt = instant || result.candidates[0]
        const history = await loadHistory()
        const next = history.find(version => Date.parse(version.starts_at) > Date.parse(startsAt))
        setPreview({ startsAt, endsAt: next?.starts_at ?? null })
      } else {
        const body = pending ?? JSON.stringify({ operation_id: crypto.randomUUID(), starts_at: preview!.startsAt,
          intervals: intervals.map(interval => ({ minute: Number(interval.time.slice(0, 2)) * 60 + Number(interval.time.slice(3)), rate: interval.rate })) })
        setPending(body)
        const csrf = await csrfToken()
        await request('/api/basal-schedules', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body })
        await loadHistory()
        await onSaved()
        setPending(null); setPreview(null); setSaved(true)
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Ошибка сети. Повторите сохранение расписания.')
    } finally {
      sending.current = false; setBusy(false)
    }
  }

  const invalid = (name: string) => ({ 'aria-invalid': field === name, 'aria-describedby': field === name ? 'schedule-error' : undefined })
  return <section className="basal-schedules" aria-label="Расписание базы">
    <h2>Суточное расписание базы</h2>
    <p>Каждое сохранение создаёт полную неизменяемую версию. Сохранённые версии нельзя редактировать или удалять; для изменения выберите другое начало.</p>
    <form onSubmit={submit} onChange={() => { setPreview(null); setSaved(false) }} aria-busy={busy}>
      <fieldset disabled={busy || pending !== null}>
        <label htmlFor="schedule-start">Начало расписания — Москва</label>
        <input id="schedule-start" type="datetime-local" step="60" required value={start} onChange={e => { setStart(e.target.value); setCandidates([]); setInstant('') }} {...invalid('starts_at')} />
        {candidates.length > 1 && <><label htmlFor="schedule-offset">Смещение UTC расписания</label><select id="schedule-offset" required value={instant} onChange={e => setInstant(e.target.value)}><option value="">Выберите смещение</option>{candidates.map(value => <option key={value} value={value}>UTC{value.slice(-6)}</option>)}</select></>}
        {intervals.map((interval, index) => <div key={index}>
          <label htmlFor={`interval-${index}`}>Начало интервала {index + 1}</label>
          <input id={`interval-${index}`} type="time" step="60" required readOnly={index === 0} value={interval.time} onChange={e => setIntervals(intervals.map((row, i) => i === index ? { ...row, time: e.target.value } : row))} {...invalid('intervals')} />
          <label htmlFor={`rate-${index}`}>Скорость {index + 1}, ед/ч</label>
          <input id={`rate-${index}`} inputMode="decimal" required value={interval.rate} onChange={e => setIntervals(intervals.map((row, i) => i === index ? { ...row, rate: e.target.value } : row))} {...invalid('rate')} />
          {index > 0 && <button type="button" onClick={() => { setIntervals(intervals.filter((_, i) => i !== index)); setPreview(null) }}>Убрать интервал {index + 1}</button>}
        </div>)}
        <button type="button" disabled={intervals.length >= 1440} onClick={() => { setIntervals([...intervals, { time: '', rate: '' }]); setPreview(null) }}>Добавить интервал</button>
      </fieldset>
      {preview && <p role="status">Затрагиваемый период: с {moscowLabel(preview.startsAt)} до {preview.endsAt ? `${moscowLabel(preview.endsAt)} (не включая)` : 'следующей версии (сейчас не задана)'}. Более раннее время не меняется. База уже внесённых событий в этом периоде будет пересчитана.</p>}
      {pending && !busy && <p role="status">Результат сохранения нужно проверить. Повтор использует те же данные и UUID.</p>}
      <button type="submit" disabled={busy}>{pending ? 'Повторить сохранение расписания' : preview ? 'Сохранить расписание' : 'Проверить период'}</button>
    </form>
    {error && <p id="schedule-error" role="alert" className="error">{error}</p>}
    {existingId && <a href={`#schedule-${existingId}`}>Открыть существующую версию</a>}
    {saved && <p role="status">Расписание сохранено. История и база дня обновлены.</p>}
    <div aria-label="История расписаний">
      <h3>История расписаний</h3>
      <button type="button" disabled={busy} onClick={() => loadHistory().catch(() => setError('Не удалось загрузить историю.'))}>Обновить историю</button>
      {versions.length === 0 && <p>Расписание ещё не задано.</p>}
      {versions.map(version => <article id={`schedule-${version.id}`} key={version.id} tabIndex={-1}>
        <h4>С <time dateTime={version.starts_at}>{moscowLabel(version.starts_at)}</time></h4>
        <p>До {version.ends_at ? `${moscowLabel(version.ends_at)} (не включая)` : 'следующей версии (не задана)'}</p>
        <ul>{version.intervals.map((interval, index) => <li key={interval.minute}>{clock(interval.minute)}–{index + 1 < version.intervals.length ? clock(version.intervals[index + 1].minute) : '00:00 следующего дня'}: {interval.rate.replace('.', ',')} ед/ч · по расписанию</li>)}</ul>
      </article>)}
    </div>
  </section>
}
