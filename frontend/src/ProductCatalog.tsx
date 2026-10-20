import { useEffect, useRef, useState, type FormEvent } from 'react'
import { privateFetch } from './access'

export const nutrients = [['protein', 'Белки', 'г'], ['fat', 'Жиры', 'г'], ['carbohydrate', 'Углеводы', 'г'], ['calories', 'Калории', 'ккал']] as const
export type Portion = { id: string; name: string; quantity: string }
type Values = { name: string; unit: 'g' | 'ml'; protein: string | null; fat: string | null; carbohydrate: string | null; calories: string | null; portions: Portion[]; archived: boolean }
export type Product = Values & { id: string; revision: number }
type Draft = Values & { id?: string; revision?: number }
type Pending = { path: string; method: string; body: string }
const empty = (): Draft => ({ name: '', unit: 'g', protein: '', fat: '', carbohydrate: '', calories: '', portions: [], archived: false })

export function ProductCatalog({ authorized, visible, csrfToken, onSelect, selectionDisabled = false }: { authorized: boolean; visible: boolean; csrfToken: () => Promise<string>; onSelect?: (product: Product) => void; selectionDisabled?: boolean }) {
  const [products, setProducts] = useState<Product[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [original, setOriginal] = useState<Product | null>(null)
  const [search, setSearch] = useState('')
  const [archive, setArchive] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [field, setField] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [unitConfirmed, setUnitConfirmed] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [latest, setLatest] = useState<Product | null>(null)
  const sending = useRef(false)
  const generation = useRef(0)

  async function load() {
    const sequence = ++generation.current
    setLoading(true); setLoadError('')
    try {
      const response = await privateFetch('/api/products')
      if (!response.ok) throw new Error('Не удалось загрузить каталог.')
      const rows: Product[] = await response.json()
      if (sequence === generation.current) setProducts(rows)
    } catch (failure) {
      if (sequence === generation.current) setLoadError(failure instanceof Error ? failure.message : 'Ошибка сети при чтении каталога.')
      throw failure
    } finally { if (sequence === generation.current) setLoading(false) }
  }
  useEffect(() => {
    if (authorized && visible) void load().catch(() => {})
    return () => { generation.current++ }
  }, [authorized, visible])
  useEffect(() => {
    if (error && authorized && visible) document.getElementById('product-error')?.focus()
  }, [error, authorized, visible])

  function open(product?: Product) {
    setDraft(product ?? empty()); setOriginal(product ?? null)
    setError(''); setField(null); setNotice(''); setConflict(false); setLatest(null); setUnitConfirmed(false)
    requestAnimationFrame(() => document.getElementById('product-name')?.focus())
  }
  function changeUnit(unit: 'g' | 'ml') {
    if (!draft || unit === draft.unit) return
    setDraft({ ...draft, unit, protein: '', fat: '', carbohydrate: '', calories: '', portions: [] })
    setUnitConfirmed(false)
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!draft || sending.current) return
    sending.current = true; setBusy(true); setError(''); setField(null); setNotice('')
    let committed = confirmed
    try {
      let request = pending
      if (!request) {
        const { id, revision, name, unit, protein, fat, carbohydrate, calories, portions, archived } = draft
        request = { path: id ? `/api/products/${id}` : '/api/products', method: id ? 'PUT' : 'POST', body: JSON.stringify({ name, unit, protein, fat, carbohydrate, calories, portions, archived, operation_id: crypto.randomUUID(), ...(id ? { expected_revision: revision, unit_change_confirmed: unitConfirmed } : {}) }) }
        setPending(request)
      }
      const csrf = await csrfToken()
      const response = await privateFetch(request.path, { method: request.method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: request.body })
      const result = await response.json()
      if (!response.ok) {
        if ([404, 409, 422, 413].includes(response.status)) setPending(null)
        if (result.code === 'revision_conflict') { setConflict(true); setLatest(null) }
        setField(result.field ?? null)
        throw new Error(result.message)
      }
      committed = true; setConfirmed(true)
      await load()
      setPending(null); setConfirmed(false); setDraft(null); setOriginal(null); setConflict(false); setLatest(null)
      setNotice('Продукт сохранён.')
      requestAnimationFrame(() => document.getElementById('catalog-title')?.focus())
    } catch (failure) {
      setError(committed ? 'Продукт сохранён, но обновление каталога не удалось. Повторите запрос для проверки.' : failure instanceof Error ? failure.message : 'Ошибка сети. Повторите сохранение явно.')
    } finally { sending.current = false; setBusy(false) }
  }
  async function loadLatest() {
    try {
      const response = await privateFetch(`/api/products/${draft!.id}`)
      const result = await response.json()
      if (!response.ok) throw new Error(result.message)
      setLatest(result)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Ошибка сети.') }
  }
  const invalid = (name: string) => ({ 'aria-invalid': field === name, 'aria-describedby': field === name ? 'product-error' : undefined })
  const unit = draft?.unit === 'ml' ? 'мл' : 'г'
  const unitChanged = !!original && draft?.unit !== original.unit
  const rows = products.filter(product => product.archived === archive && product.name.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru')))
  return <div hidden={!authorized || !visible} className="product-catalog">
    <section aria-label="Каталог продуктов">
      <span className="eyebrow">ЛИЧНЫЙ КАТАЛОГ</span><h2 id="catalog-title" tabIndex={-1}>Продукты и порции</h2>
      <div className="catalog-actions"><button onClick={() => setArchive(false)} aria-pressed={!archive}>Каталог</button><button onClick={() => setArchive(true)} aria-pressed={archive}>Архив</button></div>
      <label htmlFor="product-search">Поиск продуктов</label><input id="product-search" type="search" value={search} onChange={event => setSearch(event.target.value)} />
      <button disabled={!!draft || busy || !!pending} onClick={() => open()}>Новый продукт</button>
      <button onClick={() => void load().catch(() => {})} disabled={loading || busy}>Обновить каталог</button>
      {loading && <p role="status">Загружаем каталог…</p>}
      {loadError && <p role="alert" className="error">{loadError}</p>}
      {!loading && !loadError && rows.length === 0 && <p>{search ? 'Продукты не найдены.' : archive ? 'Архив пуст.' : 'Каталог пуст.'}</p>}
      <div hidden={loading || !!loadError}>{rows.map(product => <article key={product.id}>
        <h3>{product.name}</h3><p>На 100 {product.unit === 'g' ? 'г' : 'мл'} · редакция {product.revision}</p>
        {onSelect && !product.archived && <button disabled={selectionDisabled || busy || !!pending} onClick={() => onSelect(product)}>Добавить в приём</button>}
        {nutrients.map(([key, label, nutrientUnit]) => <p key={key}>{label}: {product[key] === null ? 'неизвестно' : `${product[key]} ${nutrientUnit}`}</p>)}
        <ul>{product.portions.map(portion => <li key={portion.id}>{portion.name}: {portion.quantity} {product.unit === 'g' ? 'г' : 'мл'}</li>)}</ul>
        <button disabled={!!draft || busy || !!pending} onClick={() => open(product)}>Изменить</button>
      </article>)}</div>
    </section>
    <section aria-label="Карточка продукта" hidden={!draft}>
      {draft && <><h2>{draft.id ? 'Изменение продукта' : 'Новый продукт'}</h2>
        <p className="muted">Пустое значение — неизвестно, 0 — известный ноль. До двух знаков после запятой, максимум 21474836,47. Калории вводятся независимо от БЖУ.</p>
        {error && <p id="product-error" role="alert" tabIndex={-1} className="error">{error}</p>}
        <form onSubmit={save} aria-busy={busy}>
          <fieldset disabled={busy || !!pending}>
            <label htmlFor="product-name">Название продукта</label><input id="product-name" required maxLength={200} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} {...invalid('name')} />
            <label htmlFor="product-unit">Основа продукта</label><select id="product-unit" value={draft.unit} onChange={e => changeUnit(e.target.value as 'g' | 'ml')} {...invalid('unit')}><option value="g">100 г</option><option value="ml">100 мл</option></select>
            {nutrients.map(([key, label, nutrientUnit]) => <div key={key}><label htmlFor={`product-${key}`}>{label}, {nutrientUnit} на 100 {unit}</label><input id={`product-${key}`} inputMode="decimal" value={draft[key] ?? ''} onChange={e => setDraft({ ...draft, [key]: e.target.value })} {...invalid(key)} /></div>)}
            <h3>Именованные порции</h3>
            {draft.portions.map((portion, index) => <div className="catalog-portion" key={portion.id}>
              <label htmlFor={`portion-name-${portion.id}`}>Название порции {index + 1}</label><input id={`portion-name-${portion.id}`} required maxLength={200} value={portion.name} onChange={e => setDraft({ ...draft, portions: draft.portions.map(p => p.id === portion.id ? { ...p, name: e.target.value } : p) })} {...invalid(`portions.${index}.name`)} />
              <label htmlFor={`portion-quantity-${portion.id}`}>Количество порции {index + 1}, {unit}</label><input id={`portion-quantity-${portion.id}`} required inputMode="decimal" value={portion.quantity} onChange={e => setDraft({ ...draft, portions: draft.portions.map(p => p.id === portion.id ? { ...p, quantity: e.target.value } : p) })} {...invalid(`portions.${index}.quantity`)} />
              <div className="catalog-actions"><button type="button" disabled={index === 0} onClick={() => { const portions = [...draft.portions]; [portions[index - 1], portions[index]] = [portions[index], portions[index - 1]]; setDraft({ ...draft, portions }) }}>Выше — порция {index + 1}</button><button type="button" onClick={() => setDraft({ ...draft, portions: draft.portions.filter(p => p.id !== portion.id) })}>Убрать порцию {index + 1}</button></div>
            </div>)}
            <button type="button" onClick={() => setDraft({ ...draft, portions: [...draft.portions, { id: crypto.randomUUID(), name: '', quantity: '' }] })}>Добавить порцию</button>
            <label className="catalog-check"><input type="checkbox" checked={draft.archived} onChange={e => setDraft({ ...draft, archived: e.target.checked })} />В архиве</label>
            {unitChanged && <div className="schedule-preview"><p>Новая основа: 100 {unit}. Прежние значения и порции очищены; укажите новые значения или оставьте их неизвестными.</p>
              <p>{nutrients.map(([key, label]) => `${label}: ${draft[key] || 'неизвестно'}`).join('; ')}</p>
              <p>Новые порции: {draft.portions.length ? draft.portions.map(p => `${p.name}: ${p.quantity} ${unit}`).join('; ') : 'пустой набор'}</p>
              <label className="catalog-check"><input type="checkbox" required checked={unitConfirmed} onChange={e => setUnitConfirmed(e.target.checked)} />Подтверждаю новые значения и набор порций</label></div>}
          </fieldset>
          {pending && <p role="status">{confirmed ? 'Сохранение подтверждено.' : 'Результат запроса неизвестен.'} Повтор отправит те же данные и UUID без дубликата.</p>}
          <button type="submit" disabled={busy || conflict}>{busy ? 'Сохраняем…' : pending ? 'Повторить сохранение' : 'Сохранить продукт'}</button>
          <button type="button" disabled={busy || !!pending} onClick={() => { setDraft(null); setError(''); setConflict(false); setLatest(null) }}>Отменить редактирование</button>
        </form>
        {conflict && <button disabled={busy} onClick={loadLatest}>Загрузить актуальную карточку</button>}
        {latest && <section aria-label="Актуальная карточка"><h3>{latest.name}</h3><p>Редакция {latest.revision} · 100 {latest.unit === 'g' ? 'г' : 'мл'} · {latest.archived ? 'В архиве' : 'В каталоге'}</p>
          {nutrients.map(([key, label]) => <p key={key}>{label}: {latest[key] ?? 'неизвестно'}</p>)}
          <ul>{latest.portions.map(p => <li key={p.id}>{p.name}: {p.quantity}</li>)}</ul>
          <button onClick={() => open(latest)}>Редактировать актуальную</button>
          <button onClick={() => { setDraft({ ...draft, revision: latest.revision }); setOriginal(latest); setUnitConfirmed(false); setConflict(false); setLatest(null); setError('') }}>Продолжить с моими значениями</button>
        </section>}
      </>}
    </section>
    {notice && <p role="status">{notice}</p>}
  </div>
}
