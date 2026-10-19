import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import { Diary } from './Diary'
import { BackupStatus } from './BackupStatus'

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/csrf', { cache: 'no-store' })
  if (!response.ok) throw new Error('Не удалось подключиться. Повторите попытку.')
  return (await response.json()).csrf_token
}

function App() {
  const [login, setLogin] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)

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

  return <main>
    <p className="eyebrow">ДНЕВНИК ДИАБЕТА</p>
    <section aria-labelledby="title">
      <h1 id="title" ref={heading} tabIndex={-1}>{login ? 'Личный дневник' : 'Вход в дневник'}</h1>
      {loading ? <p role="status">Проверяем вход…</p> : login ? <>
        <p>Вы вошли как <strong>{login}</strong>.</p>
        <button type="button" onClick={logout} disabled={busy}>{busy ? 'Выходим…' : 'Выйти'}</button>
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
      {!loading && <Diary active={login !== null} expired={() => { setLogin(null); setError('Сессия истекла. Войдите снова; введённая запись сохранена в форме.') }} csrfToken={csrfToken} />}
      {!loading && login && <section className="settings" aria-labelledby="settings-title">
        <h2 id="settings-title">Настройки</h2>
        <BackupStatus />
        <p id="export-warning">Файл содержит личные сведения и мягко удалённые данные за всю историю. Храните его приватно.</p>
        <a className="download" href="/api/export" download aria-describedby="export-warning">Экспорт всех данных</a>
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
