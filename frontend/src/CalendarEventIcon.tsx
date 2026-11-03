// shortcut: names select broad food icons; add explicit product icons if name matching is insufficient.
const foodIcons = [
  { match: /чай|кофе|сок|напит|какао|tea|coffee|juice/i, label: 'Напиток', path: 'M4 8h12v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4ZM16 9h2a3 3 0 0 1 0 6h-2M7 3v2m4-2v2' },
  { match: /яйц|омлет|яичниц|egg/i, label: 'Яйца', path: 'M19 14c0 5-3 7-7 7s-7-2-7-7S9 3 12 3s7 6 7 11ZM9 16c0 1 1 2 3 2' },
  { match: /хлеб|булк|тост|лаваш|лепеш|лепёш|bread|toast/i, label: 'Хлеб', path: 'M6 10a4 4 0 0 1 0-8h12a4 4 0 0 1 0 8v11H6ZM9 12v5m6-5v5' },
  { match: /рыб|лосос|сёмг|семг|тунец|треск|fish|salmon/i, label: 'Рыба', path: 'M3 12c4-8 11-8 15 0-4 8-11 8-15 0Zm15 0 4-5v10ZM7 10h.01' },
  { match: /кури|мяс|говяд|свин|индей|котлет|колбас|сосиск|chicken|meat|beef/i, label: 'Мясо', path: 'M10 14c-4-1-6-4-4-7s6-4 9-1 2 7-1 9ZM10 14l-5 5m-2-2a2 2 0 1 0 2 4 2 2 0 1 0 4-2' },
  { match: /яблок|банан|груш|апельс|мандар|ягод|фрукт|виноград|apple|banana|fruit/i, label: 'Фрукты', path: 'M12 7C5 2 1 10 6 18c2 4 4 2 6 2s4 2 6-2c5-8 1-16-6-11Zm0 0V4m0 1c0-3 3-4 5-3-1 3-3 4-5 3Z' },
  { match: /салат|овощ|огур|помид|морков|брокк|капуст|vegetable|salad/i, label: 'Овощи', path: 'M4 20C2 8 9 3 21 3c0 12-5 19-17 17Zm0 0L16 8m-6 6v-4m0 4h5' },
  { match: /молок|кефир|йогурт|творог|сыр|сметан|milk|cheese|yogurt/i, label: 'Молочные продукты', path: 'M8 3h8v4l3 4v10H5V11l3-4Zm0 4h8M5 12h14M9 16h6' },
  { match: /греч|рис|каш|овсян|макарон|паст[ауы]|круп|лапш|rice|pasta|porridge/i, label: 'Крупы и паста', path: 'M3 11h18a9 9 0 0 1-18 0ZM8 21h8M8 3v4m4-4v4m4-4v4' },
  { match: /торт|печень|шоколад|конфет|пирож|десерт|cake|cookie|chocolate/i, label: 'Десерт', path: 'M4 10h16v11H4Zm0 5h16M12 10V6m0 0c-4-2 0-5 0-5s4 3 0 5Z' },
] as const

const icons = {
  meal: { label: 'Еда', path: 'M4 3v6m3-6v6m3-6v6M4 7h6M7 9v12M19 3v18m0-18c-4 3-4 9 0 9' },
  water: { label: 'Вода', path: 'M12 3C9 7 6 10 6 14a6 6 0 0 0 12 0c0-4-3-7-6-11ZM9 14a3 3 0 0 0 3 3' },
  bolus: { label: 'Подколка', path: 'm18 2 4 4m-3-3-5 5m-4-2 8 8m-7-7-7 7v4h4l7-7M4 18l-2 4m5-11 3 3' },
}

export function CalendarEventIcon({ kind, food }: { kind: keyof typeof icons; food?: string }) {
  const name = food ?? ''
  const icon = kind === 'meal' ? foodIcons.filter(icon => icon.match.test(name))
    .sort((a, b) => name.search(a.match) - name.search(b.match))[0] ?? icons.meal : icons[kind]
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <title>{icon.label}</title><path d={icon.path} />
  </svg>
}
