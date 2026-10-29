import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { privateFetch } from './access'
import { Water } from './Water'
import { NutritionDayChart } from './NutritionDayChart'
import { NutritionSummary } from './NutritionSummary'
import { ProductCatalog, nutrients, type Product, type Portion, type ProductSeed } from './ProductCatalog'
import { localMinute, moscowLabel } from './time'

type Nutrient = typeof nutrients[number][0]
type Values = Record<Nutrient, string | null>
type Total = { value: string | null; known_count: number; unknown_count: number; incomplete: boolean }
export type Totals = Record<Nutrient, Total>
type Line = Values & { id: string; kind: 'product' | 'one_off'; name: string; unit: 'g' | 'ml' | null; quantity: string | null; basis_quantity: string | null; product_id: string | null; product_revision: number | null; portion: Portion | null }
type FormLine = Omit<Line, 'basis_quantity'> & { basis_quantity?: string | null; portions?: Portion[] }
type Meal = { id: string; occurred_at: string; revision: number; deleted_at: string | null; lines: (Line & { totals: Values })[]; totals: Totals }
export type Day = { day: string; meals: Meal[]; totals: Totals; water: { id: string; occurred_at: string; volume_ml: number }[]; water_total_ml: number | null }
type Pending = { path: string; method: string; body: string; action: 'save' | 'delete' | 'restore' }

export function TotalsView({ totals }: { totals: Totals }) {
  return <dl className="meal-totals metric-grid">{[nutrients[3], ...nutrients.slice(0, 3)].map(([key, label, unit]) => <div key={key}><dt>{label}</dt><dd>
    {totals[key].value === null ? <span className="unknown-value">Неизвестно</span> : `${totals[key].incomplete ? 'Известно ' : ''}${totals[key].value} ${unit}`}
    {totals[key].incomplete && <small className="incomplete-note">; данные неполные</small>}
  </dd></div>)}</dl>
}
export function MealDetails({ meal, onProduct, productDisabled }: { meal: Meal; onProduct?: (line: Line) => void; productDisabled?: boolean }) {
  return <><header className="record-heading"><strong>Приём пищи</strong><time dateTime={meal.occurred_at}>{localMinute(meal.occurred_at).replace('T', ' · ')}</time>{meal.deleted_at && <span className="status-badge">Удалён</span>}</header>
    <TotalsView totals={meal.totals} />
    <ol className="meal-foods">{meal.lines.map((line, index) => <li key={line.id}><div className="record-heading"><strong>{line.name}</strong><span className="muted">{line.quantity === null ? 'Целая порция · количество неизвестно' : `${line.quantity} ${line.unit === 'g' ? 'г' : 'мл'}`}</span></div>
      {line.portion && <p>Порция: {line.portion.name} · {line.portion.quantity} {line.unit === 'g' ? 'г' : 'мл'}</p>}
      {meal.lines.length > 1 && <div className="nutrient-chips">{nutrients.map(([key, label, unit]) => <span key={key}>{label}: <strong>{line.totals[key] ?? 'неизвестно'}{line.totals[key] === null ? '' : ` ${unit}`}</strong></span>)}</div>}
      <details className="explanation"><summary>Исходные данные — {line.name}</summary>
        <p>Основа: {line.basis_quantity === null ? 'исходная порция без известного количества' : `${line.basis_quantity} ${line.unit === 'g' ? 'г' : 'мл'}`} · {nutrients.map(([key, label, unit]) => `${label}: ${line[key] ?? 'неизвестно'}${line[key] === null ? '' : ` ${unit}`}`).join('; ')}</p>
        <p className="muted">Редакция приёма: {meal.revision}. {moscowLabel(meal.occurred_at)}</p>
      </details>
      {line.kind === 'one_off' && onProduct && <button disabled={productDisabled} onClick={() => { const { totals, ...snapshot } = line; onProduct(snapshot) }}>Сохранить как продукт — строка {index + 1}</button>}
    </li>)}</ol></>
}

export function Nutrition({ authorized, visible, summaryVisible, catalogVisible, day, onDay, onInput, csrfToken }: { authorized: boolean; visible: boolean; summaryVisible: boolean; catalogVisible: boolean; day: string; onDay: (day: string, open?: boolean) => void; onInput: () => void; csrfToken: () => Promise<string> }) {
  const [lines, setLines] = useState<FormLine[]>([])
  const [localTime, setLocalTime] = useState('')
  const [latestGlucoseAt, setLatestGlucoseAt] = useState<string | null>(null)
  const [editing, setEditing] = useState<Meal | null>(null)
  const [candidates, setCandidates] = useState<string[]>([])
  const [instant, setInstant] = useState('')
  const [data, setData] = useState<Day | null>(null)
  const [loading, setLoading] = useState(false)
  const [dayError, setDayError] = useState('')
  const [error, setError] = useState('')
  const [field, setField] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const [latest, setLatest] = useState<Meal | null>(null)
  const [undo, setUndo] = useState<{ id: string; revision: number; until: number } | null>(null)
  const [conversion, setConversion] = useState<FormLine | null>(null)
  const [conversionQuantity, setConversionQuantity] = useState('')
  const [conversionUnit, setConversionUnit] = useState<'g' | 'ml'>('g')
  const [productSeed, setProductSeed] = useState<ProductSeed | null>(null)
  const [catalogEditing, setCatalogEditing] = useState(false)
  const [choosingProduct, setChoosingProduct] = useState(false)
  const focusMealForm = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!choosingProduct && focusMealForm.current) {
      const target = document.getElementById(`meal-quantity-${focusMealForm.current}`)
      focusMealForm.current = null
      target?.focus({ preventScroll: true })
      target?.closest('fieldset')?.scrollIntoView({ block: 'start' })
    }
  }, [choosingProduct])
  const [summaryGeneration, setSummaryGeneration] = useState(0)
  const sending = useRef(false)
  const generation = useRef(0)
  const selectedDay = useRef(day)
  selectedDay.current = day
  const initialized = useRef(false)

  const analysisVisible = useRef(false)
  analysisVisible.current = authorized && summaryVisible
  const repeatForm = useRef<{ occurred_at: string; lines: Line[] } | null>(null)
  const analysisDay = summaryVisible ? day : ''
  const mealPage = visible || summaryVisible

  async function read<T,>(path: string): Promise<T> {
    const response = await privateFetch(path)
    const result = await response.json()
    if (!response.ok) throw new Error(result.message)
    return result
  }
  async function loadDay(selected: string) {
    if (!analysisVisible.current) return
    const sequence = ++generation.current
    setLoading(true); setDayError('')
    try {
      const result = await read<Day>(`/api/nutrition-day?day=${selected}`)
      if (sequence === generation.current && selected === selectedDay.current) setData(result)
    } catch (failure) {
      if (sequence === generation.current) setDayError('Не удалось загрузить день питания. Перезагрузите страницу.')
      throw failure
    } finally { if (sequence === generation.current) setLoading(false) }
  }
  const formGeneration = useRef(0)
  useEffect(() => {
    formGeneration.current++
    setLines([]); setEditing(null); setCandidates([]); setInstant(''); setLocalTime(''); setLatestGlucoseAt(null)
    setConflict(null); setLatest(null); setError(''); setField(null); setNotice('')
    setConversion(null); setConversionQuantity(''); setConversionUnit('g'); setProductSeed(null); setChoosingProduct(false)
    initialized.current = false
    if (authorized && visible && repeatForm.current) {
      const form = repeatForm.current
      setLines(form.lines)
      setLocalTime(localMinute(form.occurred_at)); setInstant(form.occurred_at)
      initialized.current = true
      setNotice('Повтор открыт в новой форме. Проверьте состав и время; запись появится после сохранения.')
      requestAnimationFrame(() => document.getElementById('meal-form-title')?.focus())
    }
    repeatForm.current = null
  }, [authorized, visible, summaryVisible, analysisDay])

  async function initialize() {
    const version = formGeneration.current
    const form = await read<{ local_time: string; latest_glucose_at: string | null }>('/api/entry-form')
    if (version !== formGeneration.current) return
    setLatestGlucoseAt(form.latest_glucose_at)
    if (!initialized.current) {
      setLocalTime(form.local_time); initialized.current = true
      if (!selectedDay.current) onDay(form.local_time.slice(0, 10))
    }
  }
  useEffect(() => {
    if (authorized && mealPage) void initialize().catch(() => setError('Не удалось получить время формы. Повторите подключение.'))
  }, [authorized, visible, summaryVisible, analysisDay])
  useEffect(() => {
    setData(null)
    if (authorized && summaryVisible && day) void loadDay(day).catch(() => {})
    return () => { generation.current++ }
  }, [authorized, summaryVisible, day])
  useEffect(() => {
    if (error && authorized && mealPage) document.getElementById('meal-error')?.focus()
  }, [error, authorized, visible, summaryVisible])
  useEffect(() => {
    if (!undo) return
    const timer = window.setTimeout(() => setUndo(null), Math.max(0, undo.until - performance.now()))
    return () => window.clearTimeout(timer)
  }, [undo])

  async function selectProduct(product: Product) {
    if (sending.current || !authorized) return
    sending.current = true; setBusy(true); setError(''); setField(null)
    const version = formGeneration.current
    try {
      const current = await read<Product>(`/api/products/${product.id}`)
      if (version !== formGeneration.current) return
      const { id, revision, name, unit, protein, fat, carbohydrate, calories, portions } = current
      const lineId = crypto.randomUUID()
      setLines(rows => [...rows, { id: lineId, kind: 'product', name, unit, quantity: portions.length ? '' : '100', basis_quantity: '100.00',
        protein, fat, carbohydrate, calories, product_id: id, product_revision: revision, portion: null, portions }])
      setNotice('Продукт добавлен в состав.')
      focusMealForm.current = lineId
      setChoosingProduct(false)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось загрузить продукт. Повторите выбор.') }
    finally { sending.current = false; setBusy(false) }
  }
  function edit(meal: Meal) {
    initialized.current = true
    setEditing(meal); setLocalTime(localMinute(meal.occurred_at))
    setLines(meal.lines.map(({ totals, ...line }) => line))
    setCandidates([]); setInstant(''); setConflict(null); setLatest(null); setError(''); setField(null); setNotice('')
    requestAnimationFrame(() => document.getElementById('meal-form-title')?.focus())
  }
  async function repeat(meal: Meal) {
    if (sending.current || !authorized) return
    sending.current = true; setBusy(true); setError('')
    const version = formGeneration.current
    try {
      const form = await read<{ occurred_at: string; lines: Line[] }>(`/api/meals/${meal.id}/repeat-form`)
      if (version !== formGeneration.current) return
      repeatForm.current = form
      onInput()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось открыть повтор. Попробуйте снова.') }
    finally { sending.current = false; setBusy(false) }
  }
  function openProduct(line: FormLine) {
    const { portions, ...snapshot } = line
    setConversion(snapshot); setConversionQuantity(''); setConversionUnit(line.unit ?? 'g'); setError('')
    requestAnimationFrame(() => document.getElementById('conversion-title')?.focus())
  }
  async function convertProduct() {
    if (!conversion || sending.current || catalogEditing || !authorized) return
    sending.current = true; setBusy(true); setError(''); setField(null)
    const version = formGeneration.current
    try {
      const csrf = await csrfToken()
      const response = await privateFetch('/api/meal-product-preview', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ line: conversion, unit: conversionUnit, basis_quantity: conversionQuantity || null }) })
      const result = await response.json()
      if (!response.ok) { setField(result.field ?? null); throw new Error(result.message) }
      if (version !== formGeneration.current) return
      setProductSeed(result); setConversion(null); setChoosingProduct(true)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось рассчитать карточку.') }
    finally { sending.current = false; setBusy(false) }
  }
  function clear() {
    setLines([]); setEditing(null); setCandidates([]); setInstant(''); setConflict(null); setLatest(null); setError(''); setField(null)
    initialized.current = false; setLocalTime('')
    void initialize().catch(() => setError('Не удалось получить время формы. Повторите подключение.'))
  }
  async function send(request: Pending) {
    const version = formGeneration.current
    const started = performance.now()
    let committed = confirmed && pending?.body === request.body
    try {
      const csrf = await csrfToken()
      const response = await privateFetch(request.path, { method: request.method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: request.body })
      const result = await response.json()
      if (!response.ok) {
        if ([404, 409, 413, 422].includes(response.status)) { setPending(null); setConfirmed(false) }
        if (result.code === 'revision_conflict' && version === formGeneration.current) { setConflict(request.path.split('/')[3]); setLatest(null) }
        if (result.code === 'undo_expired' || (request.action === 'restore' && result.code === 'revision_conflict')) setUndo(null)
        if (version === formGeneration.current) setField(result.field ?? null)
        throw new Error(result.message)
      }
      committed = true; setConfirmed(true)
      setSummaryGeneration(value => value + 1)
      const current = await read<Meal>(`/api/meals/${result.result_id}`)
      if (request.action === 'delete') {
        const until = started + result.undo_remaining_ms
        setUndo(current.deleted_at && current.revision === result.revision && until > performance.now() ? { id: current.id, revision: current.revision, until } : null)
      } else if (request.action === 'restore') setUndo(null)
      if (selectedDay.current) await loadDay(selectedDay.current)
      setPending(null); setConfirmed(false); setConflict(null); setLatest(null)
      if (request.action === 'save' && version === formGeneration.current) clear()
      setNotice(request.action === 'save' ? current.deleted_at ? 'Сохранение подтверждено; приём уже удалён.' : 'Приём пищи сохранён.' : request.action === 'delete' ? 'Удаление подтверждено.' : 'Восстановление подтверждено.')
    } catch (failure) {
      setError(committed ? 'Операция подтверждена сервером, но обновление не удалось. Повторите запрос для проверки.' : failure instanceof Error ? failure.message : 'Ошибка сети. Повторите запрос явно.')
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (sending.current || !authorized) return
    sending.current = true; setBusy(true); setError(''); setField(null); setNotice('')
    const version = formGeneration.current
    try {
      let request = pending
      if (!request) {
        const time = editing && localTime === localMinute(editing.occurred_at) && !instant ? { candidates: [editing.occurred_at] }
          : await read<{ candidates: string[] }>(`/api/moscow-time?local_time=${encodeURIComponent(localTime)}`)
        if (time.candidates.length !== 1 && !time.candidates.includes(instant)) {
          setCandidates(time.candidates); setField('occurred_at'); throw new Error('Выберите смещение UTC для повторяющегося московского времени.')
        }
        if (version !== formGeneration.current) return
        request = { path: editing ? `/api/meals/${editing.id}` : '/api/meals', method: editing ? 'PUT' : 'POST', action: 'save',
          body: JSON.stringify({ operation_id: crypto.randomUUID(), occurred_at: instant || time.candidates[0],
            lines: lines.map(({ portions, ...line }) => line), ...(editing ? { expected_revision: editing.revision } : {}) }) }
        setPending(request)
      }
      await send(request)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Ошибка сети. Повторите запрос явно.') }
    finally { sending.current = false; setBusy(false) }
  }
  async function action(meal: { id: string; revision: number }, kind: 'delete' | 'restore') {
    if (sending.current || !authorized) return
    sending.current = true; setBusy(true); setError(''); setField(null); setNotice('')
    const request: Pending = { path: `/api/meals/${meal.id}/${kind}`, method: 'POST', action: kind,
      body: JSON.stringify({ operation_id: crypto.randomUUID(), expected_revision: meal.revision }) }
    setPending(request)
    try { await send(request) } finally { sending.current = false; setBusy(false) }
  }
  async function retry() {
    if (!pending || sending.current || !authorized) return
    sending.current = true; setBusy(true); setError('')
    try { await send(pending) } finally { sending.current = false; setBusy(false) }
  }
  const invalid = (name: string) => ({ 'aria-invalid': field === name, 'aria-describedby': field === name ? 'meal-error' : undefined })
  const inlineError = (name: string) => field === name && error ? <p className="error">{error}</p> : null
  const locked = busy || !!pending
  const undoTarget = document.getElementById('global-undo')
  return <><div className="nutrition-workspace" data-mode={choosingProduct ? 'catalog' : visible ? 'input' : summaryVisible ? 'analysis' : 'catalog'} hidden={!authorized}>
    {undoTarget && createPortal(<div hidden={!authorized || (!undo && !(pending && pending.action !== 'save'))}>
      {undo && <><p role="status">Приём пищи удалён. Отмена доступна до 30 секунд по серверу.</p><button disabled={locked} onClick={() => void action(undo, 'restore')}>Отменить удаление приёма</button></>}
      {pending && pending.action !== 'save' && <><p role="status">{confirmed ? 'Операция подтверждена.' : 'Результат операции неизвестен.'}</p><button disabled={busy} onClick={() => void retry()}>Повторить операцию с приёмом</button>{error && <p role="alert">{error}</p>}</>}
    </div>, undoTarget)}
    <div className="nutrition-period" hidden={!authorized || !summaryVisible}>
      <NutritionSummary active={authorized && summaryVisible} generation={summaryGeneration} onDay={selected => {
        setChoosingProduct(false)
        onDay(selected, true)
        requestAnimationFrame(() => document.getElementById('nutrition-history')?.focus())
      }} />
    </div>
    <div className="nutrition-meals" hidden={!authorized || !mealPage || choosingProduct}>
      {error && <p id="meal-error" role="alert" tabIndex={-1} className="error">{error}</p>}
      {!visible && !editing && notice && <p role="status">{notice}</p>}
      <div className="diary-layout nutrition-layout">
        <section aria-label="Форма приёма пищи" hidden={!visible && !editing && !(pending?.action === 'save' && pending.method === 'PUT')}>
          <span className="eyebrow">СЪЕДЕННАЯ ЕДА</span><h2 id="meal-form-title" tabIndex={-1}>{editing ? 'Изменение приёма пищи' : 'Новый приём пищи'}</h2>
          {!localTime && <button onClick={() => void initialize().catch(() => setError('Не удалось подключиться.'))}>Повторить подключение питания</button>}
          <form onSubmit={save} aria-busy={busy}>
            <fieldset disabled={locked}>
              <label htmlFor="meal-time">Время приёма — Москва</label><input id="meal-time" type="datetime-local" step="60" required value={localTime} onChange={e => { initialized.current = true; setLocalTime(e.target.value); setCandidates([]); setInstant('') }} {...invalid('occurred_at')} />{inlineError('occurred_at')}
              <button type="button" disabled={!latestGlucoseAt} onClick={() => { if (latestGlucoseAt) { initialized.current = true; setLocalTime(localMinute(latestGlucoseAt)); setInstant(latestGlucoseAt); setCandidates([]) } }}>Время последнего измерения сахара</button>
              {candidates.length > 1 && <><label htmlFor="meal-offset">Смещение времени приёма</label><select id="meal-offset" required value={instant} onChange={e => setInstant(e.target.value)}><option value="">Выберите смещение UTC</option>{candidates.map(value => <option key={value} value={value}>UTC{value.slice(-6)}</option>)}</select></>}
              <h3>Состав</h3>{!lines.length && <p>Добавьте продукт из каталога или разовую еду.</p>}
              <button type="button" onClick={() => setLines(current => [...current, { id: crypto.randomUUID(), kind: 'one_off', name: '', unit: null, quantity: null, protein: null, fat: null, carbohydrate: null, calories: null, product_id: null, product_revision: null, portion: null }])}>Добавить разовую еду</button>
              {lines.map((line, index) => {
                const unit = line.unit === 'g' ? 'г' : line.unit === 'ml' ? 'мл' : 'г/мл'
                const set = (changes: Partial<FormLine>) => setLines(current => current.map(row => row.id === line.id ? { ...row, ...changes } : row))
                return <fieldset className="meal-line" key={line.id}><legend>Строка {index + 1}: {line.name}</legend>
                  <label htmlFor={`meal-name-${line.id}`}>Название строки {index + 1}</label><input id={`meal-name-${line.id}`} required maxLength={200} value={line.name} onChange={e => set({ name: e.target.value })} {...invalid(`lines.${index}.name`)} />{inlineError(`lines.${index}.name`)}
                  {inlineError(`lines.${index}`)}
                  {line.kind === 'one_off' && <><label htmlFor={`meal-unit-${line.id}`}>Единица строки {index + 1}</label><select id={`meal-unit-${line.id}`} required={!!line.quantity || !!line.basis_quantity} value={line.unit ?? ''} onChange={e => set({ unit: e.target.value as Line['unit'] || null })} disabled={!!line.basis_quantity} {...invalid(`lines.${index}.unit`)}><option value="">Количество неизвестно</option><option value="g">г</option><option value="ml">мл</option></select>{inlineError(`lines.${index}.unit`)}</>}
                  {!!line.portions?.length && <div className="catalog-actions" role="group" aria-label={`Порции строки ${index + 1}`}>
                    {line.portions.map(portion => <button type="button" key={portion.id} onClick={() => {
                      const value = (line.quantity?.trim() || '0').replace(',', '.')
                      const quantity = Math.round(Number(value) * 100) + Math.round(Number(portion.quantity) * 100)
                      if (!/^\+?[0-9]+(?:\.[0-9]{1,2}0*)?$/.test(value) || !Number.isSafeInteger(quantity) || quantity > 2147483647) {
                        setField(`lines.${index}.quantity`); setError('Укажите корректное количество перед добавлением порции.'); return
                      }
                      set({ portion, quantity: String(quantity / 100) })
                      setField(null); setError('')
                    }}>Добавить порцию {portion.name} · {portion.quantity} {unit}</button>)}
                  </div>}
                  <label htmlFor={`meal-quantity-${line.id}`}>Количество строки {index + 1}, {unit}</label><input id={`meal-quantity-${line.id}`} required={line.kind === 'product' || !!line.basis_quantity} inputMode="decimal" value={line.quantity ?? ''} onChange={e => set({ quantity: e.target.value || null })} {...invalid(`lines.${index}.quantity`)} />{inlineError(`lines.${index}.quantity`)}
                  {line.kind === 'one_off' && <p>Значения за всю исходную порцию. {line.basis_quantity === undefined ? 'При первом сохранении количество станет исходной основой.' : line.basis_quantity === null ? 'Исходное количество неизвестно: новый вес сам по себе не пересчитывает ценность.' : `Сохранённая основа: ${line.basis_quantity} ${unit}; пересчёт без накопления округлений.`}</p>}
                  <details open={line.kind === 'one_off'}><summary>{line.kind === 'product' ? `Исходные значения на ${line.basis_quantity} ${unit}` : 'Исходная порция и её ценность'}</summary>
                    {line.kind === 'product' ? <p>Снимок продукта · редакция {line.product_revision}. Правка здесь меняет только этот приём.</p> : line.basis_quantity !== undefined && <><label htmlFor={`meal-basis-${line.id}`}>Фактическое количество исходной порции строки {index + 1}, {unit}</label><input id={`meal-basis-${line.id}`} inputMode="decimal" value={line.basis_quantity ?? ''} onChange={e => set({ basis_quantity: e.target.value || null })} {...invalid(`lines.${index}.basis_quantity`)} />{inlineError(`lines.${index}.basis_quantity`)}</>}
                    {nutrients.map(([key, label, nutrientUnit]) => <div key={key}><label htmlFor={`meal-${key}-${line.id}`}>{label} строки {index + 1}, {nutrientUnit} {line.kind === 'product' ? `на 100 ${unit}` : 'за исходную порцию'}</label><input id={`meal-${key}-${line.id}`} inputMode="decimal" value={line[key] ?? ''} onChange={e => set({ [key]: e.target.value })} {...invalid(`lines.${index}.${key}`)} />{inlineError(`lines.${index}.${key}`)}</div>)}
                  </details>
                  {line.kind === 'one_off' && <button type="button" disabled={catalogEditing} onClick={() => openProduct(line)}>Сохранить как продукт — строка {index + 1}</button>}
                  <div className="catalog-actions"><button type="button" disabled={index === 0} onClick={() => { const reordered = [...lines]; [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]]; setLines(reordered) }}>Выше — строка {index + 1}</button><button type="button" onClick={() => setLines(current => current.filter(row => row.id !== line.id))}>Убрать строку {index + 1}</button></div>
                </fieldset>
              })}
              <button type="button" id="choose-product" disabled={locked} onClick={() => { setChoosingProduct(true); requestAnimationFrame(() => document.getElementById('catalog-title')?.focus()) }}>Выбрать из каталога</button>
            </fieldset>
            {pending?.action === 'save' && <p role="status">{confirmed ? 'Сохранение подтверждено.' : 'Результат запроса неизвестен.'} Явный повтор отправит прежние данные, время и UUID.</p>}
            <button type="submit" disabled={busy || !!conflict || (!!pending && pending.action !== 'save') || !localTime}>{busy ? 'Сохраняем…' : pending?.action === 'save' ? 'Повторить сохранение приёма' : 'Сохранить приём пищи'}</button>
            <button type="button" disabled={locked} onClick={clear}>Отменить приём</button>
          </form>
          {conflict && <button disabled={busy} onClick={() => { const version = formGeneration.current; void read<Meal>(`/api/meals/${conflict}`).then(row => { if (version === formGeneration.current) setLatest(row) }).catch(failure => setError(failure.message)) }}>Загрузить актуальный приём</button>}
          {latest && <section aria-label="Актуальный приём"><MealDetails meal={latest} />
            {!latest.deleted_at && <><button onClick={() => edit(latest)}>Редактировать актуальный приём</button>{editing?.id === latest.id && <button onClick={() => { setEditing(latest); setConflict(null); setLatest(null); setError('') }}>Продолжить с моим составом</button>}</>}
          </section>}
          {notice && <p role="status">{notice}</p>}
        </section>
        <section aria-label="День питания" hidden={!summaryVisible}>
          <h2 id="nutrition-history" tabIndex={-1}>История питания</h2>
          <label htmlFor="nutrition-day">День питания — Москва</label><input id="nutrition-day" type="date" value={day} onChange={e => { if (e.target.value) onDay(e.target.value) }} />
          {loading && <p role="status">Загружаем день питания…</p>}
          {dayError && <p role="alert" className="error">{dayError}</p>}
          {!loading && !dayError && data?.day === day && <>{!data.meals.length ? <p>Нет записей еды</p> : <><h3>Итоги дня</h3><TotalsView totals={data.totals} />
            <NutritionDayChart key={day} day={day} meals={data.meals} />
            {data.meals.map(row => <article className="meal-history" key={row.id} aria-label={`Приём ${moscowLabel(row.occurred_at)}`}><MealDetails meal={row} onProduct={openProduct} productDisabled={locked || catalogEditing} /><div className="catalog-actions"><button disabled={locked} onClick={() => edit(row)}>Изменить приём</button><button disabled={locked} onClick={() => void repeat(row)}>Повторить приём</button><button disabled={locked} onClick={() => void action(row, 'delete')}>Удалить приём</button></div></article>)}
          </>}</>}
        </section>
      </div>
      {conversion && <section className="meal-conversion" aria-label="Создание продукта из еды">
        <h2 id="conversion-title" tabIndex={-1}>Сохранить как продукт: {conversion.name}</h2>
        <p>Пересчёт исходных значений на 100 г/мл; карточка округляется до сотых, половина вверх. Исходный приём не меняется.</p>
        {!conversion.basis_quantity && conversion.basis_quantity !== undefined && <p>Введите фактическое количество исходной порции либо заполните новую карточку независимо. Новый съеденный вес не заменяет неизвестную основу.</p>}
        {!conversion.basis_quantity && !(conversion.basis_quantity === undefined && conversion.quantity) && <><label htmlFor="conversion-quantity">Фактическое количество исходной порции</label><input id="conversion-quantity" inputMode="decimal" value={conversionQuantity} onChange={e => setConversionQuantity(e.target.value)} disabled={busy} {...invalid('basis_quantity')} />{inlineError('basis_quantity')}
          <label htmlFor="conversion-unit">Единица исходной порции</label><select id="conversion-unit" value={conversionUnit} onChange={e => setConversionUnit(e.target.value as 'g' | 'ml')} disabled={busy}><option value="g">г</option><option value="ml">мл</option></select></>}
        <button disabled={locked || catalogEditing} onClick={() => void convertProduct()}>Рассчитать карточку</button>
        <button disabled={locked || catalogEditing} onClick={() => { setProductSeed({ name: conversion.name, unit: conversionUnit, protein: null, fat: null, carbohydrate: null, calories: null }); setConversion(null); setChoosingProduct(true) }}>Заполнить карточку независимо</button>
        <button disabled={busy} onClick={() => setConversion(null)}>Отменить создание карточки</button>
      </section>}
    </div>
    <aside className="nutrition-water" hidden={choosingProduct || (!visible && !summaryVisible)}><Water authorized={authorized} visible={visible} analysis={summaryVisible} day={day} csrfToken={csrfToken} />
      <section className="input-help" hidden={!visible}><span className="eyebrow">ВСЁ НА СВОЁМ МЕСТЕ</span><h3>Сейчас — только запись.</h3><p>Просмотр и исправление приёмов пищи и воды находятся в анализе.</p><button onClick={() => onDay(day || localTime.slice(0, 10), true)}>Перейти к анализу ↗</button></section>
    </aside>
    <div className="nutrition-catalog" hidden={!authorized || !(catalogVisible || (mealPage && choosingProduct))}>
      {mealPage && choosingProduct && <>
        <button disabled={locked} onClick={() => { setChoosingProduct(false); requestAnimationFrame(() => document.getElementById(visible || editing ? 'choose-product' : 'nutrition-history')?.focus()) }}>Вернуться к приёму пищи</button>
        <p className="muted">{visible || editing ? 'Откройте карточку и нажмите «Добавить в приём». Состав и время приёма сохранятся.' : 'Сохраните карточку и вернитесь к записям питания.'}</p>
        {error && <p role="alert" className="error">{error}</p>}
      </>}
      <ProductCatalog catalogPage={catalogVisible} authorized={authorized} visible={catalogVisible || (mealPage && choosingProduct)} csrfToken={csrfToken} onSelect={(visible || !!editing) && choosingProduct ? selectProduct : undefined} selectionDisabled={locked || catalogEditing} seed={productSeed} onEditingChange={setCatalogEditing} />
    </div>
  </div></>
}
