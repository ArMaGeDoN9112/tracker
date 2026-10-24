import { createPortal } from 'react-dom'
import { privateFetch } from './access'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { localMinute, moscowLabel } from './time'

export type TemporaryPeriod = { id: string; starts_at: string; ends_at: string; effective_ends_at: string; duration_minutes: number; percent: number; revision: number; deleted_at: string | null }
type Preview = { startsAt: string; endsAt: string; effectiveEnd: string; affectedStart: string; affectedEnd: string }
type Action = { path: string; method: string; body: string; deleting?: boolean; restoring?: boolean }

export function TemporaryBasal({ active, initialTime, csrfToken, onSaved }: {
  active: boolean; initialTime: string; csrfToken: () => Promise<string>; onSaved: () => Promise<void>
}) {
  const [start, setStart] = useState('')
  const [duration, setDuration] = useState('60')
  const [percent, setPercent] = useState('100')
  const [end, setEnd] = useState('')
  const [endCandidates, setEndCandidates] = useState<string[]>([])
  const [endInstant, setEndInstant] = useState('')
  const [history, setHistory] = useState<TemporaryPeriod[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [editing, setEditing] = useState<TemporaryPeriod | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const [latest, setLatest] = useState<TemporaryPeriod | null>(null)
  const [undo, setUndo] = useState<{ id: string; revision: number; until: number } | null>(null)
  const [candidates, setCandidates] = useState<string[]>([])
  const [instant, setInstant] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [pending, setPending] = useState<Action | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [field, setField] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const sending = useRef(false)

  useEffect(() => { if (!start && initialTime) setStart(initialTime) }, [initialTime])
  useEffect(() => {
    if (active) loadHistory().catch(() => {})
  }, [active])
  useEffect(() => {
    if (!undo) return
    const timer = window.setTimeout(() => setUndo(null), Math.max(0, undo.until - performance.now()))
    return () => window.clearTimeout(timer)
  }, [undo])

  async function loadHistory() {
    setHistoryLoading(true); setHistoryError('')
    try {
      const rows: TemporaryPeriod[] = await request('/api/temporary-basals')
      setHistory(rows); setHistoryLoaded(true)
      return rows
    } catch (failure) {
      setHistoryError('Не удалось загрузить историю временной базы. Перезагрузите страницу.')
      throw failure
    } finally { setHistoryLoading(false) }
  }

  async function loadLatest() {
    try {
      const row = await request(`/api/temporary-basals/${conflict}`)
      await loadHistory()
      setLatest(row)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось загрузить актуальную временную базу.') }
  }

  async function request(path: string, options?: RequestInit) {
    const response = await privateFetch(path, { cache: 'no-store', ...options })
    const result = await response.json()
    if (!response.ok) {
      if ([404, 409, 422].includes(response.status)) { setPending(null); setPreview(null) }
      if (result.code === 'revision_conflict') { setConflict(path.split('/')[3]); setLatest(null) }
      if (response.status === 409 && result.field === 'starts_at') {
        const rows: TemporaryPeriod[] = await loadHistory()
        const requestedStart = JSON.parse(options?.body as string).starts_at ?? editing?.starts_at
        const occupied = rows.find(row => Date.parse(row.starts_at) === Date.parse(requestedStart))
        if (occupied) { setConflict(occupied.id); setLatest(null) }
      }
      if (result.code === 'undo_expired' || (path.endsWith('/restore') && result.code === 'revision_conflict')) setUndo(null)
      setField(result.field)
      throw new Error(result.message)
    }
    return result
  }

  function select(row: TemporaryPeriod, remove = false) {
    setEditing(row); setDeleting(remove); setStart(localMinute(row.starts_at)); setEnd(localMinute(row.ends_at))
    setPercent(String(row.percent)); setCandidates([]); setInstant(''); setEndCandidates([]); setEndInstant('')
    setPreview(null); setError(''); setSaved(false); setConflict(null); setLatest(null)
  }

  function cancel() {
    setEditing(null); setDeleting(false); setStart(initialTime); setPreview(null); setConflict(null); setLatest(null); setCandidates([]); setInstant(''); setEndCandidates([]); setEndInstant('')
  }

  async function save(action: Action) {
    setPending(action)
    const csrf = await csrfToken()
    const result = await request(action.path, { method: action.method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: action.body })
    setSaved(true)
    if (action.restoring) setUndo(null)
    const updates = await Promise.allSettled([action.deleting ? (async () => {
      const until = performance.now() + result.undo_remaining_ms
      const current: TemporaryPeriod = await request(`/api/temporary-basals/${result.result_id}`)
      setUndo(current.deleted_at !== null && current.revision === result.revision && until > performance.now()
        ? { id: current.id, revision: current.revision, until } : null)
    })() : Promise.resolve(), loadHistory(), onSaved()])
    if (updates[0].status === 'rejected') {
      setError('Удаление подтверждено сервером, но доступность отмены не удалось проверить. Повторите сохранение временной базы с прежним UUID.')
      return
    }
    setPending(null); setPreview(null)
    if (editing) cancel()
    if (updates.slice(1).some(update => update.status === 'rejected')) setError('Временная база сохранена, но обновление данных не удалось. Перезагрузите страницу.')
  }

  async function restore() {
    if (sending.current || !undo || !active) return
    sending.current = true; setBusy(true); setError('')
    try {
      await save(pending?.restoring ? pending : { path: `/api/temporary-basals/${undo.id}/restore`, method: 'POST', restoring: true,
        body: JSON.stringify({ operation_id: crypto.randomUUID(), expected_revision: undo.revision }) })
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Ошибка сети. Повторите сохранение временной базы.') }
    finally { sending.current = false; setBusy(false) }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending.current || !active) return
    sending.current = true; setBusy(true); setError(''); setField(null)
    if (!pending) setSaved(false)
    try {
      if (!preview && !pending) {
        async function resolve(value: string, original: string | undefined, chosen: string, isEnd = false): Promise<string> {
          if (original && value === localMinute(original)) return original
          const result = await request(`/api/moscow-time?local_time=${encodeURIComponent(value)}`)
          if (isEnd) setEndCandidates(result.candidates); else setCandidates(result.candidates)
          if (result.candidates.length > 1 && !result.candidates.includes(chosen)) {
            setField(isEnd ? 'ends_at' : 'starts_at')
            throw new Error('Московское время повторяется. Выберите смещение UTC.')
          }
          return chosen || result.candidates[0]
        }
        const startsAt = deleting ? editing!.starts_at : await resolve(start, editing?.starts_at, instant)
        const startMs = Date.parse(startsAt)
        const endMs = editing ? Date.parse(deleting ? editing.ends_at : await resolve(end, editing.ends_at, endInstant, true)) : startMs + Number(duration) * 60000
        if (!Number.isFinite(endMs) || endMs > Date.parse('9999-12-31T20:59:59.999Z')) throw new Error('Окончание за пределами календаря. Уменьшите длительность.')
        if (endMs < startMs) { setField('ends_at'); throw new Error('Окончание не может быть раньше начала.') }
        const history = await loadHistory()
        const occupied = history.find(row => row.id !== editing?.id && Date.parse(row.starts_at) === startMs)
        if (!deleting && occupied) {
          setField('starts_at')
          setConflict(occupied.id); setLatest(null)
          throw new Error('Начало уже занято временной базой. Выберите другое время.')
        }
        const others = history.filter(row => row.id !== editing?.id)
        const next = others.find(row => Date.parse(row.starts_at) > startMs)
        const effectiveEnd = Math.min(endMs, next ? Date.parse(next.starts_at) : endMs)
        const after = (deleting ? others : [...others, { id: editing?.id ?? 'new', starts_at: startsAt, ends_at: new Date(endMs).toISOString() }])
          .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
        const boundaries = editing && !deleting && startMs === Date.parse(editing.starts_at) && Number(percent) === editing.percent
          ? [effectiveEnd, Date.parse(editing.effective_ends_at)]
          : [startMs, effectiveEnd, ...(editing ? [Date.parse(editing.starts_at), Date.parse(editing.effective_ends_at)] : [])]
        const ends = new Map(after.map((row, index) => [row.id, Math.min(Date.parse(row.ends_at), index + 1 < after.length ? Date.parse(after[index + 1].starts_at) : Infinity)]))
        for (const row of others) {
          const newEnd = ends.get(row.id)!
          if (newEnd !== Date.parse(row.effective_ends_at)) boundaries.push(newEnd, Date.parse(row.effective_ends_at))
        }
        setPreview({ startsAt, endsAt: new Date(endMs).toISOString(), effectiveEnd: new Date(effectiveEnd).toISOString(),
          affectedStart: new Date(Math.min(...boundaries)).toISOString(), affectedEnd: new Date(Math.max(...boundaries)).toISOString() })
      } else {
        await save(pending ?? { path: editing ? `/api/temporary-basals/${editing.id}${deleting ? '/delete' : ''}` : '/api/temporary-basals',
          method: editing && !deleting ? 'PUT' : 'POST', deleting,
          body: JSON.stringify({ operation_id: crypto.randomUUID(), ...(editing ? { expected_revision: editing.revision } : {}),
            ...(!deleting ? { starts_at: preview!.startsAt, percent: Number(percent),
              ...(editing ? { ends_at: preview!.endsAt } : { duration_minutes: Number(duration) }) } : {}) }) })
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Ошибка сети. Повторите сохранение временной базы.')
    } finally {
      sending.current = false; setBusy(false)
    }
  }

  const invalid = (name: string) => ({ 'aria-invalid': field === name, 'aria-describedby': field === name ? 'temporary-error' : undefined })
  return <section className="basal-schedules" aria-label="Временная база">
    <div className="schedule-editor">
    <span className="eyebrow">ЗАПИСЬ В ДНЕВНИКЕ</span>
    <h2>Временная база</h2>
    <p className="muted">100% — обычная скорость, 120% — 1,2 от неё, 0% — нулевая скорость при известном расписании. До первого расписания скорость неизвестна. Все значения — по расписанию.</p>
    <form onSubmit={submit} onChange={() => { setPreview(null); setSaved(false) }} aria-busy={busy}>
      {editing && <p>{deleting ? 'Удаление временной базы' : 'Исправление / досрочное завершение временной базы'}. Исходная длительность: {editing.duration_minutes} мин.</p>}
      <fieldset disabled={busy || pending !== null || deleting}>
        <label htmlFor="temporary-start">Начало временной базы — Москва</label>
        <input id="temporary-start" type="datetime-local" step="60" required value={start} onChange={e => { setStart(e.target.value); setCandidates([]); setInstant('') }} {...invalid('starts_at')} />
        {candidates.length > 1 && <><label htmlFor="temporary-offset">Смещение UTC временной базы</label><select id="temporary-offset" required value={instant} onChange={e => setInstant(e.target.value)}><option value="">Выберите смещение</option>{candidates.map(value => <option key={value} value={value}>UTC{value.slice(-6)}</option>)}</select></>}
        {!editing ? <><label htmlFor="temporary-duration">Длительность, мин</label>
        <input id="temporary-duration" type="number" inputMode="numeric" min="1" max="2147483647" step="1" required value={duration} onChange={e => setDuration(e.target.value)} {...invalid('duration_minutes')} />
        </> : <><label htmlFor="temporary-end">Заданное окончание — Москва</label>
          <input id="temporary-end" type="datetime-local" step="60" required value={end} onChange={e => { setEnd(e.target.value); setEndCandidates([]); setEndInstant('') }} {...invalid('ends_at')} />
          {endCandidates.length > 1 && <><label htmlFor="temporary-end-offset">Смещение UTC окончания</label><select id="temporary-end-offset" required value={endInstant} onChange={e => setEndInstant(e.target.value)}><option value="">Выберите смещение</option>{endCandidates.map(value => <option key={value} value={value}>UTC{value.slice(-6)}</option>)}</select></>}
        </>}
        <label htmlFor="temporary-percent">Процент от расписания</label>
        <input id="temporary-percent" type="number" inputMode="numeric" min="0" max="2147483647" step="1" required value={percent} onChange={e => setPercent(e.target.value)} {...invalid('percent')} />
      </fieldset>
      {preview && <div className="schedule-preview" role="status">
        <p>Начало: {moscowLabel(preview.startsAt)}.</p>
        <p>Заданное окончание: {moscowLabel(preview.endsAt)}. Эффективное окончание: {moscowLabel(preview.effectiveEnd)}.</p>
        <p>Затрагиваемый период: с {moscowLabel(preview.affectedStart)} до {moscowLabel(preview.affectedEnd)} (не включая). {deleting ? 'Без удалённой записи действует расписание либо другая временная база, которая действовала бы без неё.' : 'Предыдущая временная база прекращается и не возобновляется. После окончания действует обычное расписание, если не началась следующая временная база.'} Период уточняется при сохранении с учётом других устройств.</p>
      </div>}
      {pending && !busy && <p role="status">{saved ? 'Сохранение подтверждено. Возможность отмены нужно проверить.' : 'Результат сохранения нужно проверить.'} Повтор использует те же данные и UUID.</p>}
      <button type="submit" disabled={busy || conflict !== null}>{pending ? 'Повторить сохранение временной базы' : preview ? deleting ? 'Подтвердить удаление временной базы' : editing ? 'Сохранить изменения временной базы' : 'Сохранить временную базу' : 'Проверить период временной базы'}</button>
    </form>
    {editing && <button disabled={busy || pending !== null} onClick={cancel}>Отменить редактирование</button>}
    {conflict && <button disabled={busy} onClick={loadLatest}>Загрузить актуальную временную базу</button>}
    {latest && <div data-testid="temporary-latest"><p>Актуальная запись: {moscowLabel(latest.starts_at)} — {moscowLabel(latest.ends_at)}, {latest.percent}%, редакция {latest.revision}. {latest.deleted_at ? 'Удалена.' : ''} Ваш ввод оставлен в форме для сравнения.</p>
      {editing && latest.id === editing.id && !latest.deleted_at && <button disabled={busy} onClick={() => { setEditing(latest); setConflict(null); setLatest(null); setPreview(null) }}>Продолжить с актуальной редакцией</button>}
      {editing && latest.id !== editing.id && <button disabled={busy} onClick={() => { setConflict(null); setLatest(null) }}>Закрыть сравнение</button>}
      {!editing && <button disabled={busy} onClick={() => { setConflict(null); setLatest(null); setUndo(null) }}>Закрыть сравнение</button>}
    </div>}
    {undo && createPortal(<div role="status"><p>Временная база удалена. Отмена доступна 30 секунд по времени сервера.</p><button disabled={busy || pending !== null || editing !== null} onClick={restore}>Отменить удаление временной базы</button>{pending?.restoring && !busy && <><p className="error" role="alert">{error}</p><button onClick={restore}>Повторить отмену удаления временной базы</button></>}</div>, document.getElementById('global-undo')!)}
    {error && <p id="temporary-error" role="alert" className="error">{error}</p>}
    {saved && <p role="status" className="entry-notice">Временная база сохранена.{!busy && !error && ' День и база формы обновлены.'}</p>}
    </div>
    <div className="schedule-history temporary-history" aria-label="История временной базы" aria-busy={historyLoading}>
    <span className="eyebrow">ПЕРИОДЫ ДЕЙСТВИЯ</span>
    <h3>История временной базы</h3>
    {historyLoading && <p role="status">Загружаем историю временной базы…</p>}
    {historyError && <p role="alert" className="error">{historyError}</p>}
    {historyLoaded && !historyLoading && !historyError && history.length === 0 && <p>Временная база ещё не задана.</p>}
    {history.map(row => <article key={row.id}>
      <p className="temporary-percent">{row.percent}% <span>· по расписанию</span></p>
      <p className="period-range"><time dateTime={row.starts_at}>{localMinute(row.starts_at).replace('T', ' · ')}</time><span aria-hidden="true">→</span><time dateTime={row.effective_ends_at}>{localMinute(row.effective_ends_at).replace('T', ' · ')}</time></p>
      <details className="explanation"><summary>Параметры периода</summary><p>Начало: {moscowLabel(row.starts_at)}.</p><p className="muted">Эффективное окончание: {moscowLabel(row.effective_ends_at)}.</p>
      <p>Заданное окончание: {moscowLabel(row.ends_at)}. Исходная длительность: {row.duration_minutes} мин.</p></details>
      <div className="entry-actions"><button disabled={busy || pending !== null || editing !== null} onClick={() => select(row)}>Изменить / завершить</button>
      <button disabled={busy || pending !== null || editing !== null} onClick={() => select(row, true)}>Удалить</button>
      </div>
    </article>)}
    </div>
  </section>
}
