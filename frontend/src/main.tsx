import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import { Diary } from './Diary'
import { Nutrition } from './Nutrition'
import { BackupStatus, useBackupStatus } from './BackupStatus'
import { privateFetch, setAccess } from './access'
import { localMinute } from './time'

async function csrfToken(request: (path: string, options?: RequestInit) => Promise<Response> = fetch): Promise<string> {
  const response = await request('/api/auth/csrf', { cache: 'no-store' })
  if (!response.ok) throw new Error('Не удалось подключиться. Повторите попытку.')
  return (await response.json()).csrf_token
}

type Section = 'diary' | 'charts' | 'basal' | 'nutrition' | 'nutrition-summary' | 'catalog' | 'calendar' | 'settings'
type Route = { section: Section; day: string; temporary: boolean; error: string }
function readRoute(): Route {
  const params = new URLSearchParams(location.search)
  const section = params.get('section') ?? 'calendar'
  const knownSection = ['diary', 'charts', 'basal', 'nutrition', 'nutrition-summary', 'catalog', 'calendar', 'settings'].includes(section) ? section as Section : 'calendar'
  const day = params.get('day') ?? ''
  // The API needs both Moscow day bounds, and calendar summaries need a whole month.
  const valid = !day || (/^\d{4}-\d{2}-\d{2}$/.test(day) && day > '0001-01-01' && day < '9999-12-31' && (knownSection !== 'calendar' || (day >= '0001-02-01' && day <= '9999-11-30')) && Number.isFinite(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day)
  return { section: knownSection, day: (valid ? day : '') || (knownSection === 'calendar' ? localMinute(new Date().toISOString()).slice(0, 10) : ''), temporary: params.get('view') === 'temporary', error: valid ? '' : 'Некорректная дата в адресе. Открыт текущий московский день.' }
}
function routeUrl(route: Route) {
  const params = new URLSearchParams({ section: route.section })
  if (route.day) params.set('day', route.day)
  if (route.section === 'basal' && route.temporary) params.set('view', 'temporary')
  return `?${params}`
}

const privateCsrfToken = () => csrfToken(privateFetch)

function App() {
  const [route, setRoute] = useState(readRoute)
  const currentRoute = useRef(route)
  currentRoute.current = route
  function navigate(next: Route, replace = false) {
    history[replace ? 'replaceState' : 'pushState'](null, '', routeUrl(next))
    const parsed = readRoute()
    setRoute({ ...parsed, temporary: next.temporary, error: replace ? next.error || parsed.error : parsed.error })
  }
  useEffect(() => {
    const pop = () => setRoute(readRoute())
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [])
  const [login, setLogin] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (login) heading.current?.focus() }, [login, route.section, route.temporary])
  const group = ['diary', 'charts', 'basal'].includes(route.section) ? 'diary' : ['nutrition', 'nutrition-summary', 'catalog'].includes(route.section) ? 'nutrition' : route.section
  const pages: [Section, string][] = group === 'diary' ? [['diary', 'Ввод'], ['charts', 'Анализ'], ['basal', 'База']] : group === 'nutrition' ? [['nutrition', 'Ввод'], ['nutrition-summary', 'Анализ'], ['catalog', 'Каталог']] : []
  const backup = useBackupStatus(login !== null)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState('')

  function expired() {
    setLogin(null)
    setError('Сессия истекла. Войдите снова. Повтор операции доступен только явно.')
  }
  setAccess(login !== null, expired)

  useEffect(() => {
    fetch('/api/auth/session', { cache: 'no-store' })
      .then(async response => {
        if (response.ok) { setRoute(current => ({ ...readRoute(), temporary: current.temporary })); setLogin((await response.json()).login) }
        else if (response.status !== 401) throw new Error()
      })
      .catch(() => setError('Не удалось подключиться. Повторите попытку.'))
      .finally(() => setLoading(false))
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const csrf = await csrfToken()
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ login: username, password }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message)
      setRoute(current => ({ ...readRoute(), temporary: current.temporary }))
      setLogin(result.login)
      setPassword('')
      requestAnimationFrame(() => heading.current?.focus())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Ошибка сети. Повторите попытку.')
    } finally {
      setBusy(false)
    }
  }

  async function logout() {
    setBusy(true)
    setError('')
    try {
      const csrf = await csrfToken()
      const response = await fetch('/api/auth/logout', {
        method: 'POST', headers: { 'X-CSRF-Token': csrf },
      })
      if (!response.ok && response.status !== 401) throw new Error('Не удалось выйти. Повторите попытку.')
      setLogin(null)
      setPassword('')
      requestAnimationFrame(() => heading.current?.focus())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Ошибка сети. Повторите попытку.')
    } finally {
      setBusy(false)
    }
  }

  async function downloadExport(event: React.MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()
    if (exportBusy) return
    setExportBusy(true); setExportError('')
    try {
      const response = await privateFetch('/api/auth/session')
      if (!response.ok) throw new Error('Войдите снова и повторите экспорт явно.')
      const link = document.createElement('a')
      link.href = '/api/export'; link.download = ''
      link.click()
    } catch (failure) {
      setExportError(failure instanceof Error ? failure.message : 'Не удалось проверить вход. Повторите экспорт.')
    } finally { setExportBusy(false) }
  }

  return <main className={login ? "app-shell" : "login-screen"}>
    {login ? <>
      <aside className="app-sidebar" aria-label="Личный дневник"><div className="app-brand" aria-label="Дневник">д</div><span className="sidebar-caption">Личный<br />дневник</span></aside>
      <header className="app-topbar"><p>Личное пространство <span>/ {({ diary: 'Диабет', charts: 'Диабет', basal: 'Диабет', nutrition: 'Питание', 'nutrition-summary': 'Питание', catalog: 'Питание', calendar: 'Календарь', settings: 'Настройки' }[route.section])}</span></p>
        <div className="account-row"><p className="account">Вы вошли как <strong>{login}</strong>.</p><button type="button" onClick={logout} disabled={busy}>{busy ? 'Выходим…' : 'Выйти'}</button></div>
      </header>
    </> : <div className="login-brand"><div className="app-brand" aria-hidden="true">д</div><p className="eyebrow">ЛИЧНЫЙ ДНЕВНИК</p></div>}
    {!login && <aside className="login-intro"><span className="eyebrow">ЛИЧНОЕ ПРОСТРАНСТВО</span><h2>Место для<br />вашего дня.</h2><p>Сахар, питание и вода.<br />В одном спокойном ритме.</p></aside>}
    <section className="workspace">
      <div className="page-heading">
      <div>
      {login && <p className="workspace-caption">ОБЗОР / {route.day ? route.day.split('-').reverse().join('.') : 'ЛИЧНЫЙ ДНЕВНИК'}</p>}
      <h1 id="title" ref={heading} tabIndex={-1}>{login ? ({ diary: 'Ввод сахара', charts: 'Аналитика сахара', basal: 'База', nutrition: 'Ввод питания', 'nutrition-summary': 'Аналитика питания', catalog: 'Каталог еды', calendar: 'Календарь', settings: 'Настройки' }[route.section]) : 'Вход в дневник'}</h1>
      {login && <p className="page-description">{{ diary: 'Измерения, подколки и контекст события.', charts: 'От общей картины — к записям выбранного дня.', basal: 'Суточное расписание и временные изменения.', nutrition: 'Приёмы пищи, продукты и вода.', 'nutrition-summary': 'Итоги периода, приёмы пищи и вода.', catalog: 'Ваши продукты, их состав и порции.', calendar: 'Сахар, питание и вода — целостная картина дня.', settings: 'Приватное пространство для ваших данных.' }[route.section]}</p>}
      </div>
      {login && route.section === 'calendar' && <div className="page-actions"><button className="primary-action" onClick={() => navigate({ ...route, section: 'diary' })}>+ Записать сахар</button><button onClick={() => navigate({ ...route, section: 'nutrition' })}>+ Добавить еду</button></div>}
      </div>
      {loading ? <p role="status">Проверяем вход…</p> : login ? <>
        <nav className="main-nav" aria-label="Разделы">
          {([['calendar', 'Календарь', 'M5 5h14v16H5zM8 3v4m8-4v4M5 10h14m-10 4h2m2 0h2m-6 3h2'], ['diary', 'Диабет', 'M12 3C9 7 6 10 6 14a6 6 0 0 0 12 0c0-4-3-7-6-11Z'], ['nutrition', 'Питание', 'M5 3v6m3-6v6m3-6v6M5 7h6M8 9v12M19 3v18m0-18c-4 3-4 9 0 9'], ['settings', 'Настройки', 'M4 7h16M4 17h16M8 4v6m8 4v6']] as const).map(([section, label, icon]) => <a key={section} href={routeUrl({ ...route, section })} aria-current={group === section ? (route.section === section ? 'page' : 'true') : undefined} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate({ ...route, section }) } }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icon} /></svg>{label}</a>)}
        </nav>
        {pages.length > 0 && <nav className="basal-nav section-nav" aria-label={group === 'diary' ? 'Страницы диабета' : 'Страницы питания'}>
          {pages.map(([section, label]) => <a key={section} href={routeUrl({ ...route, section })} aria-current={route.section === section ? 'page' : undefined} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate({ ...route, section }) } }}>{label}</a>)}
        </nav>}
      </> : <>
        <p className="muted">Ваши записи доступны только после входа.</p>
        <form onSubmit={submit} aria-busy={busy}>
          <label htmlFor="login">Логин</label>
          <input id="login" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false}
            required value={username} onChange={e => setUsername(e.target.value)} />
          <label htmlFor="password">Пароль</label>
          <input id="password" name="password" type="password" autoComplete="current-password"
            required value={password} onChange={e => setPassword(e.target.value)} />
          <button disabled={busy} type="submit">{busy ? 'Входим…' : 'Войти'}</button>
        </form>
        <p className="muted hint">Вход сохранится на этом устройстве на 30 дней.</p>
      </>}
      {error && <p role="alert" className="error">{error}</p>}
      {login && route.error && <p role="alert" className="error">{route.error}</p>}
      {login && route.section !== 'settings' && (backup.error || backup.status?.overdue || backup.status?.error || backup.status?.verification_error) && <aside className="backup-warning" aria-label="Предупреждение резервирования">
        <p>{backup.error ? 'Состояние резервирования неизвестно.' : 'Резервирование требует внимания.'}</p>
        <a href={routeUrl({ ...route, section: 'settings' })} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate({ ...route, section: 'settings' }) } }}>Проверить резервирование</a>
      </aside>}
      <div id="global-undo" hidden={!login} />
      {!loading && <Nutrition authorized={login !== null} visible={route.section === 'nutrition'} summaryVisible={route.section === 'nutrition-summary'} catalogVisible={route.section === 'catalog'} day={route.day} onDay={(day, open = false) => navigate({ ...currentRoute.current, day, section: open ? 'nutrition-summary' : currentRoute.current.section }, !currentRoute.current.day)} onInput={() => navigate({ ...currentRoute.current, section: 'nutrition' })} csrfToken={privateCsrfToken} />}
      {!loading && <Diary active={login !== null} section={route.section} day={route.day} temporary={route.temporary} onDay={(day, open = false) => navigate({ ...currentRoute.current, day, section: open ? 'charts' : currentRoute.current.section }, !currentRoute.current.day)} onNutrition={day => navigate({ ...currentRoute.current, day, section: 'nutrition-summary' })} onView={temporary => navigate({ ...route, temporary })} csrfToken={privateCsrfToken} />}
      {!loading && login && <section hidden={route.section !== 'settings'} className="settings" aria-labelledby="settings-title">
        <h2 id="settings-title" className="sr-only">Настройки</h2>
        <div className="settings-grid">
        <section aria-labelledby="account-title"><span className="eyebrow">ДОСТУП</span><h3 id="account-title">Аккаунт</h3><p>Логин: <strong>{login}</strong>.</p><p className="muted">Кнопка «Выйти» закрывает доступ на этом устройстве. Другие устройства сохранят вход.</p></section>
        <section aria-labelledby="export-title"><span className="eyebrow">ЛИЧНЫЙ АРХИВ</span><h3 id="export-title">Экспорт</h3>
        <p id="export-warning">Файл содержит личные сведения и мягко удалённые данные за всю историю. Храните его приватно.</p>
        <a className="download" href="/api/export" download aria-describedby="export-warning" aria-busy={exportBusy} onClick={downloadExport}>Экспорт всех данных</a>
        {exportBusy && <p role="status">Проверяем вход перед скачиванием…</p>}
        {exportError && <p role="alert" className="error">{exportError}</p>}
        </section>
        <BackupStatus {...backup} />
        </div>
      </section>}
    </section>
  </main>
}

const root = createRoot(document.getElementById('root')!)
if (import.meta.env.DEV && new URLSearchParams(location.search).get('prototype') === 'diary') {
  import('./DiaryPrototype').then(({ DiaryPrototype }) => root.render(<DiaryPrototype />))
} else {
  root.render(<App />)
}
