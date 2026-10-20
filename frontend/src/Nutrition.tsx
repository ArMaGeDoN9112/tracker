import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { privateFetch } from './access'
import { Water } from './Water'
import { ProductCatalog, nutrients, type Product, type Portion, type ProductSeed } from './ProductCatalog'
import { localMinute, moscowLabel } from './time'

type Nutrient = typeof nutrients[number][0]
type Values = Record<Nutrient, string | null>
type Total = { value: string | null; known_count: number; unknown_count: number; incomplete: boolean }
type Totals = Record<Nutrient, Total>
type Line = Values & { id: string; kind: 'product' | 'one_off'; name: string; unit: 'g' | 'ml' | null; quantity: string | null; basis_quantity: string | null; product_id: string | null; product_revision: number | null; portion: Portion | null }
type DraftLine = Omit<Line, 'basis_quantity'> & { basis_quantity?: string | null; portions?: Portion[] }
type Meal = { id: string; occurred_at: string; category: string | null; revision: number; deleted_at: string | null; lines: (Line & { totals: Values })[]; totals: Totals }
type Day = { day: string; meals: Meal[]; totals: Totals }
type Pending = { path: string; method: string; body: string; action: 'save' | 'delete' | 'restore' }
const categories = [['breakfast', 'Завтрак'], ['lunch', 'Обед'], ['dinner', 'Ужин'], ['snack', 'Перекус']]

// Catalog inputs use hundredths; keep products exact until each independent display rounding.
function hundredths(value: string): bigint {
  const normalized = value.trim().replace(',', '.')
  if (!/^\+?\d+(?:\.\d+)?$/.test(normalized)) throw new Error()
  const [whole, fraction = ''] = normalized.replace(/^\+/, '').split('.')
  if (fraction.slice(2).replace(/0/g, '') || whole.replace(/^0+/, '').length > 8) throw new Error()
  const amount = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2))
  if (amount > 2147483647n) throw new Error()
  return amount
}
function rounded(numerator: bigint, denominator: bigint): string {
  const result = (2n * numerator + denominator) / (2n * denominator)
  return `${result / 100n}.${(result % 100n).toString().padStart(2, '0')}`
}
function preview(lines: DraftLine[]): Totals | null {
  try {
    for (const line of lines) {
      if (line.quantity !== null && hundredths(line.quantity) === 0n) return null
      if (line.kind === 'product' && line.quantity === null) return null
      if (line.basis_quantity && hundredths(line.basis_quantity) === 0n) return null
    }
    return Object.fromEntries(nutrients.map(([key]) => {
      const known = lines.filter(line => line[key] !== null && line[key]!.trim() !== '')
      let numerator = 0n, denominator = 1n
      for (const line of known) {
        const basis = line.basis_quantity === undefined ? line.quantity : line.basis_quantity
        const divisor = basis && line.quantity ? hundredths(basis) : 1n
        const value = hundredths(line[key]!) * (basis && line.quantity ? hundredths(line.quantity) : 1n)
        numerator = numerator * divisor + value * denominator
        denominator *= divisor
        let a = numerator, b = denominator
        while (b) [a, b] = [b, a % b]
        numerator /= a; denominator /= a
      }
      return [key, { value: known.length ? rounded(numerator, denominator) : null,
        known_count: known.length, unknown_count: lines.length - known.length, incomplete: known.length < lines.length }]
    })) as Totals
  } catch { return null }
}
function TotalsView({ totals }: { totals: Totals }) {
  return <dl className="meal-totals">{nutrients.map(([key, label, unit]) => <div key={key}><dt>{label}</dt><dd>
    {totals[key].value === null ? 'Неизвестно' : `${totals[key].incomplete ? 'Известно ' : ''}${totals[key].value} ${unit}`}
    {totals[key].incomplete && '; данные неполные'}
    <small>Известных строк: {totals[key].known_count}; неизвестных: {totals[key].unknown_count}</small>
  </dd></div>)}</dl>
}
function MealDetails({ meal, onProduct, productDisabled }: { meal: Meal; onProduct?: (line: Line) => void; productDisabled?: boolean }) {
  return <><p>{moscowLabel(meal.occurred_at)} · {categories.find(([key]) => key === meal.category)?.[1] ?? 'Без категории'} · редакция {meal.revision}{meal.deleted_at && ' · Удалён'}</p>
    <ol>{meal.lines.map((line, index) => <li key={line.id}><strong>{line.name}</strong> · {line.quantity === null ? 'Целая порция; количество неизвестно' : `${line.quantity} ${line.unit === 'g' ? 'г' : 'мл'}`}
      <p>Основа: {line.basis_quantity === null ? 'исходная порция без известного количества' : `${line.basis_quantity} ${line.unit === 'g' ? 'г' : 'мл'}`} · {nutrients.map(([key, label, unit]) => `${label}: ${line[key] ?? 'неизвестно'}${line[key] === null ? '' : ` ${unit}`}`).join('; ')}</p>
      {line.portion && <p>Порция: {line.portion.name} · {line.portion.quantity} {line.unit === 'g' ? 'г' : 'мл'}</p>}
      <p>{nutrients.map(([key, label, unit]) => `${label}: ${line.totals[key] ?? 'неизвестно'}${line.totals[key] === null ? '' : ` ${unit}`}`).join('; ')}</p>
      {line.kind === 'one_off' && onProduct && <button disabled={productDisabled} onClick={() => { const { totals, ...snapshot } = line; onProduct(snapshot) }}>Сохранить как продукт — строка {index + 1}</button>}
    </li>)}</ol><TotalsView totals={meal.totals} /></>
}

export function Nutrition({ authorized, visible, day, onDay, csrfToken }: { authorized: boolean; visible: boolean; day: string; onDay: (day: string) => void; csrfToken: () => Promise<string> }) {
  const [lines, setLines] = useState<DraftLine[]>([])
  const [localTime, setLocalTime] = useState('')
  const [category, setCategory] = useState('')
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
  const [conversion, setConversion] = useState<DraftLine | null>(null)
  const [conversionQuantity, setConversionQuantity] = useState('')
  const [conversionUnit, setConversionUnit] = useState<'g' | 'ml'>('g')
  const [productSeed, setProductSeed] = useState<ProductSeed | null>(null)
  const [catalogEditing, setCatalogEditing] = useState(false)
  const sending = useRef(false)
  const generation = useRef(0)
  const selectedDay = useRef(day)
  selectedDay.current = day
  const initialized = useRef(false)

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
      if (sequence === generation.current) setDayError('Не удалось загрузить день питания. Повторите обновление.')
      throw failure
    } finally { if (sequence === generation.current) setLoading(false) }
  }
  async function initialize() {
    const form = await read<{ local_time: string }>('/api/entry-form')
    if (!initialized.current) {
      setLocalTime(form.local_time); initialized.current = true
      if (!selectedDay.current) onDay(form.local_time.slice(0, 10))
    }
  }
  useEffect(() => {
    if (authorized && visible && !initialized.current) void initialize().catch(() => setError('Не удалось получить время формы. Повторите подключение.'))
  }, [authorized, visible])
  useEffect(() => {
    setData(null)
    if (authorized && visible && day) void loadDay(day).catch(() => {})
    return () => { generation.current++ }
  }, [authorized, visible, day])
  useEffect(() => {
    if (error && authorized && visible) document.getElementById('meal-error')?.focus()
  }, [error, authorized, visible])
  useEffect(() => {
    if (!undo) return
    const timer = window.setTimeout(() => setUndo(null), Math.max(0, undo.until - performance.now()))
    return () => window.clearTimeout(timer)
  }, [undo])

  async function selectProduct(product: Product) {
    if (sending.current || !authorized) return
    sending.current = true; setBusy(true); setError(''); setField(null)
    try {
      const current = await read<Product>(`/api/products/${product.id}`)
      if (current.archived) throw new Error('Продукт в архиве. Обновите каталог и выберите доступный продукт.')
      const { id, revision, name, unit, protein, fat, carbohydrate, calories, portions } = current
      setLines(rows => [...rows, { id: crypto.randomUUID(), kind: 'product', name, unit, quantity: '100', basis_quantity: '100.00',
        protein, fat, carbohydrate, calories, product_id: id, product_revision: revision, portion: null, portions }])
      setNotice('Продукт добавлен в состав.')
      requestAnimationFrame(() => document.getElementById('meal-form-title')?.focus())
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось загрузить продукт. Повторите выбор.') }
    finally { sending.current = false; setBusy(false) }
  }
  function edit(meal: Meal) {
    setEditing(meal); setLocalTime(localMinute(meal.occurred_at)); setCategory(meal.category ?? '')
    setLines(meal.lines.map(({ totals, ...line }) => line))
    setCandidates([]); setInstant(''); setConflict(null); setLatest(null); setError(''); setField(null); setNotice('')
    requestAnimationFrame(() => document.getElementById('meal-form-title')?.focus())
  }
  async function repeat(meal: Meal) {
    if (sending.current || !authorized) return
    sending.current = true; setBusy(true); setError('')
    try {
      const draft = await read<{ occurred_at: string; category: string | null; lines: Line[] }>(`/api/meals/${meal.id}/repeat-form`)
      setEditing(null); setLines(draft.lines); setCategory(draft.category ?? '')
      setLocalTime(localMinute(draft.occurred_at)); setInstant(draft.occurred_at); setCandidates([])
      initialized.current = true; setConflict(null); setLatest(null); setField(null)
      setNotice('Повтор открыт в новом черновике. Проверьте состав и время; запись появится после сохранения.')
      requestAnimationFrame(() => document.getElementById('meal-form-title')?.focus())
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось открыть повтор. Попробуйте снова.') }
    finally { sending.current = false; setBusy(false) }
  }
  function openProduct(line: DraftLine) {
    const { portions, ...snapshot } = line
    setConversion(snapshot); setConversionQuantity(''); setConversionUnit(line.unit ?? 'g'); setError('')
    requestAnimationFrame(() => document.getElementById('conversion-title')?.focus())
  }
  async function convertProduct() {
    if (!conversion || sending.current || catalogEditing || !authorized) return
    sending.current = true; setBusy(true); setError(''); setField(null)
    try {
      const csrf = await csrfToken()
      const response = await privateFetch('/api/meal-product-preview', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ line: conversion, unit: conversionUnit, basis_quantity: conversionQuantity || null }) })
      const result = await response.json()
      if (!response.ok) { setField(result.field ?? null); throw new Error(result.message) }
      setProductSeed(result); setConversion(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось рассчитать карточку.') }
    finally { sending.current = false; setBusy(false) }
  }
  function clear() {
    setLines([]); setCategory(''); setEditing(null); setCandidates([]); setInstant(''); setConflict(null); setLatest(null); setError(''); setField(null)
    initialized.current = false; setLocalTime('')
    void initialize().catch(() => setError('Не удалось получить время формы. Повторите подключение.'))
  }
  async function send(request: Pending) {
    const started = performance.now()
    let committed = confirmed && pending?.body === request.body
    try {
      const csrf = await csrfToken()
      const response = await privateFetch(request.path, { method: request.method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: request.body })
      const result = await response.json()
      if (!response.ok) {
        if ([404, 409, 413, 422].includes(response.status)) { setPending(null); setConfirmed(false) }
        if (result.code === 'revision_conflict') { setConflict(request.path.split('/')[3]); setLatest(null) }
        if (result.code === 'undo_expired' || (request.action === 'restore' && result.code === 'revision_conflict')) setUndo(null)
        setField(result.field ?? null)
        throw new Error(result.message)
      }
      committed = true; setConfirmed(true)
      const current = await read<Meal>(`/api/meals/${result.result_id}`)
      if (request.action === 'delete') {
        const until = started + result.undo_remaining_ms
        setUndo(current.deleted_at && current.revision === result.revision && until > performance.now() ? { id: current.id, revision: current.revision, until } : null)
      } else if (request.action === 'restore') setUndo(null)
      if (selectedDay.current) await loadDay(selectedDay.current)
      setPending(null); setConfirmed(false); setConflict(null); setLatest(null)
      if (request.action === 'save') clear()
      setNotice(request.action === 'save' ? current.deleted_at ? 'Сохранение подтверждено; приём уже удалён.' : 'Приём пищи сохранён. Показана актуальная история.' : request.action === 'delete' ? 'Удаление подтверждено.' : 'Восстановление подтверждено.')
    } catch (failure) {
      setError(committed ? 'Операция подтверждена сервером, но обновление не удалось. Повторите запрос для проверки.' : failure instanceof Error ? failure.message : 'Ошибка сети. Повторите запрос явно.')
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (sending.current || !authorized) return
    sending.current = true; setBusy(true); setError(''); setField(null); setNotice('')
    try {
      let request = pending
      if (!request) {
        const time = editing && localTime === localMinute(editing.occurred_at) && !instant ? { candidates: [editing.occurred_at] }
          : await read<{ candidates: string[] }>(`/api/moscow-time?local_time=${encodeURIComponent(localTime)}`)
        if (time.candidates.length !== 1 && !time.candidates.includes(instant)) {
          setCandidates(time.candidates); setField('occurred_at'); throw new Error('Выберите смещение UTC для повторяющегося московского времени.')
        }
        request = { path: editing ? `/api/meals/${editing.id}` : '/api/meals', method: editing ? 'PUT' : 'POST', action: 'save',
          body: JSON.stringify({ operation_id: crypto.randomUUID(), occurred_at: instant || time.candidates[0], category: category || null,
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
  const totals = preview(lines)
  const locked = busy || !!pending
  const undoTarget = document.getElementById('global-undo')
  return <>
    {undoTarget && createPortal(<div hidden={!authorized || (!undo && !(pending && pending.action !== 'save'))}>
      {undo && <><p role="status">Приём пищи удалён. Отмена доступна до 30 секунд по серверу.</p><button disabled={locked} onClick={() => void action(undo, 'restore')}>Отменить удаление приёма</button></>}
      {pending && pending.action !== 'save' && <><p role="status">{confirmed ? 'Операция подтверждена.' : 'Результат операции неизвестен.'}</p><button disabled={busy} onClick={() => void retry()}>Повторить операцию с приёмом</button>{error && <p role="alert">{error}</p>}</>}
    </div>, undoTarget)}
    <div hidden={!authorized || !visible}>
      <div className="diary-layout nutrition-layout">
        <section aria-label="Форма приёма пищи">
          <span className="eyebrow">СЪЕДЕННАЯ ЕДА</span><h2 id="meal-form-title" tabIndex={-1}>{editing ? 'Изменение приёма пищи' : 'Новый приём пищи'}</h2>
          <p className="muted">Добавьте продукт из каталога или разовую еду. Карточку можно сохранить отдельно — состав останется в форме.</p>
          {error && <p id="meal-error" role="alert" tabIndex={-1} className="error">{error}</p>}
          {!localTime && <button onClick={() => void initialize().catch(() => setError('Не удалось подключиться.'))}>Повторить подключение питания</button>}
          <form onSubmit={save} aria-busy={busy}>
            <fieldset disabled={locked}>
              <label htmlFor="meal-time">Время приёма — Москва</label><input id="meal-time" type="datetime-local" step="60" required value={localTime} onChange={e => { setLocalTime(e.target.value); setCandidates([]); setInstant('') }} {...invalid('occurred_at')} />{inlineError('occurred_at')}
              {candidates.length > 1 && <><label htmlFor="meal-offset">Смещение времени приёма</label><select id="meal-offset" required value={instant} onChange={e => setInstant(e.target.value)}><option value="">Выберите смещение UTC</option>{candidates.map(value => <option key={value} value={value}>UTC{value.slice(-6)}</option>)}</select></>}
              <label htmlFor="meal-category">Категория приёма</label><select id="meal-category" value={category} onChange={e => setCategory(e.target.value)} {...invalid('category')}><option value="">Без категории</option>{categories.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
              <h3>Состав</h3>{!lines.length && <p>Добавьте продукт из каталога или разовую еду.</p>}
              <button type="button" onClick={() => setLines(current => [...current, { id: crypto.randomUUID(), kind: 'one_off', name: '', unit: null, quantity: null, protein: null, fat: null, carbohydrate: null, calories: null, product_id: null, product_revision: null, portion: null }])}>Добавить разовую еду</button>
              {lines.map((line, index) => {
                const unit = line.unit === 'g' ? 'г' : line.unit === 'ml' ? 'мл' : 'г/мл'
                const set = (changes: Partial<DraftLine>) => setLines(current => current.map(row => row.id === line.id ? { ...row, ...changes } : row))
                const lineTotals = preview([line])
                return <fieldset className="meal-line" key={line.id}><legend>Строка {index + 1}: {line.name}</legend>
                  <label htmlFor={`meal-name-${line.id}`}>Название строки {index + 1}</label><input id={`meal-name-${line.id}`} required maxLength={200} value={line.name} onChange={e => set({ name: e.target.value })} {...invalid(`lines.${index}.name`)} />{inlineError(`lines.${index}.name`)}
                  {inlineError(`lines.${index}`)}
                  {line.kind === 'one_off' && <><label htmlFor={`meal-unit-${line.id}`}>Единица строки {index + 1}</label><select id={`meal-unit-${line.id}`} required={!!line.quantity || !!line.basis_quantity} value={line.unit ?? ''} onChange={e => set({ unit: e.target.value as Line['unit'] || null })} disabled={!!line.basis_quantity} {...invalid(`lines.${index}.unit`)}><option value="">Количество неизвестно</option><option value="g">г</option><option value="ml">мл</option></select>{inlineError(`lines.${index}.unit`)}</>}
                  {!!line.portions?.length && <><label htmlFor={`meal-portion-${line.id}`}>Порция строки {index + 1}</label><select id={`meal-portion-${line.id}`} value={line.portion?.id ?? ''} onChange={e => { const portion = line.portions!.find(p => p.id === e.target.value) ?? null; set({ portion, ...(portion ? { quantity: portion.quantity } : {}) }) }}><option value="">Произвольное количество</option>{line.portions.map(p => <option key={p.id} value={p.id}>{p.name} · {p.quantity} {unit}</option>)}</select></>}
                  {line.portion && <p>Выбрана порция: {line.portion.name} · {line.portion.quantity} {unit}; съеденное количество можно изменить.</p>}
                  <label htmlFor={`meal-quantity-${line.id}`}>Количество строки {index + 1}, {unit}</label><input id={`meal-quantity-${line.id}`} required={line.kind === 'product' || !!line.basis_quantity} inputMode="decimal" value={line.quantity ?? ''} onChange={e => set({ quantity: e.target.value || null })} {...invalid(`lines.${index}.quantity`)} />{inlineError(`lines.${index}.quantity`)}
                  {line.kind === 'one_off' && <p>Значения за всю исходную порцию. {line.basis_quantity === undefined ? 'При первом сохранении количество станет исходной основой.' : line.basis_quantity === null ? 'Исходное количество неизвестно: новый вес сам по себе не пересчитывает ценность.' : `Сохранённая основа: ${line.basis_quantity} ${unit}; пересчёт без накопления округлений.`}</p>}
                  <details open={line.kind === 'one_off'}><summary>{line.kind === 'product' ? `Исходные значения на ${line.basis_quantity} ${unit}` : 'Исходная порция и её ценность'}</summary>
                    {line.kind === 'product' ? <p>Снимок продукта · редакция {line.product_revision}. Правка здесь меняет только этот приём.</p> : line.basis_quantity !== undefined && <><label htmlFor={`meal-basis-${line.id}`}>Фактическое количество исходной порции строки {index + 1}, {unit}</label><input id={`meal-basis-${line.id}`} inputMode="decimal" value={line.basis_quantity ?? ''} onChange={e => set({ basis_quantity: e.target.value || null })} {...invalid(`lines.${index}.basis_quantity`)} />{inlineError(`lines.${index}.basis_quantity`)}</>}
                    {nutrients.map(([key, label, nutrientUnit]) => <div key={key}><label htmlFor={`meal-${key}-${line.id}`}>{label} строки {index + 1}, {nutrientUnit} {line.kind === 'product' ? `на 100 ${unit}` : 'за исходную порцию'}</label><input id={`meal-${key}-${line.id}`} inputMode="decimal" value={line[key] ?? ''} onChange={e => set({ [key]: e.target.value })} {...invalid(`lines.${index}.${key}`)} />{inlineError(`lines.${index}.${key}`)}</div>)}
                  </details>
                  {line.kind === 'one_off' && <button type="button" disabled={catalogEditing} onClick={() => openProduct(line)}>Сохранить как продукт — строка {index + 1}</button>}
                  {lineTotals ? <TotalsView totals={lineTotals} /> : <p>Проверьте количество и исходные значения: до двух знаков после запятой, максимум 21474836,47.</p>}
                  <div className="catalog-actions"><button type="button" disabled={index === 0} onClick={() => { const reordered = [...lines]; [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]]; setLines(reordered) }}>Выше — строка {index + 1}</button><button type="button" onClick={() => setLines(current => current.filter(row => row.id !== line.id))}>Убрать строку {index + 1}</button></div>
                </fieldset>
              })}
              {!!lines.length && totals && <><h3>Калькулятор приёма</h3><TotalsView totals={totals} /></>}
              <p className="muted">Строка, приём и день округляются независимо до сотых: половина округляется вверх. Сумма отображённых строк может отличаться на 0,01 от итога. Пустое значение — неизвестно; 0 — известный ноль. Калории с этикетки независимы от БЖУ.</p>
            </fieldset>
            {pending?.action === 'save' && <p role="status">{confirmed ? 'Сохранение подтверждено.' : 'Результат запроса неизвестен.'} Явный повтор отправит прежние данные, время и UUID.</p>}
            <button type="submit" disabled={busy || !!conflict || (!!pending && pending.action !== 'save') || !localTime}>{busy ? 'Сохраняем…' : pending?.action === 'save' ? 'Повторить сохранение приёма' : 'Сохранить приём пищи'}</button>
            <button type="button" disabled={locked} onClick={clear}>Отменить приём</button>
          </form>
          {conflict && <button disabled={busy} onClick={() => void read<Meal>(`/api/meals/${conflict}`).then(setLatest).catch(failure => setError(failure.message))}>Загрузить актуальный приём</button>}
          {latest && <section aria-label="Актуальный приём"><MealDetails meal={latest} />
            {!latest.deleted_at && <><button onClick={() => edit(latest)}>Редактировать актуальный приём</button>{editing?.id === latest.id && <button onClick={() => { setEditing(latest); setConflict(null); setLatest(null); setError('') }}>Продолжить с моим составом</button>}</>}
          </section>}
          {notice && <p role="status">{notice}</p>}
        </section>
        <section aria-label="День питания">
          <h2 id="nutrition-history" tabIndex={-1}>История питания</h2>
          <label htmlFor="nutrition-day">День питания — Москва</label><input id="nutrition-day" type="date" value={day} onChange={e => { if (e.target.value) onDay(e.target.value) }} />
          <button disabled={loading || !day} onClick={() => void loadDay(day).catch(() => {})}>Обновить день питания</button>
          {loading && <p role="status">Загружаем день питания…</p>}
          {dayError && <p role="alert" className="error">{dayError}</p>}
          {!loading && !dayError && data?.day === day && <>{!data.meals.length ? <p>Нет записей еды</p> : <><h3>Итоги дня</h3><TotalsView totals={data.totals} />
            {data.meals.map(row => <article className="meal-history" key={row.id} aria-label={`Приём ${moscowLabel(row.occurred_at)}`}><MealDetails meal={row} onProduct={openProduct} productDisabled={locked || catalogEditing} /><div className="catalog-actions"><button disabled={locked} onClick={() => edit(row)}>Изменить приём</button><button disabled={locked} onClick={() => void repeat(row)}>Повторить приём</button><button disabled={locked} onClick={() => void action(row, 'delete')}>Удалить приём</button></div></article>)}
          </>}</>}
          <Water authorized={authorized} visible={visible} day={day} csrfToken={csrfToken} />
        </section>
      </div>
      {conversion && <section className="meal-conversion" aria-label="Создание продукта из еды">
        <h2 id="conversion-title" tabIndex={-1}>Сохранить как продукт: {conversion.name}</h2>
        <p>Пересчёт исходных значений на 100 г/мл; карточка округляется до сотых, половина вверх. Исходный приём не меняется.</p>
        {!conversion.basis_quantity && conversion.basis_quantity !== undefined && <p>Введите фактическое количество исходной порции либо заполните новую карточку независимо. Новый съеденный вес не заменяет неизвестную основу.</p>}
        {!conversion.basis_quantity && !(conversion.basis_quantity === undefined && conversion.quantity) && <><label htmlFor="conversion-quantity">Фактическое количество исходной порции</label><input id="conversion-quantity" inputMode="decimal" value={conversionQuantity} onChange={e => setConversionQuantity(e.target.value)} disabled={busy} {...invalid('basis_quantity')} />{inlineError('basis_quantity')}
          <label htmlFor="conversion-unit">Единица исходной порции</label><select id="conversion-unit" value={conversionUnit} onChange={e => setConversionUnit(e.target.value as 'g' | 'ml')} disabled={busy}><option value="g">г</option><option value="ml">мл</option></select></>}
        <button disabled={locked || catalogEditing} onClick={() => void convertProduct()}>Рассчитать карточку</button>
        <button disabled={locked || catalogEditing} onClick={() => { setProductSeed({ name: conversion.name, unit: conversionUnit, protein: null, fat: null, carbohydrate: null, calories: null }); setConversion(null) }}>Заполнить карточку независимо</button>
        <button disabled={busy} onClick={() => setConversion(null)}>Отменить создание карточки</button>
      </section>}
      <ProductCatalog authorized={authorized} visible={visible} csrfToken={csrfToken} onSelect={selectProduct} selectionDisabled={locked} seed={productSeed} onEditingChange={setCatalogEditing} />
    </div>
  </>
}
