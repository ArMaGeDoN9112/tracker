const moscowDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export function localMinute(value: string) {
  const parts = Object.fromEntries(moscowDate.formatToParts(new Date(value)).map(part => [part.type, part.value]))
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

export function moscowDayBounds(day: string): [number, number] {
  // Historical Moscow days can repeat or skip hours, including at midnight.
  const noon = Date.parse(`${day}T12:00:00Z`)
  function boundary(after: boolean) {
    let left = noon - 48 * 3600000
    let right = noon + 48 * 3600000
    while (left < right) {
      const middle = Math.floor((left + right) / 2)
      const date = localMinute(new Date(middle).toISOString()).slice(0, 10)
      if (date < day || (after && date === day)) left = middle + 1
      else right = middle
    }
    return left
  }
  return [boundary(false), boundary(true)]
}

export function basalText(value: string | null) {
  return value === null ? 'неизвестна' : `${value.replace('.', ',')} ед/ч`
}

export function moscowLabel(value: string) {
  return new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
