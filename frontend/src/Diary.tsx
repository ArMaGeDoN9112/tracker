import { useEffect, useRef, useState, type FormEvent } from 'react'

type Entry = { id: string; occurred_at: string; glucose: string | null; bolus: string; reason: string | null; comment: string; basal: string | null; revision: number; deleted_at: string | null }
type PendingAction = { path: string; body: string; action: 'delete' | 'restore' }
const reasons: Record<string, string> = { food: 'Еда', correction: 'Коррекция', food_and_correction: 'Еда и коррекция' }
const moscowTime = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })
const moscowDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
function localMinute(value: string) {
  const parts = Object.fromEntries(moscowDate.formatToParts(new Date(value)).map(part => [part.type, part.value]))
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

export function Diary({ active, expired, csrfToken }: { active: boolean; expired: () => void; csrfToken: () => Promise<string> }) {
  const [localTime, setLocalTime] = useState('')
  const [glucose, setGlucose] = useState('')
  const [bolus, setBolus] = useState('')
  const [reason, setReason] = useState('')
  const [comment, setComment] = useState('')
  const [day, setDay] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [field, setField] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<string[]>([])
  const [instant, setInstant] = useState('')
  const [pending, setPending] = useState<string | null>(null)
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

  useEffect(() => {
    if (!undo) return
    const timer = window.setTimeout(() => setUndo(null), Math.max(0, undo.until - performance.now()))
    return () => window.clearTimeout(timer)
  }, [undo])

  function edit(row: Entry) {
    setEditing(row)
    setLocalTime(localMinute(row.occurred_at))
    setGlucose(row.glucose ?? ''); setBolus(row.bolus); setReason(row.reason ?? ''); setComment(row.comment)
    setCandidates([]); setInstant(''); setConflictId(null); setLatest(null); setError(''); setField(null)
    document.getElementById('glucose')?.focus()
  }

  async function cancelEdit() {
    if (sending.current) return
    sending.current = true; setBusy(true)
    try {
      const form = await request('/api/entry-form')
      setEditing(null); setLocalTime(form.local_time)
      setGlucose(''); setBolus(''); setReason(''); setComment(''); setCandidates([]); setInstant('')
      setConflictId(null); setLatest(null); setError(''); setField(null)
    } finally {
      sending.current = false; setBusy(false)
    }
  }

  async function change(action: PendingAction) {
    if (sending.current) return
    sending.current = true; setBusy(true); setError(''); setField(null); setPendingAction(action)
    try {
      const csrf = await csrfToken()
      const response = await fetch(action.path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: action.body })
      const result = await response.json()
      if (!response.ok) {
        if (response.status === 401) expired()
        if ([404, 409, 422].includes(response.status)) setPendingAction(null)
        if (result.code === 'revision_conflict') { setConflictId(action.path.split('/')[3]); setLatest(null) }
        if (result.code === 'undo_expired') setUndo(null)
        throw new Error(result.message)
      }
      setPendingAction(null)
      if (action.action === 'delete') setUndo({ id: result.result_id, revision: result.revision, until: performance.now() + result.undo_remaining_ms })
      else setUndo(null)
      if (selectedDay.current) await loadDay(selectedDay.current)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Ошибка сети. Повторите операцию.')
    } finally {
      sending.current = false; setBusy(false)
    }
  }

  function entryAction(row: { id: string; revision: number }, action: 'delete' | 'restore') {
    return change({ path: `/api/entries/${row.id}/${action}`, action, body: JSON.stringify({ operation_id: crypto.randomUUID(), expected_revision: row.revision }) })
  }

  async function request(path: string, options?: RequestInit) {
    const response = await fetch(path, { cache: 'no-store', ...options })
    const result = await response.json()
    if (!response.ok) {
      setField(result.field)
      if (response.status === 401) expired()
      throw new Error(result.message)
    }
    return result
  }

  async function loadDay(selected: string) {
    const sequence = ++dayRequest.current
    const result = await request(`/api/day?day=${selected}`)
    if (sequence === dayRequest.current) setEntries(result.entries)
  }

  async function openForm() {
    const result = await request('/api/entry-form')
    setLocalTime(result.local_time)
    setDay(result.local_time.slice(0, 10))
    initialized.current = true
    await loadDay(result.local_time.slice(0, 10))
  }

  useEffect(() => {
    if (active && !initialized.current) {
      openForm().catch(() => setError('Не удалось открыть форму. Повторите подключение.'))
    }
    // The draft and its operation UUID stay mounted while the user signs in again.
  }, [active])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setError('')
    setField(null)
    let body = pending
    let committed = false
    try {
      if (!body) {
        const result = editing && localTime === localMinute(editing.occurred_at) && !instant
          ? { candidates: [editing.occurred_at] }
          : await request(`/api/moscow-time?local_time=${encodeURIComponent(localTime)}`)
        if (result.candidates.length > 1 && !result.candidates.includes(instant)) {
          setCandidates(result.candidates)
          setField('occurred_at')
          throw new Error('Московское время повторяется. Выберите смещение UTC.')
        }
        body = JSON.stringify({ operation_id: crypto.randomUUID(), occurred_at: instant || result.candidates[0], glucose: glucose || null, bolus, reason: reason || null, comment, ...(editing ? { expected_revision: editing.revision } : {}) })
        setPending(body)
      }
      const csrf = await csrfToken()
      const response = await fetch(editing ? `/api/entries/${editing.id}` : '/api/entries', { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body })
      const result = await response.json()
      if (!response.ok) {
        if (response.status === 401) expired()
        if ([404, 409, 422].includes(response.status)) setPending(null)
        if (result.code === 'revision_conflict' && editing) { setConflictId(editing.id); setLatest(null) }
        setField(result.field)
        throw new Error(result.message)
      }
      committed = true
      const savedDay = localTime.slice(0, 10)
      setDay(savedDay)
      await loadDay(savedDay)
      const form = await request('/api/entry-form')
      setPending(null)
      setEditing(null); setConflictId(null); setLatest(null)
      setGlucose(''); setBolus(''); setReason(''); setComment(''); setCandidates([]); setInstant('')
      setLocalTime(form.local_time)
      initialized.current = true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Ошибка сети. Повторите сохранение.')
      if (committed) setError('Запись сохранена, но обновление не удалось. Повторите запрос для проверки.')
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  const invalid = (name: string) => ({ 'aria-invalid': field === name, 'aria-describedby': field === name ? 'entry-error' : undefined })
  return <div hidden={!active}>
    <h2>{editing ? 'Изменение записи' : 'Быстрый ввод'}</h2>
    {!localTime ? <button onClick={() => openForm().catch(() => setError('Не удалось подключиться.'))}>Повторить подключение</button> : <form onSubmit={save} aria-busy={busy}>
      <fieldset disabled={busy || pending !== null || pendingAction !== null}>
        <label htmlFor="glucose">Сахар, ммоль/л</label>
        <input id="glucose" inputMode="decimal" autoFocus value={glucose} onChange={e => setGlucose(e.target.value)} {...invalid('glucose')} />
        <label htmlFor="occurred_at">Время события — Москва</label>
        <input id="occurred_at" type="datetime-local" step="60" required value={localTime} onChange={e => { setLocalTime(e.target.value); setCandidates([]); setInstant('') }} {...invalid('occurred_at')} />
        {candidates.length > 1 && <><label htmlFor="offset">Смещение UTC</label><select id="offset" required value={instant} onChange={e => setInstant(e.target.value)}><option value="">Выберите смещение</option>{candidates.map(value => <option key={value} value={value}>UTC{value.slice(-6)}</option>)}</select></>}
        <p className="muted">База неизвестна · по расписанию</p>
        <label htmlFor="bolus">Подколка, ед.</label>
        <input id="bolus" inputMode="decimal" value={bolus} onChange={e => setBolus(e.target.value)} {...invalid('bolus')} />
        <label htmlFor="reason">Причина подколки</label>
        <select id="reason" value={reason} onChange={e => setReason(e.target.value)} {...invalid('reason')}><option value="">Без причины</option>{Object.entries(reasons).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <label htmlFor="comment">Комментарий</label>
        <textarea id="comment" value={comment} onChange={e => setComment(e.target.value)} {...invalid('comment')} />
      </fieldset>
      {pending && !busy && <p role="status">Результат запроса нужно проверить. Повтор отправит те же данные и UUID, без дубликата.</p>}
      <button disabled={busy || pendingAction !== null || conflictId === editing?.id} type="submit">{busy ? 'Сохраняем…' : pending ? 'Повторить сохранение' : editing ? 'Сохранить изменения' : 'Сохранить'}</button>
      {editing && <button type="button" disabled={busy || pending !== null || pendingAction !== null} onClick={() => cancelEdit().catch(() => setError('Не удалось открыть форму.'))}>Отменить редактирование</button>}
    </form>}
    {error && <p id="entry-error" role="alert" className="error">{error}</p>}
    {conflictId && <button disabled={busy} onClick={() => request(`/api/entries/${conflictId}`).then(setLatest).catch(failure => setError(failure.message))}>Загрузить актуальную запись</button>}
    {latest && <section aria-label="Актуальная запись">
      <p>Редакция {latest.revision} · {latest.deleted_at ? 'Удалена' : 'Сохранена'} · Москва {localMinute(latest.occurred_at).replace('T', ' ')}</p>
      <p>Сахар: {latest.glucose ?? 'не указан'} · Подколка: {latest.bolus} · Причина: {latest.reason ? reasons[latest.reason] : 'без причины'}</p>
      <p className="comment">{latest.comment}</p>
      {editing?.id === latest.id && !latest.deleted_at && <>
        <button disabled={busy} onClick={() => { setEditing({ ...editing, revision: latest.revision }); setConflictId(null); setLatest(null); setError('') }}>Продолжить с моими значениями</button>
        <button disabled={busy} onClick={() => edit(latest)}>Редактировать актуальную</button>
      </>}
    </section>}
    {pendingAction && !busy && <button onClick={() => change(pendingAction)}>Повторить операцию</button>}
    {undo && <div role="status"><p>Запись удалена. Отмена доступна 30 секунд по времени сервера.</p><button disabled={busy || pending !== null || pendingAction !== null} onClick={() => entryAction(undo, 'restore')}>Отменить удаление</button></div>}
    <h2>Хронология дня</h2>
    <label htmlFor="day">День — Москва</label>
    <input id="day" type="date" disabled={!localTime} value={day} onChange={e => { ++dayRequest.current; setDay(e.target.value); setEntries([]); if (e.target.value) loadDay(e.target.value).catch(() => setError('Не удалось загрузить день.')) }} />
    <button type="button" disabled={!day} onClick={() => loadDay(day).catch(() => setError('Не удалось загрузить день.'))}>Обновить день</button>
    <p className="muted">База на начало дня неизвестна · по расписанию</p>
    <ol className="entries">{entries.map(row => <li key={row.id}>
      <time dateTime={row.occurred_at}>{moscowTime.format(new Date(row.occurred_at))}</time>
      <p>Сахар: {row.glucose?.replace('.', ',') ?? 'не указан'} · Подколка: {row.bolus.replace('.', ',')} ед.</p>
      {row.reason && <p>{reasons[row.reason]}</p>}
      {row.comment && <p className="comment">{row.comment}</p>}
      <p className="muted">База: {row.basal ?? 'неизвестна'} · по расписанию</p>
      <button disabled={busy || pending !== null || pendingAction !== null || editing !== null} onClick={() => edit(row)}>Изменить</button>
      <button disabled={busy || pending !== null || pendingAction !== null || editing !== null} onClick={() => entryAction(row, 'delete')}>Удалить</button>
    </li>)}</ol>
    {day && entries.length === 0 && <p>Записей нет.</p>}
  </div>
}
