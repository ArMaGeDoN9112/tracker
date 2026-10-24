import { useEffect, useId, useState } from 'react'
import { localMinute, basalText, moscowLabel } from './time'

type Change = { occurred_at: string; basal: string | null }
const moscowOffset = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Moscow', timeZoneName: 'longOffset' })
const offset = (date: Date) => moscowOffset.formatToParts(date).find(part => part.type === 'timeZoneName')?.value

export function BasalDayChart({ basal, changes }: { basal: string | null; changes: Change[] }) {
  const [selected, setSelected] = useState<number | null>(null)
  const tooltipId = useId()
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null) }
    document.addEventListener('keydown', dismiss)
    return () => document.removeEventListener('keydown', dismiss)
  }, [])
  const clockChange = changes.some((change, index) => {
    const before = index === 0 ? new Date(Date.parse(change.occurred_at) - 1) : new Date(changes[index - 1].occurred_at)
    return offset(new Date(change.occurred_at)) !== offset(before)
  })
  if (clockChange) return <div className="basal-day-chart">
    <p className="muted">В этот день переводились часы. База показана по времени событий с московским смещением.</p>
    <ul><li>На начало дня: {basalText(basal)}</li>{changes.map(change => <li key={change.occurred_at}>{moscowLabel(change.occurred_at)} · {basalText(change.basal)}</li>)}</ul>
  </div>
  const points = [{ hour: 0, basal }, ...changes.map(change => {
    const time = localMinute(change.occurred_at).slice(11)
    const date = new Date(change.occurred_at)
    return { hour: Number(time.slice(0, 2)) + Number(time.slice(3)) / 60 + date.getUTCSeconds() / 3600 + date.getUTCMilliseconds() / 3600000, basal: change.basal }
  })]
  const segments = points.map((point, index) => ({ ...point, end: points[index + 1]?.hour ?? 24 })).filter(point => point.end > point.hour)
  const maximum = Math.max(1, ...segments.map(point => Number(point.basal)))
  const x = (hour: number) => 40 + hour / 24 * 300
  const y = (value: string) => 140 - Number(value) / maximum * 108
  const time = (hour: number) => {
    const milliseconds = Math.round(hour * 3600000)
    const minute = `${String(Math.floor(milliseconds / 3600000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 60000) % 60).padStart(2, '0')}`
    return milliseconds % 60000 === 0 ? minute : `${minute}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`
  }

  return <div className="basal-day-chart">
    <p className="muted">Скорость по расписанию с учётом временной базы · ед/ч</p>
    <svg viewBox="0 0 360 180" role="group" aria-label="График базы с 00 до 24 часов, Москва"
      onPointerLeave={event => { if (event.pointerType === 'mouse' && !event.currentTarget.contains(document.activeElement)) setSelected(null) }}>
      <text x="4" y="36">{maximum}</text><text x="24" y="144">0</text>
      {[0, 6, 12, 18, 24].map(hour => <g key={hour}>
        <line x1={x(hour)} x2={x(hour)} y1="28" y2="140" className="basal-grid" />
        <text x={x(hour)} y="166" textAnchor="middle">{String(hour).padStart(2, '0')}</text>
      </g>)}
      <line x1="40" x2="340" y1="140" y2="140" className="basal-grid" />
      {segments.map((point, index) => <g key={index}>
        {point.basal === null ? <>
          <rect x={x(point.hour)} y="28" width={x(point.end) - x(point.hour)} height="112" className="basal-unknown" />
          <text x={(x(point.hour) + x(point.end)) / 2} y="90" textAnchor="middle">?</text>
        </> : <>
          <rect x={x(point.hour)} y={y(point.basal)} width={x(point.end) - x(point.hour)} height={140 - y(point.basal)} className="basal-fill" />
          <path d={`M${x(point.hour)},${y(point.basal)} H${x(point.end)}${segments[index + 1]?.basal != null ? ` V${y(segments[index + 1].basal!)}` : ''}`} className="basal-line" />
        </>}
      </g>)}
      {segments.map((point, index) => <rect key={index} x={x(point.hour)} y="28" width={x(point.end) - x(point.hour)} height="112"
        className={`basal-hit${selected === index ? ' basal-selected' : ''}`} role="button" tabIndex={0}
        aria-label={`${time(point.hour)}–${time(point.end)} · ${basalText(point.basal)}`} aria-describedby={selected === index ? tooltipId : undefined}
        onPointerMove={() => setSelected(index)} onPointerDown={event => { event.currentTarget.focus(); setSelected(index) }}
        onClick={() => setSelected(index)}
        onFocus={() => setSelected(index)} onBlur={() => setSelected(null)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(index) }
        }} />)}
      {selected !== null && segments[selected] && <g role="tooltip" id={tooltipId} className="basal-tooltip" pointerEvents="none"
        transform={`translate(${Math.max(40, Math.min(180, x((segments[selected].hour + segments[selected].end) / 2) - 80))}, 2)`}>
        <rect width="160" height="44" rx="6" />
        <text x="80" y="17" textAnchor="middle">{time(segments[selected].hour)}–{time(segments[selected].end)}</text>
        <text x="80" y="34" textAnchor="middle">{basalText(segments[selected].basal)}</text>
      </g>}
    </svg>
    {segments.some(point => point.basal === null) && <p className="muted">? — скорость базы неизвестна</p>}
  </div>
}
