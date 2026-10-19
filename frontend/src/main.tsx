import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import { Diary } from './Diary'
import { BackupStatus, useBackupStatus } from './BackupStatus'
import { privateFetch, setAccess } from './access'

async function csrfToken(request: (path: string, options?: RequestInit) => Promise<Response> = fetch): Promise<string> {
  const response = await request('/api/auth/csrf', { cache: 'no-store' })
  if (!response.ok) throw new Error('Не удалось подключиться. Повторите попытку.')
  return (await response.json()).csrf_token
}

type Section = 'diary' | 'charts' | 'basal' | 'settings'
type Route = { section: Section; day: string; temporary: boolean; error: string }
function readRoute(): Route {
  const params = new URLSearchParams(location.search)
  const section = params.get('section') ?? 'diary'
  const day = params.get('day') ?? ''
  const valid = !day || (/^\d{4}-\d{2}-\d{2}$/.test(day) && day >= '0001-01-01' && day <= '9999-12-31' && Number.isFinite(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day)
  return { section: ['diary', 'charts', 'basal', 'settings'].includes(section) ? section as Section : 'diary', day: valid ? day : '', temporary: params.get('view') === 'temporary', error: valid ? '' : 'Некорректная дата в адресе. Открыт текущий московский день.' }
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
    setRoute(next)
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
  const backup = useBackupStatus(login !== null)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState('')

  function expired() {
    setLogin(null)
    setError('Сессия истекла. Войдите снова; черновики сохранены. Продолжите операцию явно.')
  }
  setAccess(login !== null, expired)

  useEffect(() => {
    fetch('/api/auth/session', { cache: 'no-store' })
      .then(async response => {
        if (response.ok) setLogin((await response.json()).login)
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
    <p className="eyebrow">ДНЕВНИК ДИАБЕТА</p>
    <section className="workspace">
      <h1 id="title" ref={heading} tabIndex={-1}>{login ? ({ diary: 'Дневник', charts: 'Графики', basal: 'База', settings: 'Настройки' }[route.section]) : 'Вход в дневник'}</h1>
      {loading ? <p role="status">Проверяем вход…</p> : login ? <>
        <nav className="main-nav" aria-label="Разделы">
          {([['diary', 'Дневник'], ['charts', 'Графики'], ['basal', 'База'], ['settings', 'Настройки']] as const).map(([section, label]) => <a key={section} href={routeUrl({ ...route, section })} aria-current={route.section === section ? 'page' : undefined} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate({ ...route, section }) } }}>{label}</a>)}
        </nav>
        <div className="account-row"><p className="account">Вы вошли как <strong>{login}</strong>.</p>
        <button type="button" onClick={logout} disabled={busy}>{busy ? 'Выходим…' : 'Выйти'}</button></div>
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
      {!loading && <Diary active={login !== null} section={route.section} day={route.day} temporary={route.temporary} onDay={(day, open = false) => navigate({ ...currentRoute.current, day, section: open ? 'diary' : currentRoute.current.section }, !currentRoute.current.day)} onView={temporary => navigate({ ...route, temporary })} csrfToken={privateCsrfToken} />}
      {!loading && login && <section hidden={route.section !== 'settings'} className="settings" aria-labelledby="settings-title">
        <h2 id="settings-title">Настройки</h2>
        <div className="settings-grid">
        <section aria-labelledby="account-title"><span className="eyebrow">ДОСТУП</span><h3 id="account-title">Аккаунт</h3><p>Вы вошли как <strong>{login}</strong>.</p><p className="muted">Кнопка «Выйти» закрывает доступ на этом устройстве. Другие устройства сохранят вход.</p></section>
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
