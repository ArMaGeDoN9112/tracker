let authorized = false
let expired = () => {}
let session = 0

export function setAccess(active: boolean, onExpired: () => void) {
  if (active !== authorized) session++
  authorized = active
  expired = onExpired
}

export async function privateFetch(path: string, options?: RequestInit) {
  if (!authorized) throw new Error('Войдите для продолжения.')
  const current = session
  const response = await fetch(path, { cache: 'no-store', ...options })
  if (current !== session || !authorized) throw new Error('Войдите для продолжения.')
  if (response.status === 401) {
    authorized = false
    session++
    expired()
  }
  return response
}
