import { createPortal } from 'react-dom'
import { privateFetch } from './access'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { BasalSchedules } from './BasalSchedules'
import { GlucoseCharts } from './GlucoseCharts'
import { DayCalendar } from './DayCalendar'
import { BasalDayChart } from './BasalDayChart'
import { TemporaryBasal, type TemporaryPeriod } from './TemporaryBasal'
import { localMinute, basalText, moscowLabel } from './time'

type Entry = { id: string; occurred_at: string; glucose: string | null; bolus: string; reason: string | null; comment: string; basal: string | null; revision: number; deleted_at: string | null; created_at: string }
type PendingAction = { path: string; body: string; action: 'delete' | 'restore' }
const reasons: Record<string, string> = { food: 'Еда', correction: 'Коррекция', food_and_correction: 'Еда и коррекция' }
const moscowTime = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export function Diary({ active, section, day, temporary, onDay, onView, csrfToken }: { active: boolean; section: string; day: string; temporary: boolean; onDay: (day: string, open?: boolean) => void; onView: (temporary: boolean) => void; csrfToken: () => Promise<string> }) {
  const [localTime, setLocalTime] = useState('')
  const [glucose, setGlucose] = useState('')
  const [bolus, setBolus] = useState('')
  const [reason, setReason] = useState('')
  const [comment, setComment] = useState('')
  const [dayLoading, setDayLoading] = useState(false)
  const [dayError, setDayError] = useState('')
  const [todayLoading, setTodayLoading] = useState(false)
  const [entries, setEntries] = useState<Entry[]>([])
  const [dayBasal, setDayBasal] = useState<string | null>(null)
  const [formBasal, setFormBasal] = useState<string | null>(null)
  const [basalChanges, setBasalChanges] = useState<{ occurred_at: string; basal: string | null }[]>([])
  const [temporaryBasals, setTemporaryBasals] = useState<TemporaryPeriod[]>([])
  const [temporaryPercent, setTemporaryPercent] = useState<number | null>(null)
  const [basalGeneration, setBasalGeneration] = useState(0)
  const [entryGeneration, setEntryGeneration] = useState(0)
  const [busy, setBusy] = useState(false)
  const [saveConfirmed, setSaveConfirmed] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [field, setField] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<string[]>([])
  const [instant, setInstant] = useState('')
  const [pending, setPending] = useState<{ path: string; method: string; body: string } | null>(null)
  const [editing, setEditing] = useState<Entry | null>(null)
  const [conflictId, setConflictId] = useState<string | null>(null)
  const [latest, setLatest] = useState<Entry | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [undo, setUndo] = useState<{ id: string; revision: number; until: number } | null>(null)
  const sending = useRef(false)
  const initialized = useRef(false)
  const dayRequest = useRef(0)
  const selectedDay = useRef(day)
  selectedDay.current = day
  const analysisVisible = useRef(false)
  analysisVisible.current = active && section === 'charts'

  useEffect(() => {
    let cancelled = false
    setFormBasal(null)
    if (!active || (section !== 'diary' && !(section === 'charts' && editing)) || !localTime) return
    async function updateBasal() {
      const result = editing && localTime === localMinute(editing.occurred_at) && !instant
        ? { candidates: [editing.occurred_at] }
        : await request(`/api/moscow-time?local_time=${encodeURIComponent(localTime)}`)
      if (cancelled) return
      const at = instant || (result.candidates.length === 1 ? result.candidates[0] : '')
      if (!at) return
      const resultBasal = await request(`/api/basal?at=${encodeURIComponent(at)}`)
      if (!cancelled) setFormBasal(resultBasal.basal)
    }
    updateBasal().catch(() => { if (!cancelled) setError('Не удалось вычислить базу для выбранного времени.') })
    return () => { cancelled = true }
  }, [active, section, localTime, instant, editing, basalGeneration])

  useEffect(() => {
    if (!undo) return
    const timer = window.setTimeout(() => setUndo(null), Math.max(0, undo.until - performance.now()))
    return () => window.clearTimeout(timer)
  }, [undo])

  function edit(row: Entry) {
    initialized.current = true
    setEditing(row)
    setLocalTime(localMinute(row.occurred_at))
    setGlucose(row.glucose ?? ''); setBolus(row.bolus); setReason(row.reason ?? ''); setComment(row.comment)
    setCandidates([]); setInstant(''); setConflictId(null); setLatest(null); setError(''); setField(null); setNotice('')
    requestAnimationFrame(() => document.getElementById('glucose')?.focus())
  }

  async function cancelEdit() {
    if (sending.current || !active) return
    sending.current = true; setBusy(true)
    const version = formGeneration.current
    try {
      const form = await request('/api/entry-form')
      if (version !== formGeneration.current) return
      setEditing(null); setLocalTime(form.local_time)
      setGlucose(''); setBolus(''); setReason(''); setComment(''); setCandidates([]); setInstant('')
      setConflictId(null); setLatest(null); setError(''); setField(null)
    } finally {
      sending.current = false; setBusy(false)
    }
  }

  async function change(action: PendingAction) {
    if (sending.current || !active) return
    sending.current = true; setBusy(true); setError(''); setField(null); setPendingAction(action)
    let committed = false
    try {
      const csrf = await csrfToken()
      const response = await privateFetch(action.path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: action.body })
      const result = await response.json()
      if (!response.ok) {
        if ([404, 409, 422].includes(response.status)) setPendingAction(null)
        if (result.code === 'revision_conflict') { setConflictId(action.path.split('/')[3]); setLatest(null) }
        if (result.code === 'undo_expired' || (action.action === 'restore' && result.code === 'revision_conflict')) setUndo(null)
        throw new Error(result.message)
      }
      committed = true
      setNotice(action.action === 'delete' ? 'Запись удалена.' : 'Запись восстановлена.')
      setEntryGeneration(value => value + 1)
      if (action.action === 'restore') setUndo(null)
      const updates = await Promise.allSettled([action.action === 'delete' ? (async () => {
        const until = performance.now() + result.undo_remaining_ms
        const current: Entry = await request(`/api/entries/${result.result_id}`)
        setUndo(current.deleted_at !== null && current.revision === result.revision && until > performance.now()
          ? { id: current.id, revision: current.revision, until } : null)
      })() : Promise.resolve(), selectedDay.current ? loadDay(selectedDay.current) : Promise.resolve()])
      if (updates[0].status === 'rejected') setError('Удаление подтверждено сервером, но доступность отмены не удалось проверить. Повторите операцию с прежним UUID.')
      else {
        setPendingAction(null)
        if (updates[1].status === 'rejected') setError('Операция подтверждена сервером, но обновление дня не удалось. Перезагрузите страницу.')
      }
    } catch (failure) {
      setError(committed ? 'Операция подтверждена сервером, но обновление дня не удалось. Перезагрузите страницу.' : failure instanceof Error ? failure.message : 'Ошибка сети. Повторите операцию.')
    } finally {
      sending.current = false; setBusy(false)
    }
  }

  function entryAction(row: { id: string; revision: number }, action: 'delete' | 'restore') {
    return change({ path: `/api/entries/${row.id}/${action}`, action, body: JSON.stringify({ operation_id: crypto.randomUUID(), expected_revision: row.revision }) })
  }

  async function request(path: string, options?: RequestInit) {
    const response = await privateFetch(path, { cache: 'no-store', ...options })
    const result = await response.json()
    if (!response.ok) {
      setField(result.field)
      throw new Error(result.message)
    }
    return result
  }

  async function loadDay(selected: string) {
    if (!analysisVisible.current) return
    const sequence = ++dayRequest.current
    setDayLoading(true); setDayError('')
    try {
      const response = await privateFetch(`/api/day?day=${selected}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('Не удалось загрузить день.')
      const result = await response.json()
      if (sequence === dayRequest.current && selected === selectedDay.current) { setEntries(result.entries); setDayBasal(result.basal); setBasalChanges(result.basal_changes); setTemporaryBasals(result.temporary_basals); setTemporaryPercent(result.temporary_percent) }
    } catch (failure) {
      if (sequence === dayRequest.current) setDayError('Не удалось загрузить день. Перезагрузите страницу.')
      if (sequence === dayRequest.current) throw failure
    } finally {
      if (sequence === dayRequest.current) setDayLoading(false)
    }
  }

  const formGeneration = useRef(0)
  const savedDayNavigation = useRef('')
  const analysisDay = section === 'charts' ? day : ''
  useEffect(() => {
    // A confirmed move changes the day without discarding its success feedback.
    if (active && analysisDay && savedDayNavigation.current === analysisDay) {
      savedDayNavigation.current = ''
      return
    }
    savedDayNavigation.current = ''
    formGeneration.current++
    setGlucose(''); setBolus(''); setReason(''); setComment(''); setLocalTime('')
    setEditing(null); setCandidates([]); setInstant(''); setConflictId(null); setLatest(null)
    setError(''); setField(null); setNotice('')
    initialized.current = false
    if (active && (section === 'diary' || section === 'charts')) openForm().catch(() => setError('Не удалось открыть форму. Повторите подключение.'))
  }, [active, section, analysisDay])

  async function openForm() {
    const version = formGeneration.current
    const result = await request('/api/entry-form')
    if (version !== formGeneration.current) return
    if (!initialized.current) setLocalTime(result.local_time)
    if (!selectedDay.current) onDay(result.local_time.slice(0, 10))
    initialized.current = true
  }

  useEffect(() => {
    ++dayRequest.current
    setEntries([]); setDayBasal(null); setBasalChanges([]); setTemporaryBasals([]); setTemporaryPercent(null)
    if (active && section === 'charts' && day) loadDay(day).catch(() => {})
  }, [active, day, section])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending.current || !active) return
    sending.current = true
    setBusy(true)
    setError('')
    setNotice('')
    setField(null)
    const version = formGeneration.current
    let operation = pending
    let committed = false
    try {
      if (!operation) {
        const result = editing && localTime === localMinute(editing.occurred_at) && !instant
          ? { candidates: [editing.occurred_at] }
          : await request(`/api/moscow-time?local_time=${encodeURIComponent(localTime)}`)
        if (result.candidates.length > 1 && !result.candidates.includes(instant)) {
          setCandidates(result.candidates)
          setField('occurred_at')
          throw new Error('Московское время повторяется. Выберите смещение UTC.')
        }
        const body = JSON.stringify({ operation_id: crypto.randomUUID(), occurred_at: instant || result.candidates[0], glucose: glucose || null, bolus, reason: reason || null, comment, ...(editing ? { expected_revision: editing.revision } : {}) })
        if (version !== formGeneration.current) return
        operation = { path: editing ? `/api/entries/${editing.id}` : '/api/entries', method: editing ? 'PUT' : 'POST', body }
        setPending(operation)
      }
      const csrf = await csrfToken()
      const response = await privateFetch(operation.path, { method: operation.method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: operation.body })
      const result = await response.json()
      if (!response.ok) {
        if ([404, 409, 422].includes(response.status)) setPending(null)
        if (version !== formGeneration.current) return
        if (result.code === 'revision_conflict' && editing) { setConflictId(editing.id); setLatest(null) }
        setField(result.field ?? (response.status === 422 ? 'entry-fields' : null))
        throw new Error(result.message)
      }
      committed = true
      setSaveConfirmed(true)
      setEntryGeneration(value => value + 1)
      const savedDay = localMinute(JSON.parse(operation.body).occurred_at).slice(0, 10)
      if (version === formGeneration.current) {
        if (analysisVisible.current && savedDay !== selectedDay.current) savedDayNavigation.current = savedDay
        onDay(savedDay)
      }
      if (version === formGeneration.current || selectedDay.current === savedDay) await loadDay(savedDay)
      const form = await request('/api/entry-form')
      setPending(null)
      setSaveConfirmed(false)
      if (version !== formGeneration.current) return
      setNotice('Запись сохранена.')
      setEditing(null); setConflictId(null); setLatest(null)
      setGlucose(''); setBolus(''); setReason(''); setComment(''); setCandidates([]); setInstant('')
      setLocalTime(form.local_time)
      initialized.current = true
    } catch (failure) {
      if (version !== formGeneration.current) return
      setError(failure instanceof Error ? failure.message : 'Ошибка сети. Повторите сохранение.')
      if (committed) setError('Запись сохранена, но обновление не удалось. Повторите запрос для проверки.')
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  function adjacentDay(offset: number) {
    const date = new Date(`${day}T12:00:00Z`)
    date.setUTCDate(date.getUTCDate() + offset)
    const next = date.toISOString().slice(0, 10)
    if (/^\d{4}-/.test(next)) onDay(next)
  }

  async function today() {
    const sequence = dayRequest.current
    setTodayLoading(true)
    try {
      const response = await privateFetch('/api/entry-form', { cache: 'no-store' })
      if (!response.ok) throw new Error()
      const form = await response.json()
      if (sequence === dayRequest.current) onDay(form.local_time.slice(0, 10))
    } catch {
      if (sequence === dayRequest.current) setDayError('Не удалось получить сегодняшний день с сервера.')
    } finally { setTodayLoading(false) }
  }

  const invalid = (name: string) => ({ 'aria-invalid': field === name, 'aria-describedby': field === name ? `${name}-error` : undefined })
  const fieldError = (name: string) => field === name && error ? <p id={`${name}-error`} role="alert" className="error field-error">{error}</p> : null
  return <div hidden={!active}>
    <div hidden={section !== 'calendar'}><DayCalendar active={active && section === 'calendar'} day={day} generation={entryGeneration + basalGeneration} onDay={onDay} onAnalysis={selected => onDay(selected, true)} /></div>
    <div hidden={section !== 'charts'}>
    <GlucoseCharts active={active && section === 'charts'} generation={entryGeneration} onDay={selected => {
      onDay(selected, true)
      requestAnimationFrame(() => document.getElementById('day-history')?.focus())
    }} />
    </div>
    <div hidden={section !== 'diary' && section !== 'charts'}>
    {error && !['glucose', 'bolus', 'occurred_at', 'reason', 'comment', 'entry-fields'].includes(field ?? '') && <p id="entry-error" role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="entry-notice">{notice}</p>}
    </div>
    <div hidden={section !== 'diary' && section !== 'charts'} className="diary-layout">
    <section hidden={section !== 'diary' && !editing && !conflictId && pending?.method !== 'PUT'} className="diary-composer" aria-label="Ввод записи">
    <span className="eyebrow">БЫСТРЫЙ ВВОД</span>
    <h2>{editing ? 'Изменение записи' : 'Быстрый ввод'}</h2>
    <div hidden={section === 'charts' && !editing && pending?.method !== 'PUT'}>
    {!localTime ? <button onClick={() => openForm().catch(() => setError('Не удалось подключиться.'))}>Повторить подключение</button> : <form onSubmit={save} aria-busy={busy}>
      <fieldset aria-label="Данные записи" {...invalid('entry-fields')} disabled={busy || pending !== null || pendingAction !== null}>
        <div className="entry-numbers"><div className="glucose-field">
        <label htmlFor="glucose">Сахар, ммоль/л</label>
        <input id="glucose" inputMode="decimal" value={glucose} onChange={e => setGlucose(e.target.value)} {...invalid('glucose')} />
        {fieldError('glucose')}
        </div><div>
        <label htmlFor="bolus">Подколка, ед.</label>
        <input id="bolus" inputMode="decimal" value={bolus} onChange={e => setBolus(e.target.value)} {...invalid('bolus')} />
        {fieldError('bolus')}
        </div></div>
        <label htmlFor="occurred_at">Время события — Москва</label>
        <input id="occurred_at" type="datetime-local" step="60" required value={localTime} onChange={e => { initialized.current = true; setLocalTime(e.target.value); setCandidates([]); setInstant('') }} {...invalid('occurred_at')} />
        {fieldError('occurred_at')}
        {candidates.length > 1 && <><label htmlFor="offset">Смещение UTC</label><select id="offset" required value={instant} onChange={e => setInstant(e.target.value)}><option value="">Выберите смещение</option>{candidates.map(value => <option key={value} value={value}>UTC{value.slice(-6)}</option>)}</select></>}
        <p className="muted" data-testid="form-basal">База: {basalText(formBasal)} · по расписанию</p>
        <label htmlFor="reason">Причина подколки</label>
        <select id="reason" value={reason} onChange={e => setReason(e.target.value)} {...invalid('reason')}><option value="">Без причины</option>{Object.entries(reasons).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        {fieldError('reason')}
        <label htmlFor="comment">Комментарий</label>
        <textarea rows={2} id="comment" value={comment} onChange={e => setComment(e.target.value)} {...invalid('comment')} />
        {fieldError('comment')}
        {fieldError('entry-fields')}
      </fieldset>
      {pending && !busy && <p role="status">{saveConfirmed ? 'Сохранение подтверждено.' : 'Результат запроса неизвестен.'} Повтор отправит те же данные и UUID, без дубликата.</p>}
      <button disabled={busy || pendingAction !== null || conflictId === editing?.id} type="submit">{busy ? 'Сохраняем…' : pending ? 'Повторить сохранение' : editing ? 'Сохранить изменения' : 'Сохранить запись'}</button>
      {editing && <button type="button" disabled={busy || pending !== null || pendingAction !== null} onClick={() => cancelEdit().catch(() => setError('Не удалось открыть форму.'))}>Отменить редактирование</button>}
    </form>}
    </div>
    {conflictId && <button disabled={busy} onClick={() => { const version = formGeneration.current; void request(`/api/entries/${conflictId}`).then(row => { if (version === formGeneration.current) setLatest(row) }).catch(failure => setError(failure.message)) }}>Загрузить актуальную запись</button>}
    {latest && <section aria-label="Актуальная запись">
      <p>Редакция {latest.revision} · {latest.deleted_at ? 'Удалена' : 'Сохранена'} · Москва {localMinute(latest.occurred_at).replace('T', ' ')}</p>
      <p>Сахар: {latest.glucose ?? 'не указан'} · Подколка: {latest.bolus} · Причина: {latest.reason ? reasons[latest.reason] : 'без причины'}</p>
      <p className="comment">{latest.comment}</p>
      {editing?.id === latest.id && !latest.deleted_at && <>
        <button disabled={busy} onClick={() => { setEditing({ ...editing, revision: latest.revision }); setConflictId(null); setLatest(null); setError('') }}>Продолжить с моими значениями</button>
        <button disabled={busy} onClick={() => edit(latest)}>Редактировать актуальную</button>
      </>}
    </section>}
    {pendingAction && !busy && createPortal(<div>{error && section !== 'diary' && section !== 'charts' && <p role="alert" className="error">{error}</p>}<button onClick={() => change(pendingAction)}>Повторить операцию</button></div>, document.getElementById('global-undo')!)}
    {undo && createPortal(<div role="status"><p>Запись удалена. Отмена доступна 30 секунд по времени сервера.</p><button disabled={busy || pending !== null || pendingAction !== null} onClick={() => entryAction(undo, 'restore')}>Отменить удаление</button></div>, document.getElementById('global-undo')!)}
    </section>
    <section hidden={section !== 'charts'} className="diary-timeline" aria-label="Хронология дня">
    <span className="eyebrow">ХРОНОЛОГИЯ · МОСКВА</span>
    <h2 id="day-history" tabIndex={-1}>Записи дня <span className="entry-count">{entries.length}</span></h2>
    {!localTime && error && <button onClick={() => openForm().then(() => setError('')).catch(() => setError('Не удалось открыть форму. Повторите подключение.'))}>Повторить подключение</button>}
    <label htmlFor="day">День — Москва</label>
    <input id="day" type="date" value={day} onChange={e => { if (e.target.value) onDay(e.target.value) }} />
    <div className="day-navigation">
      <button type="button" disabled={!day || day === '0001-01-01'} onClick={() => adjacentDay(-1)}>Предыдущий день</button>
      <button type="button" disabled={todayLoading} onClick={today}>{todayLoading ? 'Получаем сегодня…' : 'Сегодня'}</button>
      <button type="button" disabled={!day || day === '9999-12-31'} onClick={() => adjacentDay(1)}>Следующий день</button>
    </div>
    {dayLoading && <p role="status">Загружаем день…</p>}
    {dayError && <p role="alert" className="error">{dayError}</p>}
    <div hidden={dayLoading || !!dayError}>
    <div className="day-basal-overview"><p data-testid="day-basal">База на начало дня: <strong>{basalText(dayBasal)}</strong> · по расписанию</p>
    <p data-testid="day-temporary-basal">На начало дня: <span className="status-badge">{temporaryPercent === null ? 'обычное расписание' : `временная база ${temporaryPercent}% от расписания`}</span></p></div>
    <details className="explanation"><summary>График базы за день</summary><BasalDayChart basal={dayBasal} changes={basalChanges} /></details>
    <section className="day-temporary" aria-label="Временная база дня" hidden={temporaryBasals.length === 0}>
      {temporaryBasals.map(row => <article key={row.id}>
        <p>Временная база {row.percent}% · с {moscowLabel(row.starts_at)} · по расписанию</p>
        <details className="explanation"><summary>Параметры периода</summary><p>Исходная длительность: {row.duration_minutes} мин. Заданное окончание: {moscowLabel(row.ends_at)}.</p>
        <p>Эффективное окончание: {moscowLabel(row.effective_ends_at)} (не включая).</p></details>
      </article>)}
    </section>
    <ol className="entries">{[...entries.map(row => ({ kind: 'entry' as const, row, occurred_at: row.occurred_at })),
      ...basalChanges.map(change => ({ kind: 'basal' as const, row: change, occurred_at: change.occurred_at }))]
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || (a.kind === b.kind ? 0 : a.kind === 'basal' ? -1 : 1))
      .map(item => {
        if (item.kind === 'basal') return <li className="basal-change" key={`basal-${item.occurred_at}`}>
        <time dateTime={item.occurred_at}>{moscowTime.format(new Date(item.occurred_at))}</time>
        <p>Изменение базы: {basalText(item.row.basal)} · по расписанию</p>
      </li>
        const row = item.row
        return <li className="entry" key={row.id}>
      <time dateTime={row.occurred_at}>{moscowTime.format(new Date(row.occurred_at))}</time>
      <div className="entry-values"><p className="entry-glucose"><span>Сахар: </span><strong>{row.glucose?.replace('.', ',') ?? 'не указан'}</strong><small>ммоль/л</small></p><p className="entry-bolus">Подколка: <strong>{row.bolus.replace('.', ',')}</strong> ед.</p></div>
      {row.reason && <p><span className="status-badge">{reasons[row.reason]}</span></p>}
      {row.comment && <p className="comment">{row.comment}</p>}
      <p className="muted">База: {basalText(row.basal)} · по расписанию</p>
      <p className="muted">Создана: {moscowLabel(row.created_at)}</p>
      <div className="entry-actions"><button disabled={busy || pending !== null || pendingAction !== null || editing !== null} onClick={() => edit(row)}>Изменить</button>
      <button disabled={busy || pending !== null || pendingAction !== null || editing !== null} onClick={() => entryAction(row, 'delete')}>Удалить</button></div>
    </li> })}</ol>
    {day && !dayLoading && !dayError && entries.length === 0 && <p>Записей нет.</p>}
    </div>
    </section>
    </div>
    <div hidden={section !== 'basal'}>
      <nav className="basal-nav" aria-label="Представления базы">
        <a href={`?section=basal${day ? `&day=${day}` : ''}`} aria-current={!temporary ? 'page' : undefined} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); onView(false) } }}>Расписание</a>
        <a href={`?section=basal&view=temporary${day ? `&day=${day}` : ''}`} aria-current={temporary ? 'page' : undefined} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); onView(true) } }}>Временная база</a>
      </nav>
    <div hidden={temporary}>
    <BasalSchedules active={active} visible={section === 'basal' && !temporary} csrfToken={csrfToken} onSaved={async () => {
      setBasalGeneration(value => value + 1)
      if (selectedDay.current) await loadDay(selectedDay.current)
    }} />
    </div>
    <div hidden={!temporary}>
    <TemporaryBasal active={active} visible={section === 'basal' && temporary} csrfToken={csrfToken} onSaved={async () => {
      setBasalGeneration(value => value + 1)
      if (selectedDay.current) await loadDay(selectedDay.current)
    }} />
    </div>
    </div>
  </div>
}
