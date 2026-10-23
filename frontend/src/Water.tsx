import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { privateFetch } from './access'
import { localMinute, moscowLabel } from './time'

type WaterEvent = { id: string; volume_ml: number; occurred_at: string; revision: number; deleted_at: string | null }
type Settings = { volumes_ml: number[]; revision: number }
type Day = { day: string; water: WaterEvent[]; water_total_ml: number | null }
type Pending = { path: string; method: string; body: string; action: 'save' | 'settings' | 'delete' | 'restore' }

function volume(value: string): number {
  if (!/^[0-9]+$/.test(value.trim())) throw new Error('Введите целые мл от 1 до 2147483647.')
  const result = Number(value)
  if (!Number.isInteger(result) || result < 1 || result > 2147483647) throw new Error('Введите целые мл от 1 до 2147483647.')
  return result
}

export function Water({ authorized, visible, day, csrfToken }: { authorized: boolean; visible: boolean; day: string; csrfToken: () => Promise<string> }) {
  const [amount, setAmount] = useState('')
  const [localTime, setLocalTime] = useState('')
  const [instant, setInstant] = useState('')
  const [candidates, setCandidates] = useState<string[]>([])
  const [editing, setEditing] = useState<WaterEvent | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [buttons, setButtons] = useState('')
  const [settingsRevision, setSettingsRevision] = useState<number | null>(null)
  const [data, setData] = useState<Day | null>(null)
  const [loading, setLoading] = useState(false)
  const [dayError, setDayError] = useState('')
  const [error, setError] = useState('')
  const [field, setField] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<'water' | 'settings' | null>(null)
  const [latestWater, setLatestWater] = useState<WaterEvent | null>(null)
  const [latestSettings, setLatestSettings] = useState<Settings | null>(null)
  const [undo, setUndo] = useState<{ id: string; revision: number; until: number } | null>(null)
  const sending = useRef(false)
  const timeInitialized = useRef(false)
  const generation = useRef(0)
  const selectedDay = useRef(day)
  selectedDay.current = day

  async function read<T,>(path: string): Promise<T> {
    const response = await privateFetch(path)
    const result = await response.json()
    if (!response.ok) throw new Error(result.message)
    return result
  }
  async function loadDay(selected: string) {
    const sequence = ++generation.current
    setLoading(true); setDayError('')
    try {
      const result = await read<Day>(`/api/nutrition-day?day=${selected}`)
      if (sequence === generation.current && selected === selectedDay.current) setData(result)
    } catch (failure) {
      if (sequence === generation.current) setDayError('Не удалось загрузить воду. Перезагрузите страницу.')
      throw failure
    } finally { if (sequence === generation.current) setLoading(false) }
  }
  async function initialize() {
    const result = await read<Settings>('/api/water-settings')
    acceptSettings(result)
    const form = await read<{ local_time: string }>('/api/entry-form')
    if (!timeInitialized.current) {
      setLocalTime(form.local_time); timeInitialized.current = true
    }
  }
  function acceptSettings(value: Settings) {
    setSettings(current => current && current.revision > value.revision ? current : value)
  }
  useEffect(() => {
    if (authorized && visible) void initialize().catch(() => setError('Не удалось загрузить кнопки или время воды. Повторите подключение.'))
  }, [authorized, visible])
  useEffect(() => {
    setData(null)
    if (authorized && visible && day) void loadDay(day).catch(() => {})
    return () => { generation.current++ }
  }, [authorized, visible, day])
  useEffect(() => {
    if (error && authorized && visible) document.getElementById('water-error')?.focus()
  }, [error, authorized, visible])
  useEffect(() => {
    if (!undo) return
    const timer = window.setTimeout(() => setUndo(null), Math.max(0, undo.until - performance.now()))
    return () => window.clearTimeout(timer)
  }, [undo])

  function clear() {
    setAmount(''); setEditing(null); setConflict(null); setLatestWater(null); setInstant(''); setCandidates([])
  }
  function edit(row: WaterEvent) {
    timeInitialized.current = true
    setEditing(row); setAmount(String(row.volume_ml)); setLocalTime(localMinute(row.occurred_at))
    setInstant(''); setCandidates([]); setError(''); setField(null); setConflict(null); setLatestWater(null)
    requestAnimationFrame(() => document.getElementById('water-amount')?.focus())
  }
  async function send(request: Pending) {
    const started = performance.now()
    let committed = confirmed && pending?.body === request.body
    try {
      const csrf = await csrfToken()
      const response = await privateFetch(request.path, { method: request.method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: request.body })
      const result = await response.json()
      if (!response.ok) {
        if ([404, 409, 413, 422].includes(response.status)) { setPending(null); setConfirmed(false) }
        if (result.code === 'revision_conflict' && (request.action === 'save' || request.action === 'settings')) {
          setConflict(request.action === 'settings' ? 'settings' : 'water'); setLatestWater(null); setLatestSettings(null)
        }
        if (result.code === 'undo_expired' || request.action === 'restore' && result.code === 'revision_conflict') setUndo(null)
        setField(result.field ?? null)
        throw new Error(result.message)
      }
      committed = true; setConfirmed(true)
      if (request.action === 'settings') {
        acceptSettings(await read<Settings>('/api/water-settings')); setSettingsOpen(false)
      } else {
        const current = await read<WaterEvent>(`/api/water/${result.result_id}`)
        if (request.action === 'delete') {
          const until = started + result.undo_remaining_ms
          setUndo(current.deleted_at && current.revision === result.revision && until > performance.now() ? { id: current.id, revision: current.revision, until } : null)
        } else if (request.action === 'restore') setUndo(null)
        if (selectedDay.current) await loadDay(selectedDay.current)
        if (request.action === 'save') clear()
      }
      setPending(null); setConfirmed(false); setConflict(null); setLatestWater(null); setLatestSettings(null)
      setNotice(request.action === 'save' ? 'Вода сохранена. Показана актуальная история.' : request.action === 'settings' ? 'Кнопки воды сохранены.' : request.action === 'delete' ? 'Удаление воды подтверждено.' : 'Вода восстановлена.')
    } catch (failure) {
      setError(committed ? 'Операция подтверждена сервером, но обновление не удалось. Повторите запрос для проверки.' : failure instanceof Error ? failure.message : 'Ошибка сети. Повторите запрос явно.')
    }
  }
  async function run(build: () => Promise<Pending>) {
    if (sending.current || !authorized || pending) return
    sending.current = true; setBusy(true); setError(''); setField(null); setNotice('')
    try {
      const request = await build()
      setPending(request)
      await send(request)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Ошибка сети. Повторите явно.') }
    finally { sending.current = false; setBusy(false) }
  }
  async function retry() {
    if (!pending || sending.current || !authorized) return
    sending.current = true; setBusy(true); setError('')
    try { await send(pending) } finally { sending.current = false; setBusy(false) }
  }
  function quick(value: number) {
    void run(async () => ({ path: '/api/water', method: 'POST', action: 'save',
      body: JSON.stringify({ operation_id: crypto.randomUUID(), volume_ml: value }) }))
  }
  function save(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      let value: number
      try { value = volume(amount) } catch (failure) { setField('volume_ml'); throw failure }
      const time = editing && localTime === localMinute(editing.occurred_at) && !instant ? { candidates: [editing.occurred_at] }
        : await read<{ candidates: string[] }>(`/api/moscow-time?local_time=${encodeURIComponent(localTime)}`)
      if (time.candidates.length !== 1 && !time.candidates.includes(instant)) {
        setCandidates(time.candidates); setField('occurred_at'); throw new Error('Выберите смещение UTC для повторяющегося московского времени.')
      }
      return { path: editing ? `/api/water/${editing.id}` : '/api/water', method: editing ? 'PUT' : 'POST', action: 'save',
        body: JSON.stringify({ operation_id: crypto.randomUUID(), volume_ml: value, occurred_at: instant || time.candidates[0],
          ...(editing ? { expected_revision: editing.revision } : {}) }) }
    })
  }
  function saveSettings(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      let values: number[]
      try {
        values = buttons.trim() ? buttons.split(',').map(volume) : []
        if (new Set(values).size !== values.length) throw new Error('Объёмы кнопок не должны повторяться.')
      } catch (failure) { setField('volumes_ml'); throw failure }
      return { path: '/api/water-settings', method: 'PUT', action: 'settings',
        body: JSON.stringify({ operation_id: crypto.randomUUID(), expected_revision: settingsRevision, volumes_ml: values }) }
    })
  }
  function action(row: { id: string; revision: number }, kind: 'delete' | 'restore') {
    void run(async () => ({ path: `/api/water/${row.id}/${kind}`, method: 'POST', action: kind,
      body: JSON.stringify({ operation_id: crypto.randomUUID(), expected_revision: row.revision }) }))
  }
  async function compare() {
    setError('')
    try {
      if (conflict === 'settings') setLatestSettings(await read<Settings>('/api/water-settings'))
      else if (editing) setLatestWater(await read<WaterEvent>(`/api/water/${editing.id}`))
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось загрузить актуальные данные.') }
  }
  const locked = busy || !!pending
  const invalid = (name: string) => ({ 'aria-invalid': field === name || !!field?.startsWith(name + '.'),
    'aria-describedby': field === name || field?.startsWith(name + '.') ? 'water-error' : undefined })
  const undoTarget = document.getElementById('global-undo')
  return <>
    {undoTarget && createPortal(<div hidden={!authorized || (!undo && !(pending && pending.action !== 'save' && pending.action !== 'settings'))}>
      {undo && <><p role="status">Вода удалена. Отмена доступна до 30 секунд по серверу.</p><button disabled={locked} onClick={() => action(undo, 'restore')}>Отменить удаление воды</button></>}
      {pending && (pending.action === 'delete' || pending.action === 'restore') && <><p role="status">{confirmed ? 'Операция подтверждена.' : 'Результат операции неизвестен.'}</p><button disabled={busy} onClick={() => void retry()}>Повторить операцию с водой</button>{error && <p role="alert">{error}</p>}</>}
    </div>, undoTarget)}
    <section className="water-panel" aria-label="Учёт воды" hidden={!authorized || !visible}>
      <h2>Вода</h2><p className="muted">Только явно внесённая вода. Кнопки добавляют воду сейчас по серверу; другое время задайте по Москве.</p>
      {error && <p id="water-error" role="alert" tabIndex={-1} className="error">{error}</p>}
      {!settings && <button disabled={busy} onClick={() => void initialize().catch(() => setError('Не удалось подключиться.'))}>Повторить подключение воды</button>}
      <div className="water-buttons">{settings?.volumes_ml.map(value => <button key={value} aria-label={`Добавить ${value} мл`} disabled={locked || !!editing || !!amount} onClick={() => quick(value)}>{value} мл</button>)}</div>
      <form onSubmit={save} aria-label="Форма воды" aria-busy={busy}>
        <h3>{editing ? 'Изменение воды' : 'Произвольный объём воды'}</h3>
        <fieldset disabled={locked}>
          <label htmlFor="water-amount">Объём воды, мл</label><input id="water-amount" inputMode="numeric" required value={amount} onChange={e => setAmount(e.target.value)} {...invalid('volume_ml')} />
          <label htmlFor="water-time">Время воды — Москва</label><input id="water-time" type="datetime-local" step="60" required value={localTime} onChange={e => { timeInitialized.current = true; setLocalTime(e.target.value); setInstant(''); setCandidates([]) }} {...invalid('occurred_at')} />
          {candidates.length > 1 && <><label htmlFor="water-offset">Смещение времени воды</label><select id="water-offset" required value={instant} onChange={e => setInstant(e.target.value)}><option value="">Выберите смещение UTC</option>{candidates.map(value => <option key={value} value={value}>UTC{value.slice(-6)}</option>)}</select></>}
          <p className="muted">Целые мл от 1 до 2147483647 — технический предел, без дневной цели.</p>
          <button type="submit" disabled={!!conflict}>Сохранить воду</button><button type="button" onClick={clear}>Отменить ввод воды</button>
        </fieldset>
      </form>
      <button disabled={locked || !settings || settingsOpen} onClick={() => { setSettingsOpen(true); setButtons(settings!.volumes_ml.join(', ')); setSettingsRevision(settings!.revision) }}>Настроить кнопки воды</button>
      {settingsOpen && <form onSubmit={saveSettings} aria-label="Настройки кнопок воды"><fieldset disabled={locked}>
        <label htmlFor="water-buttons">Объёмы кнопок воды, мл</label><input id="water-buttons" value={buttons} onChange={e => setButtons(e.target.value)} {...invalid('volumes_ml')} />
        <p>Целые объёмы через запятую в нужном порядке, без повторов. Пустой набор допустим; произвольный ввод останется.</p>
        <button type="submit" disabled={!!conflict}>Сохранить кнопки воды</button><button type="button" onClick={() => { setSettingsOpen(false); setConflict(null); setLatestSettings(null) }}>Отменить настройку кнопок</button>
      </fieldset></form>}
      {conflict && <button disabled={busy} onClick={() => void compare()}>Загрузить актуальные данные воды</button>}
      {latestWater && <div aria-label="Актуальная вода"><p>{latestWater.volume_ml} мл · {moscowLabel(latestWater.occurred_at)} · редакция {latestWater.revision}{latestWater.deleted_at && ' · Удалена'}</p>
        {!latestWater.deleted_at && <><button onClick={() => edit(latestWater)}>Редактировать актуальную воду</button><button onClick={() => { setEditing(latestWater); setConflict(null); setLatestWater(null) }}>Продолжить с моим вводом воды</button></>}
      </div>}
      {latestSettings && <div aria-label="Актуальные кнопки воды"><p>Кнопки: {latestSettings.volumes_ml.join(', ') || 'пустой набор'} · редакция {latestSettings.revision}</p>
        <button onClick={() => { setButtons(latestSettings.volumes_ml.join(', ')); setSettingsRevision(latestSettings.revision); acceptSettings(latestSettings); setConflict(null); setLatestSettings(null) }}>Использовать актуальные кнопки</button>
        <button onClick={() => { setSettingsRevision(latestSettings.revision); acceptSettings(latestSettings); setConflict(null); setLatestSettings(null) }}>Продолжить с моими кнопками</button>
      </div>}
      {pending && (pending.action === 'save' || pending.action === 'settings') && <><p role="status">{confirmed ? 'Операция подтверждена.' : 'Результат запроса неизвестен.'} Явный повтор отправит прежние данные, время и UUID.</p><button disabled={busy} onClick={() => void retry()}>Повторить запрос воды</button></>}
      {notice && <p role="status">{notice}</p>}
      <section aria-label="История воды"><h3>Вода за {day}</h3>
        {loading && <p role="status">Загружаем воду…</p>}{dayError && <p role="alert">{dayError}</p>}
        {!loading && !dayError && data?.day === day && <>{data.water_total_ml === null ? <p>Нет записей воды</p> : <p>Сумма воды: {data.water_total_ml} мл</p>}
          {data.water.map(row => <article className="meal-history" key={row.id} aria-label={`Вода ${moscowLabel(row.occurred_at)}`}><p>{row.volume_ml} мл</p><p>{moscowLabel(row.occurred_at)}</p><div className="catalog-actions"><button disabled={locked} onClick={() => edit(row)}>Изменить воду</button><button disabled={locked} onClick={() => action(row, 'delete')}>Удалить воду</button></div></article>)}
        </>}
      </section>
    </section>
  </>
}
