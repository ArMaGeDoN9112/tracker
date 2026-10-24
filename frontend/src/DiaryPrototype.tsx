/// <reference types="vite/client" />
// PROTOTYPE: three diary layouts on /?prototype=diary&variant=A; synthetic, in-memory data only.
import { useEffect, useState, type FormEvent } from 'react'
import './diary-prototype.css'

type Variant = 'A' | 'B' | 'C'
type Entry = { id: number; time: string; glucose: string; bolus: string; reason: string; comment: string }
const variants: Variant[] = ['A', 'B', 'C']
const names = { A: 'Сначала запись', B: 'Лента событий', C: 'День целиком' }
const descriptions = {
  A: 'Форма — главное. Внести измерение можно сразу, история остаётся рядом.',
  B: 'История — главное. Компактный ввод и плотная лента для работы с записями.',
  C: 'Сначала обзор. Сводка и график помогают увидеть день, ввод открывается по кнопке.',
}
const initialEntries: Entry[] = [
  { id: 1, time: '08:15', glucose: '5.8', bolus: '2.5', reason: 'Еда', comment: 'Завтрак: каша, кофе' },
  { id: 2, time: '10:40', glucose: '7.2', bolus: '', reason: '', comment: 'После прогулки' },
  { id: 3, time: '13:10', glucose: '6.4', bolus: '3.0', reason: 'Еда', comment: 'Обед' },
  { id: 4, time: '15:30', glucose: '5.6', bolus: '', reason: '', comment: '' },
]
const decimal = (value: string) => value.replace('.', ',')
function Icon({ kind }: { kind: string }) {
  const paths: Record<string, string> = {
    diary: 'M5 4h14v16H5z M9 4v16 M12 9h4 M12 13h4',
    chart: 'M4 4v16h16 M7 15l4-5 4 3 5-7',
    basal: 'M4 16h5V9h6V5h5 M4 20h16',
    settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
    plus: 'M12 5v14 M5 12h14',
    arrow: 'M5 12h14 M13 6l6 6-6 6',
  }
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind] || paths.diary} /></svg>
}

function EntryForm({ compact = false, editing, onSave, onCancel }: {
  compact?: boolean; editing: Entry | null; onSave: (entry: Omit<Entry, 'id'>) => void; onCancel: () => void
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const glucose = String(values.get('glucose')).trim().replace(',', '.')
    const bolus = String(values.get('bolus')).trim().replace(',', '.')
    const comment = String(values.get('comment')).trim()
    const error = form.querySelector<HTMLElement>('[role="alert"]')!
    if ((!glucose && !Number(bolus) && !comment) || (glucose && (!Number.isFinite(Number(glucose)) || Number(glucose) <= 0)) || (bolus && (!Number.isFinite(Number(bolus)) || Number(bolus) < 0))) {
      error.textContent = 'Укажите положительный сахар, подколку или комментарий.'
      return
    }
    error.textContent = ''
    onSave({ time: String(values.get('time')), glucose, bolus, reason: Number(bolus) ? String(values.get('reason')) : '', comment })
    form.reset()
  }
  return <section className={`p-composer ${compact ? 'p-composer-compact' : ''}`} aria-label="Новая запись">
    <div className="p-section-heading"><div><span className="p-kicker">БЫСТРЫЙ ВВОД</span><h2>{editing ? 'Изменить запись' : 'Добавить запись'}</h2></div><span className="p-round-icon"><Icon kind="plus" /></span></div>
    <form key={editing?.id ?? 'new'} onSubmit={submit}>
      <div className="p-number-fields">
        <label className="p-glucose-field">Сахар <span>ммоль/л</span><input name="glucose" aria-label="Сахар, ммоль/л" inputMode="decimal" placeholder="0,0" pattern="[0-9]+([.,][0-9])?" defaultValue={editing?.glucose} /></label>
        <label>Подколка <span>ед.</span><input name="bolus" aria-label="Подколка, ед." inputMode="decimal" placeholder="—" pattern="[0-9]+([.,][0-9])?" defaultValue={editing?.bolus} /></label>
      </div>
      <div className="p-form-pair"><label>Время · Москва<input name="time" type="time" required defaultValue={editing?.time ?? '16:00'} /></label><label>Причина подколки<select name="reason" defaultValue={editing?.reason ?? ''}><option value="">Не указана</option><option>Еда</option><option>Коррекция</option><option>Еда и коррекция</option></select></label></div>
      <label className="p-comment-field">Комментарий <span>необязательно</span><textarea name="comment" placeholder="Еда, прогулка или пара слов о дне" maxLength={10000} rows={2} defaultValue={editing?.comment} /></label>
      <div className="p-basal-note"><Icon kind="basal" /><span><strong>0,60 ед/ч</strong> · по расписанию<small>Демонстрационная база на время записи</small></span></div>
      <p className="p-form-error" role="alert" />
      <button className="p-primary" type="submit">{editing ? 'Сохранить изменения' : 'Сохранить запись'}<Icon kind="arrow" /></button>
      {editing && <button type="button" className="p-secondary" onClick={onCancel}>Отменить редактирование</button>}
    </form>
  </section>
}

function Timeline({ entries, dense = false, onEdit, onDelete }: { entries: Entry[]; dense?: boolean; onEdit: (entry: Entry) => void; onDelete: (entry: Entry) => void }) {
  return <section className={`p-timeline ${dense ? 'p-dense' : ''}`} id="p-history" aria-label="Хронология дня">
    <div className="p-section-heading"><div><span className="p-kicker">ХРОНОЛОГИЯ</span><h2>Записи дня <span className="p-count">{entries.length}</span></h2></div><span className="p-subtle">Москва</span></div>
    {dense && <div className="p-table-head"><span>Время</span><span>Сахар</span><span>Подколка</span><span>Комментарий</span><span>Действия</span></div>}
    <ol>{entries.map(entry => <li key={entry.id}>
      <time dateTime={`2026-10-20T${entry.time}:00+03:00`}>{entry.time}</time>
      <div className="p-entry-glucose"><strong>{entry.glucose ? decimal(entry.glucose) : '—'}</strong><span>ммоль/л</span></div>
      <div className="p-entry-bolus">{Number(entry.bolus) ? <><strong>{decimal(entry.bolus)} ед.</strong><span>{entry.reason || 'Подколка'}</span></> : <span>Без подколки</span>}</div>
      <p className="p-entry-comment">{entry.comment || <span>Без комментария</span>}</p>
      <div className="p-entry-actions"><button onClick={() => onEdit(entry)} aria-label={`Изменить запись ${entry.time}`}>Изменить</button><button onClick={() => onDelete(entry)} aria-label={`Удалить запись ${entry.time}`}>Удалить</button></div>
    </li>)}</ol>
    {!entries.length && <p className="p-empty">За этот день записей нет. Можно добавить первую.</p>}
    <div className="p-history-foot"><Icon kind="basal" /><span>База на начало дня <strong>0,60 ед/ч</strong> · по расписанию</span></div>
  </section>
}

function DayChart({ entries }: { entries: Entry[] }) {
  const points = entries.filter(entry => entry.glucose).map(entry => ({
    ...entry, x: 45 + (Number(entry.time.slice(0, 2)) * 60 + Number(entry.time.slice(3))) / 1440 * 620,
    y: 165 - Number(entry.glucose) / 10 * 130,
  }))
  return <section className="p-chart" aria-label="Измерения сахара за демонстрационный день">
    <div className="p-section-heading"><div><span className="p-kicker">ИЗМЕРЕНИЯ</span><h2>Сахар в течение дня</h2></div><span className="p-chart-legend"><i />ммоль/л</span></div>
    <svg viewBox="0 0 710 205" role="img" aria-label="Отдельные измерения сахара, без интерполяции между точками">
      {[4, 6, 8, 10].map(value => <g key={value}><line x1="40" y1={165 - value / 10 * 130} x2="680" y2={165 - value / 10 * 130} className="p-grid-line" /><text x="12" y={169 - value / 10 * 130}>{value}</text></g>)}
      {['00:00', '06:00', '12:00', '18:00', '24:00'].map((time, index) => <text key={time} x={45 + index * 155} y="195" textAnchor="middle">{time}</text>)}
      {points.map(point => <g key={point.id}><circle cx={point.x} cy={point.y} r="5" className="p-chart-dot"><title>{point.time}: {decimal(point.glucose)} ммоль/л</title></circle></g>)}
    </svg>
    <p className="p-subtle">Каждая точка — внесённое измерение. Значения между ними неизвестны.</p>
  </section>
}

export function DiaryPrototype() {
  const queryVariant = new URLSearchParams(location.search).get('variant')
  const [variant, setVariant] = useState<Variant>(variants.includes(queryVariant as Variant) ? queryVariant as Variant : 'A')
  const [entries, setEntries] = useState(initialEntries)
  const [day, setDay] = useState('2026-10-20')
  const [editing, setEditing] = useState<Entry | null>(null)
  const [message, setMessage] = useState('')
  const [undo, setUndo] = useState<Entry | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [tab, setTab] = useState('Дневник')

  function changeVariant(next: Variant) {
    setVariant(next)
    const url = new URL(location.href)
    url.searchParams.set('variant', next)
    history.replaceState(null, '', url)
  }
  useEffect(() => {
    function cycle(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        changeVariant(variants[(variants.indexOf(variant) + (event.key === 'ArrowRight' ? 1 : 2)) % 3])
      }
    }
    window.addEventListener('keydown', cycle)
    return () => window.removeEventListener('keydown', cycle)
  }, [variant])

  const visibleEntries = day === '2026-10-20' ? [...entries].sort((a, b) => a.time.localeCompare(b.time) || a.id - b.id) : []
  const measurements = visibleEntries.filter(entry => entry.glucose)
  const average = measurements.length ? decimal((measurements.reduce((total, entry) => total + Number(entry.glucose), 0) / measurements.length).toFixed(1)) : '—'
  const latest = measurements.at(-1)

  function save(entry: Omit<Entry, 'id'>) {
    if (day !== '2026-10-20') { setDay('2026-10-20') }
    setEntries(current => editing ? current.map(row => row.id === editing.id ? { ...entry, id: row.id } : row) : [...current, { ...entry, id: Date.now() }])
    setEditing(null); setFormOpen(false)
    setMessage('Демонстрационная запись сохранена только в памяти. Дата события: 20 октября 2026.')
  }
  const form = <EntryForm compact={variant === 'B'} editing={editing} onSave={save} onCancel={() => { setEditing(null); setFormOpen(false) }} />
  const timeline = <Timeline entries={visibleEntries} dense={variant === 'B'} onEdit={entry => {
    setEditing(entry); setFormOpen(true); setTab('Дневник')
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[name="glucose"]')?.focus())
  }} onDelete={entry => { setUndo(entry); setEntries(current => current.filter(row => row.id !== entry.id)); setMessage('Демонстрационная запись удалена. Можно отменить до следующего удаления или перезагрузки.') }} />
  const navigation = <nav className="p-nav" aria-label="Разделы приложения">{['Дневник', 'Графики', 'База', 'Настройки'].map((name, index) => <button key={name} aria-current={tab === name ? 'page' : undefined} onClick={() => setTab(name)}><Icon kind={['diary', 'chart', 'basal', 'settings'][index]} /><span>{name}</span></button>)}</nav>

  return <div className={`prototype p-variant-${variant}`}>
    <div className="p-demo-banner"><span>ПРОТОТИП</span> Синтетические данные · 20 октября 2026 · изменения исчезнут после перезагрузки</div>
    <div className="p-shell">
      <aside className="p-sidebar"><a href="?prototype=diary" className="p-brand"><span className="p-brand-mark"><Icon kind="diary" /></span>дневник<span className="p-brand-dot">.</span></a>{navigation}<div className="p-sidebar-foot"><span className="p-avatar">Л</span><div>Личный дневник<small>Europe/Moscow</small></div></div></aside>
      <div className="p-workspace">
        <header className="p-topbar"><span>Личное пространство <span className="p-topbar-slash">/</span> <strong>{tab}</strong></span><span className="p-subtle">Москва</span></header>
        <main className="p-main">
          <div className="p-page-heading"><div><span className="p-kicker">ВТОРНИК, 20 ОКТЯБРЯ 2026</span><h1>{tab === 'Дневник' ? variant === 'C' ? 'Ваш день в деталях' : 'Дневник' : tab}</h1><p>{tab === 'Дневник' ? variant === 'A' ? 'Пара секунд, чтобы сохранить важное.' : variant === 'B' ? 'Все события дня. В нужном порядке.' : 'Измерения, записи и немного контекста.' : 'Демонстрационное представление раздела'}</p></div><label className="p-date-control"><span>День просмотра · Москва</span><input aria-label="День просмотра" type="date" value={day} onChange={event => setDay(event.target.value)} required /></label></div>
          {message && <div className="p-notice" role="status"><span>{message}</span>{undo && <button onClick={() => { setEntries(current => [...current, undo]); setUndo(null); setMessage('Демонстрационная запись восстановлена.') }}>Отменить удаление</button>}<button aria-label="Закрыть уведомление" onClick={() => setMessage('')}>×</button></div>}
          {tab === 'Дневник' && <>
            {variant === 'A' && <div className="p-input-layout"><div>{form}<p className="p-under-form">Время события: 20 октября 2026 · Москва.<br />Можно сохранить только подколку или комментарий.</p></div><div>{timeline}<div className="p-margin-note"><span className="p-kicker">БЕЗ ЛИШНИХ ОЦЕНОК</span><p>Ваши записи — чтобы замечать изменения и возвращаться к деталям.</p></div></div></div>}
            {variant === 'B' && <div className="p-feed-layout"><div className="p-inline-summary"><span><strong>{visibleEntries.length}</strong> записи за день</span><span><strong>{average}</strong> ммоль/л · среднее</span><span>База <strong>0,60</strong> ед/ч · по расписанию</span></div>{form}{timeline}</div>}
            {variant === 'C' && <div className="p-overview-layout"><div className="p-overview-cards"><section className="p-latest"><span className="p-kicker">ПОСЛЕДНЕЕ ИЗМЕРЕНИЕ</span><div><strong>{latest ? decimal(latest.glucose) : '—'}</strong><span>ммоль/л</span></div><p>{latest ? `${latest.time} · 20 октября` : 'Измерений нет'}</p></section><section className="p-stat"><span className="p-kicker">СРЕДНИЙ САХАР</span><strong>{average}<small> ммоль/л</small></strong><p>По {measurements.length} измерениям этого дня</p></section><section className="p-add-card"><span className="p-kicker">СОХРАНИТЬ СОБЫТИЕ</span><p>Измерение, подколка<br />или заметка о дне.</p><button className="p-primary" onClick={() => { setFormOpen(!formOpen); setEditing(null) }} aria-expanded={formOpen}><Icon kind="plus" />{formOpen ? 'Закрыть форму' : 'Добавить запись'}</button></section></div>{formOpen && form}<DayChart entries={visibleEntries} />{timeline}</div>}
          </>}
          {tab === 'Графики' && <><DayChart entries={visibleEntries} /><div className="p-margin-note"><p>В этом прототипе показаны отдельные измерения выбранного демонстрационного дня. Недельные и месячные сводки остаются частью будущей реализации.</p></div>{timeline}</>}
          {tab === 'База' && <section className="p-placeholder"><span className="p-kicker">СУТОЧНОЕ РАСПИСАНИЕ · ПРИМЕР</span><h2>База по расписанию</h2><p>00:00–24:00 <strong>0,60 ед/ч</strong></p><p className="p-subtle">Это демонстрационное значение, не фактическая подача помпы. Редактор расписаний в этот прототип не входит.</p></section>}
          {tab === 'Настройки' && <section className="p-placeholder"><span className="p-kicker">О ПРОТОТИПЕ</span><h2>Приватное пространство</h2><p>Рабочий аккаунт, экспорт и резервные копии не подключены.</p><p className="p-subtle">Все записи здесь синтетические. Сохранение, правка и удаление меняют только текущий макет.</p></section>}
          <footer className="p-page-footer"><span>Личный дневник диабета</span><span>Данные без оценок и рекомендаций</span></footer>
        </main>
      </div>
    </div>
    <div className="p-mobile-nav">{navigation}</div>
    <aside className="p-switcher" aria-label="Сравнение вариантов"><div className="p-switcher-controls"><button onClick={() => changeVariant(variants[(variants.indexOf(variant) + 2) % 3])} aria-label="Предыдущий вариант">←</button><div aria-live="polite"><span>ВАРИАНТ {variant} / 3</span><strong>{names[variant]}</strong></div><button onClick={() => changeVariant(variants[(variants.indexOf(variant) + 1) % 3])} aria-label="Следующий вариант">→</button></div><p>{descriptions[variant]}</p></aside>
  </div>
}
