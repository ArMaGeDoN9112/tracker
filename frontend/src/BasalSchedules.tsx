import { privateFetch } from './access'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { moscowLabel } from './time'
import { BasalChart } from './BasalDayChart'

type Version = { id: string; starts_at: string; ends_at: string | null; intervals: { minute: number; rate: string }[] }
type Preview = { startsAt: string; endsAt: string | null }

export function BasalSchedules({ active, visible, csrfToken, onSaved }: {
  active: boolean; visible: boolean; csrfToken: () => Promise<string>; onSaved: () => Promise<void>
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
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const sending = useRef(false)
  const formGeneration = useRef(0)
  const timeInitialized = useRef(false)
  useEffect(() => {
    formGeneration.current++
    timeInitialized.current = false
    setStart(''); setCandidates([]); setInstant(''); setPreview(null); setError(''); setField(null); setSaved(false)
    setIntervals([{ time: '00:00', rate: '' }]); setExistingId(null)
    const version = formGeneration.current
    if (active && visible) void request('/api/entry-form').then(form => {
      if (version === formGeneration.current && !timeInitialized.current) { setStart(form.local_time); timeInitialized.current = true }
    }).catch(() => { if (version === formGeneration.current) setError('Не удалось получить время формы. Перезагрузите страницу.') })
  }, [active, visible])

  async function request(path: string, options?: RequestInit) {
    const response = await privateFetch(path, { cache: 'no-store', ...options })
    const result = await response.json()
    if (!response.ok) {
      setField(result.field)
      if (result.existing_id) { setExistingId(result.existing_id); await loadHistory().catch(() => {}) }
      if ([409, 422].includes(response.status)) setPending(null)
      throw new Error(result.message)
    }
    return result
  }

  async function loadHistory(): Promise<Version[]> {
    setHistoryLoading(true); setHistoryError('')
    try {
      const response = await privateFetch('/api/basal-schedules', { cache: 'no-store' })
      if (!response.ok) throw new Error('Не удалось загрузить историю расписаний.')
      const history: Version[] = await response.json()
      setVersions(history); setHistoryLoaded(true)
      return history
    } catch (failure) {
      setHistoryError('Не удалось загрузить историю расписаний. Перезагрузите страницу.')
      throw failure
    } finally { setHistoryLoading(false) }
  }

  useEffect(() => {
    if (active && visible) loadHistory().catch(() => {})
  }, [active, visible])


  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending.current || !active) return
    sending.current = true; setBusy(true); setError(''); setField(null); setExistingId(null); setSaved(false)
    const version = formGeneration.current
    try {
      if (!preview && !pending) {
        const result = await request(`/api/moscow-time?local_time=${encodeURIComponent(start)}`)
        if (version !== formGeneration.current) return
        setCandidates(result.candidates)
        if (result.candidates.length > 1 && !result.candidates.includes(instant)) {
          setField('starts_at')
          throw new Error('Московское время повторяется. Выберите смещение UTC.')
        }
        const startsAt = instant || result.candidates[0]
        const history = await loadHistory()
        const next = history.find(version => Date.parse(version.starts_at) > Date.parse(startsAt))
        if (version !== formGeneration.current) return
        setPreview({ startsAt, endsAt: next?.starts_at ?? null })
      } else {
        const body = pending ?? JSON.stringify({ operation_id: crypto.randomUUID(), starts_at: preview!.startsAt,
          intervals: intervals.map(interval => ({ minute: Number(interval.time.slice(0, 2)) * 60 + Number(interval.time.slice(3)), rate: interval.rate })) })
        setPending(body)
        const csrf = await csrfToken()
        await request('/api/basal-schedules', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body })
        setPending(null); setPreview(null); setSaved(true)
        const updates = await Promise.allSettled([loadHistory(), onSaved()])
        if (updates.some(update => update.status === 'rejected')) setError('Расписание сохранено, но обновление данных не удалось. Перезагрузите страницу.')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Ошибка сети. Повторите сохранение расписания.')
    } finally {
      sending.current = false; setBusy(false)
    }
  }

  const invalid = (name: string) => ({ 'aria-invalid': field === name, 'aria-describedby': field === name ? 'schedule-error' : undefined })
  function openExisting(event: React.MouseEvent<HTMLAnchorElement>) {
    const version = document.getElementById(`schedule-${existingId}`)?.querySelector('details')
    if (!version) return
    event.preventDefault()
    version.open = true
    version.querySelector('summary')?.focus()
    version.scrollIntoView({ block: 'nearest' })
  }

  return <section className="basal-schedules" aria-label="Расписание базы">
    <div className="schedule-editor">
    <header className="panel-heading"><div><span className="eyebrow">НОВАЯ ВЕРСИЯ</span><h2>Суточное расписание базы</h2></div></header>
    <p className="muted">Версии неизменяемы. Для изменения задайте новое начало и полное расписание.</p>
    <form onSubmit={submit} onChange={() => { setPreview(null); setSaved(false) }} aria-busy={busy}>
      <fieldset disabled={busy || pending !== null}>
        <label htmlFor="schedule-start">Начало расписания — Москва</label>
        <input id="schedule-start" type="datetime-local" step="60" required value={start} onChange={e => { timeInitialized.current = true; setStart(e.target.value); setCandidates([]); setInstant('') }} {...invalid('starts_at')} />
        {candidates.length > 1 && <><label htmlFor="schedule-offset">Смещение UTC расписания</label><select id="schedule-offset" required value={instant} onChange={e => setInstant(e.target.value)}><option value="">Выберите смещение</option>{candidates.map(value => <option key={value} value={value}>UTC{value.slice(-6)}</option>)}</select></>}
        {intervals.map((interval, index) => <div className="schedule-interval" key={index}>
          <div className="schedule-interval-fields"><div>
          <label htmlFor={`interval-${index}`}>Начало интервала {index + 1}</label>
          <input id={`interval-${index}`} type="time" step="60" required readOnly={index === 0} value={interval.time} onChange={e => setIntervals(intervals.map((row, i) => i === index ? { ...row, time: e.target.value } : row))} {...invalid('intervals')} />
          </div><div><label htmlFor={`rate-${index}`}>Скорость {index + 1}, ед/ч</label>
          <input id={`rate-${index}`} inputMode="decimal" required value={interval.rate} onChange={e => setIntervals(intervals.map((row, i) => i === index ? { ...row, rate: e.target.value } : row))} {...invalid('rate')} />
          </div></div>{index > 0 && <button className="schedule-remove" type="button" onClick={() => { setIntervals(intervals.filter((_, i) => i !== index)); setPreview(null) }}>Убрать интервал {index + 1}</button>}
        </div>)}
        <button type="button" disabled={intervals.length >= 1440} onClick={() => { setIntervals([...intervals, { time: '', rate: '' }]); setPreview(null) }}>Добавить интервал</button>
      </fieldset>
      {preview && <p className="schedule-preview" role="status">Затрагиваемый период: с {moscowLabel(preview.startsAt)} до {preview.endsAt ? `${moscowLabel(preview.endsAt)} (не включая)` : 'следующей версии (сейчас не задана)'}. Более раннее время не меняется. База уже внесённых событий в этом периоде будет пересчитана.</p>}
      {pending && !busy && <p role="status">Результат сохранения нужно проверить. Повтор использует те же данные и UUID.</p>}
      <button type="submit" disabled={busy}>{pending ? 'Повторить сохранение расписания' : preview ? 'Сохранить расписание' : 'Проверить период'}</button>
    </form>
    {error && <p id="schedule-error" role="alert" className="error">{error}</p>}
    {existingId && <a href={`#schedule-${existingId}`} onClick={openExisting}>Открыть существующую версию</a>}
    {saved && <p role="status" className="entry-notice">Расписание сохранено.{!busy && !error && ' История и база дня обновлены.'}</p>}
    </div>
    <div className="schedule-history" aria-label="История расписаний" aria-busy={historyLoading}>
      <header className="panel-heading"><div><span className="eyebrow">СРОКИ ДЕЙСТВИЯ</span><h3>История расписаний</h3></div><span className="entry-count">{versions.length}</span></header>
      {historyLoading && <p role="status">Загружаем историю расписаний…</p>}
      {historyError && <p className="error" role="alert">{historyError}</p>}
      {historyLoaded && !historyLoading && !historyError && versions.length === 0 && <p>Расписание ещё не задано.</p>}
      {versions.map(version => <article id={`schedule-${version.id}`} key={version.id}>
        <details><summary>С <time dateTime={version.starts_at}>{moscowLabel(version.starts_at)}</time><span>До {version.ends_at ? `${moscowLabel(version.ends_at)} (не включая)` : 'следующей версии (не задана)'}</span></summary>
        <BasalChart points={version.intervals.map(interval => ({ hour: interval.minute / 60, basal: interval.rate }))} />
        </details>
      </article>)}
    </div>
  </section>
}
