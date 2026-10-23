import { useEffect, useState, type FormEvent } from 'react'
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
  const [period, setPeriod] = useState('week')
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
        const response = await privateFetch(`/api/nutrition-summary?${query}`)
        const result = await response.json()
        if (cancelled) return
        if (!response.ok) throw new Error(result.message)
        setSummary(result)
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'Ошибка сети. Повторите загрузку.')
      }
    }
    void load()
    return () => { cancelled = true }
  }, [active, generation, query])

  function show(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const params = new URLSearchParams({ period })
    if (period === 'custom') params.set('start', start)
    if (end) params.set('end', end)
    setQuery(params.toString())
  }

  return <section className="nutrition-summary" aria-label="Сводки питания">
    <span className="eyebrow">СВОДКИ · МОСКВА</span><h2>Питание за период</h2>
    <form className="glucose-period" onSubmit={show}>
      <div><label htmlFor="nutrition-period">Период питания</label>
        <select id="nutrition-period" value={period} onChange={event => setPeriod(event.target.value)}>
          <option value="week">7 дней</option><option value="month">30 дней</option><option value="custom">Произвольный период</option>
        </select></div>
      {period === 'custom' && <div><label htmlFor="nutrition-start">Начало периода питания — Москва</label>
        <input id="nutrition-start" type="date" required value={start} onChange={event => setStart(event.target.value)} /></div>}
      <div><label htmlFor="nutrition-end">Конец периода питания — Москва</label>
        <input id="nutrition-end" type="date" aria-describedby="nutrition-period-hint" value={end} onChange={event => setEnd(event.target.value)} /></div>
      <button type="submit">Показать период питания</button>
      <p id="nutrition-period-hint" className="muted">Если конец не выбран, используется сегодня по Москве.</p>
    </form>
    {error ? <p role="alert" className="error">Не удалось загрузить сводку питания. {error}</p>
      : !summary && <p role="status">Загружаем сводку питания…</p>}
    {summary && <>
      <p data-testid="nutrition-bounds">{summary.start} — {summary.end} · Москва · обе даты включены</p>
      <p>Дней с едой: {summary.food_days}; приёмов: {summary.meal_count}</p>
      {!summary.food_days && <p role="status">В этом периоде нет записей еды.</p>}
      <h3>Средние известных дневных сумм</h3>
      <dl className="meal-totals">{nutrients.map(([key, label, unit]) => {
        const average = summary.averages[key]
        return <div key={key} data-testid={`nutrition-average-${key}`}><dt>{label}</dt><dd>
          {average.value === null ? 'Неизвестно' : `${average.value} ${unit}`}{average.incomplete && '; данные неполные'}
          <small>Знаменатель — известных дней: {average.known_days}; неполных дней: {average.incomplete_days}; дней с едой: {summary.food_days}</small>
        </dd></div>
      })}</dl>
      <p className="muted">Сумма точных известных вкладов делится на число дней с известным значением каждого показателя. Известный ноль учитывается; пустые и полностью неизвестные дни не становятся нулями. Любое неизвестное значение делает среднее неполным. Средние округляются независимо от дневных итогов до сотых, половина вверх. Вода не учитывается.</p>
      <div className="glucose-table" tabIndex={0} role="region" aria-label="Дневные итоги питания">
        <table><caption>Дневные итоги. Откройте день для проверки исходных приёмов.</caption>
          <thead><tr><th scope="col">День</th><th scope="col">Приёмов</th>{nutrients.map(([key, label, unit]) => <th key={key} scope="col">{label}, {unit}</th>)}</tr></thead>
          <tbody>{summary.days.map(row => <tr key={row.day}>
            <th scope="row"><button onClick={() => onDay(row.day)} aria-label={`Открыть питание за ${row.day}`}>{row.day}</button></th><td>{row.meal_count}{!row.meal_count && <small>Нет записей еды</small>}</td>
            {nutrients.map(([key]) => <td key={key}>{row.totals[key].value === null ? 'Неизвестно' : `${row.totals[key].incomplete ? 'Известно ' : ''}${row.totals[key].value}`}{row.totals[key].incomplete && '; данные неполные'}
              <small>Известных строк: {row.totals[key].known_count}; неизвестных: {row.totals[key].unknown_count}</small></td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </>}
  </section>
}
