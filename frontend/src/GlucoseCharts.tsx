import { privateFetch } from './access'
import { useEffect, useState, type FormEvent } from 'react'
import { Bar, CartesianGrid, ComposedChart, Dot, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, type DotItemDotProps } from 'recharts'

type GlucoseDay = { day: string; count: number; average: string | null; minimum: string | null; maximum: string | null }
type Summary = { start: string; end: string; count: number; average: string | null; days: GlucoseDay[] }
const glucoseText = (value: string | null) => value === null ? '—' : value.replace('.', ',')

export function GlucoseCharts({ active, generation, onDay }: {
  active: boolean; generation: number; onDay: (day: string) => void
}) {
  const [period, setPeriod] = useState('week')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [query, setQuery] = useState('period=week')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let cancelled = false
    if (!active) return
    setSummary(null); setError('')
    async function load() {
      try {
        const response = await privateFetch(`/api/glucose-summary?${query}`, { cache: 'no-store' })
        const result = await response.json()
        if (cancelled) return
        if (!response.ok) {
          throw new Error(result.message)
        }
        setSummary(result)
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'Не удалось загрузить сводку. Повторите запрос.')
      }
    }
    load()
    return () => { cancelled = true }
  }, [active, generation, query, refresh])

  function show(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const params = new URLSearchParams({ period })
    if (period === 'custom') params.set('start', start)
    if (end) params.set('end', end)
    setQuery(params.toString()); setRefresh(value => value + 1)
  }

  const points = summary?.days.map(row => ({ ...row,
    average: row.average === null ? null : Number(row.average),
    minimum: row.minimum === null ? null : Number(row.minimum),
    maximum: row.maximum === null ? null : Number(row.maximum),
  }))
  const dayDot = (props: DotItemDotProps) => <Dot className="recharts-line-dot" cx={props.cx} cy={props.cy} stroke={props.stroke} fill={props.stroke} r={4} onClick={() => onDay(props.payload.day)} />
  return <section className="glucose-charts" aria-label="Графики сахара">
    <h2>Графики сахара</h2>
    <form onSubmit={show}>
      <label htmlFor="glucose-period">Период</label>
      <select id="glucose-period" value={period} onChange={event => setPeriod(event.target.value)}>
        <option value="week">Неделя — 7 дней</option><option value="month">Месяц — 30 дней</option><option value="custom">Произвольный период</option>
      </select>
      {period === 'custom' && <><label htmlFor="glucose-start">Начало периода — Москва</label>
        <input id="glucose-start" type="date" required value={start} onChange={event => setStart(event.target.value)} /></>}
      <label htmlFor="glucose-end">Конец периода — Москва</label>
      <input id="glucose-end" type="date" value={end} onChange={event => setEnd(event.target.value)} />
      <p className="muted">Если конец не выбран, используется сегодня по Москве.</p>
      <button type="submit">Показать период</button>
    </form>
    {error ? <p role="alert" className="error">{error}</p> : !summary && <p role="status">Загружаем сводку…</p>}
    {summary && <>
      <p data-testid="period-bounds">{summary.start} — {summary.end} · Москва · обе даты включены</p>
      <p data-testid="period-average">Среднее за период: {glucoseText(summary.average)} ммоль/л · измерений: {summary.count}</p>
      <p className="muted">Среднее по всем измерениям. Пустые дни — разрывы. Нажмите день графика или кнопку в таблице, чтобы открыть исходные записи.</p>
      <div className="glucose-plot">
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={points} accessibilityLayer title="Дневные сводки сахара и число измерений" margin={{ top: 12, right: 0, bottom: 12, left: 0 }}>
            <CartesianGrid stroke="#344155" />
            <XAxis dataKey="day" tick={{ fill: '#e8edf3', fontSize: 11 }} tickFormatter={value => String(value).slice(5)} minTickGap={20} />
            <YAxis yAxisId="glucose" width={42} tick={{ fill: '#e8edf3', fontSize: 11 }} />
            <YAxis yAxisId="count" orientation="right" width={28} allowDecimals={false} tick={{ fill: '#b6c3d4', fontSize: 11 }} />
            <Tooltip contentStyle={{ background: '#10151d', borderColor: '#74849a', color: '#e8edf3' }} formatter={(value, name, item) => [item.dataKey === 'count' ? String(value) : Number(value).toFixed(1).replace('.', ','), name]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar yAxisId="count" dataKey="count" name="Измерений (справа)" fill="#b6c3d4" maxBarSize={16} isAnimationActive={false} onClick={point => onDay(point.payload.day)} />
            <Line yAxisId="glucose" dataKey="minimum" name="Минимум, ммоль/л" stroke="#a9c9ff" strokeDasharray="3 3" dot={dayDot} activeDot={false} connectNulls={false} isAnimationActive={false} />
            <Line yAxisId="glucose" dataKey="maximum" name="Максимум, ммоль/л" stroke="#e9be70" strokeDasharray="8 4" dot={dayDot} activeDot={false} connectNulls={false} isAnimationActive={false} />
            <Line yAxisId="glucose" dataKey="average" name="Среднее, ммоль/л" stroke="#9de0cf" strokeWidth={2} dot={dayDot} activeDot={false} connectNulls={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="glucose-table" role="region" aria-label="Таблица сводок сахара" tabIndex={0}>
        <table>
          <caption>Дневные сводки · сахар в ммоль/л · Москва</caption>
          <thead><tr><th scope="col">День</th><th scope="col">Среднее</th><th scope="col">Мин.</th><th scope="col">Макс.</th><th scope="col">Число</th></tr></thead>
          <tbody>{summary.days.map(row => <tr key={row.day}>
            <th scope="row"><button aria-label={`Открыть день ${row.day}`} onClick={() => onDay(row.day)}>{row.day}</button></th>
            <td>{glucoseText(row.average)}{row.count === 0 && <span className="sr-only"> Нет измерений</span>}</td>
            <td>{glucoseText(row.minimum)}</td><td>{glucoseText(row.maximum)}</td><td>{row.count}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </>}
  </section>
}
