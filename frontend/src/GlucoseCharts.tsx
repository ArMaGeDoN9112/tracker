import { privateFetch } from './access'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Bar, CartesianGrid, ComposedChart, Dot, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, type DotItemDotProps } from 'recharts'

export type GlucoseDay = { day: string; count: number; average: string | null; minimum: string | null; maximum: string | null }
type Summary = { start: string; end: string; count: number; average: string | null; days: GlucoseDay[] }
const glucoseText = (value: string | null) => value === null ? '—' : value.replace('.', ',')

export function GlucoseCharts({ active, generation, onDay }: {
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
        const response = await privateFetch(`/api/glucose-summary?${params}`, { cache: 'no-store' })
        const result = await response.json()
        if (cancelled) return
        if (!response.ok) {
          throw new Error(result.message)
        }
        setSummary(result)
        if (!initialRange.current) {
          initialRange.current = { start: result.start, end: result.end }
          setStart(value => value || result.start); setEnd(value => value || result.end)
        }
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'Не удалось загрузить сводку. Повторите запрос.')
      }
    }
    load()
    return () => { cancelled = true }
  }, [active, generation, query])

  function show(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const params = new URLSearchParams({ period: 'custom', start, end })
    setQuery(params.toString())
  }

  const points = summary?.days.map(row => ({ ...row,
    average: row.average === null ? null : Number(row.average),
    minimum: row.minimum === null ? null : Number(row.minimum),
    maximum: row.maximum === null ? null : Number(row.maximum),
  }))
  const dayDot = (props: DotItemDotProps) => <Dot className="recharts-line-dot" cx={props.cx} cy={props.cy} stroke={props.stroke} fill={props.stroke} r={4} onClick={() => onDay(props.payload.day)} />
  return <section className="glucose-charts" aria-label="Графики сахара">
    <span className="eyebrow">СВОДКИ · МОСКВА</span>
    <h2>Сахар за период</h2>
    <form className="glucose-period" onSubmit={show}>
      <div><label htmlFor="glucose-start">Начало периода — Москва</label>
        <input id="glucose-start" type="date" required value={start} onChange={event => setStart(event.target.value)} /></div>
      <div><label htmlFor="glucose-end">Конец периода — Москва</label>
      <input id="glucose-end" type="date" required value={end} onChange={event => setEnd(event.target.value)} /></div>
      <button type="submit">Показать период</button>
    </form>
    {error ? <p role="alert" className="error">Не удалось загрузить сводку. {error} Перезагрузите страницу.</p>
      : !summary && <p role="status">Загружаем сводку…</p>}
    {summary && <>
      <p className="glucose-bounds" data-testid="period-bounds">{summary.start} — {summary.end} · Москва · обе даты включены</p>
      <p className="glucose-total summary-counts" data-testid="period-average"><span>Среднее за период: <strong>{glucoseText(summary.average)} <small>ммоль/л</small></strong></span> · <span>измерений: <strong>{summary.count}</strong></span></p>
      {summary.count === 0 && <p role="status">В этом периоде нет измерений сахара.</p>}
      <details className="explanation"><summary>Как читать график</summary><p className="muted">Среднее по всем измерениям. Пустые дни — разрывы. Нажмите день графика или кнопку в таблице, чтобы открыть исходные записи.</p></details>
      <div className="glucose-plot">
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={points} accessibilityLayer title="Дневные сводки сахара и число измерений" margin={{ top: 32, right: 4, bottom: 12, left: 4 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="day" tick={{ fill: 'var(--muted)', fontSize: 12 }} tickFormatter={value => String(value).slice(5)} minTickGap={20} />
            <YAxis yAxisId="glucose" width={40} tick={{ fill: 'var(--text)', fontSize: 12 }} label={{ value: 'ммоль/л', position: 'top', fill: 'var(--muted)', fontSize: 12, dx: 10 }} />
            <YAxis yAxisId="count" orientation="right" width={40} allowDecimals={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} label={{ value: 'Измерения', position: 'top', fill: 'var(--muted)', fontSize: 12, dx: -18 }} />
            <Tooltip wrapperStyle={{ maxWidth: '100%' }} contentStyle={{ background: 'var(--background)', borderColor: 'var(--muted)', color: 'var(--text)', borderRadius: 8, whiteSpace: 'normal', overflowWrap: 'anywhere' }} labelFormatter={label => `${label} · Москва`} formatter={(value, name, item) => [item.dataKey === 'count' ? `${value} измерений` : `${Number(value).toFixed(1).replace('.', ',')} ммоль/л`, name]} />
            <Legend wrapperStyle={{ fontSize: 14 }} />
            <Bar yAxisId="count" dataKey="count" name="Измерений (справа)" fill="var(--muted)" maxBarSize={24} isAnimationActive={false} onClick={point => onDay(point.payload.day)} />
            <Line yAxisId="glucose" dataKey="minimum" name="Минимум" stroke="var(--chart-minimum)" strokeDasharray="3 3" dot={dayDot} activeDot={false} connectNulls={false} isAnimationActive={false} />
            <Line yAxisId="glucose" dataKey="maximum" name="Максимум" stroke="var(--chart-maximum)" strokeDasharray="8 4" dot={dayDot} activeDot={false} connectNulls={false} isAnimationActive={false} />
            <Line yAxisId="glucose" dataKey="average" name="Среднее" stroke="var(--accent)" strokeWidth={3} dot={dayDot} activeDot={false} connectNulls={false} isAnimationActive={false} />
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
