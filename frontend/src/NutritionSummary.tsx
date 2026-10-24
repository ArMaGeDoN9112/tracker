import { useEffect, useRef, useState, type FormEvent } from 'react'
import { privateFetch } from './access'
import { nutrients } from './ProductCatalog'
import type { Totals } from './Nutrition'

type Average = { value: string | null; known_days: number; incomplete_days: number; incomplete: boolean }
type Summary = {
  start: string; end: string; food_days: number; meal_count: number
  averages: Record<keyof Totals, Average>
  days: { day: string; meal_count: number; totals: Totals }[]
}

export function NutritionSummary({ active, generation, onDay }: {
  active: boolean; generation: number; onDay: (day: string) => void
}) {
  const initialRange = useRef<{ start: string; end: string } | null>(null)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [query, setQuery] = useState('period=week')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    if (!active) return
    setSummary(null); setError('')
    async function load() {
      try {
        const params = query === 'period=week' && initialRange.current ? new URLSearchParams({ period: 'custom', ...initialRange.current }).toString() : query
        const response = await privateFetch(`/api/nutrition-summary?${params}`)
        const result = await response.json()
        if (cancelled) return
        if (!response.ok) throw new Error(result.message)
        setSummary(result)
        if (!initialRange.current) {
          initialRange.current = { start: result.start, end: result.end }
          setStart(value => value || result.start); setEnd(value => value || result.end)
        }
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'Ошибка сети. Повторите загрузку.')
      }
    }
    void load()
    return () => { cancelled = true }
  }, [active, generation, query])

  function show(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const params = new URLSearchParams({ period: 'custom', start, end })
    setQuery(params.toString())
  }

  return <section className="nutrition-summary" aria-label="Сводки питания">
    <span className="eyebrow">СВОДКИ · МОСКВА</span><h2>Питание за период</h2>
    <form className="glucose-period" onSubmit={show}>
      <div><label htmlFor="nutrition-start">Начало периода питания — Москва</label>
        <input id="nutrition-start" type="date" required value={start} onChange={event => setStart(event.target.value)} /></div>
      <div><label htmlFor="nutrition-end">Конец периода питания — Москва</label>
        <input id="nutrition-end" type="date" required value={end} onChange={event => setEnd(event.target.value)} /></div>
      <button type="submit">Показать период питания</button>
    </form>
    {error ? <p role="alert" className="error">Не удалось загрузить сводку питания. {error}</p>
      : !summary && <p role="status">Загружаем сводку питания…</p>}
    {summary && <>
      <p className="period-bounds" data-testid="nutrition-bounds">{summary.start} — {summary.end} · Москва · обе даты включены</p>
      <p className="summary-counts"><span>Дней с едой: <strong>{summary.food_days}</strong></span>; <span>приёмов: <strong>{summary.meal_count}</strong></span></p>
      {!summary.food_days && <p role="status">В этом периоде нет записей еды.</p>}
      <h3>Среднее по дням с данными</h3>
      <dl className="meal-totals metric-grid">{[nutrients[3], ...nutrients.slice(0, 3)].map(([key, label, unit]) => {
        const average = summary.averages[key]
        return <div key={key} data-testid={`nutrition-average-${key}`}><dt>{label}</dt><dd>
          {average.value === null ? <span className="unknown-value">Неизвестно</span> : `${average.value} ${unit}`}{average.incomplete && <small className="incomplete-note">; данные неполные</small>}
          <details className="explanation"><summary>Данные для среднего</summary><small>Знаменатель — известных дней: {average.known_days}; неполных дней: {average.incomplete_days}; дней с едой: {summary.food_days}</small></details>
        </dd></div>
      })}</dl>
      <div className="glucose-table" tabIndex={0} role="region" aria-label="Дневные итоги питания">
        <table><caption>Дневные итоги · «—» — нет записей еды. Нажмите на день для просмотра приёмов.</caption>
          <thead><tr><th scope="col">День</th><th scope="col">Приёмов</th>{nutrients.map(([key, label, unit]) => <th key={key} scope="col">{label}, {unit}</th>)}</tr></thead>
          <tbody>{summary.days.map(row => <tr key={row.day} className={row.meal_count ? undefined : 'empty-day'}>
            <th scope="row"><button onClick={() => onDay(row.day)} aria-label={`Открыть питание за ${row.day}`}>{row.day}</button></th><td>{row.meal_count}{!row.meal_count && <span className="sr-only">Нет записей еды</span>}</td>
            {nutrients.map(([key]) => <td key={key}>{!row.meal_count ? <span aria-label="Нет записей еды">—</span> : <>{row.totals[key].value === null ? 'Неизвестно' : `${row.totals[key].incomplete ? 'Известно ' : ''}${row.totals[key].value}`}{row.totals[key].incomplete && '; данные неполные'}</>}
              </td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </>}
  </section>
}
