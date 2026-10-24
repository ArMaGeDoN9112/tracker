const moscowDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export function localMinute(value: string) {
  const parts = Object.fromEntries(moscowDate.formatToParts(new Date(value)).map(part => [part.type, part.value]))
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

export function basalText(value: string | null) {
  return value === null ? 'неизвестна' : `${value.replace('.', ',')} ед/ч`
}

export function moscowLabel(value: string) {
  return new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
