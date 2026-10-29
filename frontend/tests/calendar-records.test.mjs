import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calendarRecords } from '../src/calendarRecords.ts'

test('combines food and all measurements in the same minute without changing source records', () => {
  const entries = [
    { occurred_at: '2026-10-29T12:30:01+03:00', glucose: '5.6', bolus: '0.0', comment: 'До еды' },
    { occurred_at: '2026-10-29T09:30:59.999Z', glucose: '7.0', bolus: '1.2', comment: 'Повтор' },
  ]
  const meals = [
    { occurred_at: '2026-10-29T12:30:20+03:00', lines: [{ name: 'Рис' }] },
    { occurred_at: '2026-10-29T12:30:40+03:00', lines: [{ name: 'Чай' }] },
  ]
  const original = structuredClone({ entries, meals })
  const rows = calendarRecords(entries, meals)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].time, Date.parse('2026-10-29T09:30:00Z'))
  assert.deepEqual(rows[0].entries, entries)
  assert.deepEqual(rows[0].meals, meals)
  assert.deepEqual({ entries, meals }, original)
})

test('keeps different minutes and repeated clock times separate, sorted by real time', () => {
  const entries = [{ occurred_at: '2010-10-31T02:30:00+03:00' }]
  const meals = [
    { occurred_at: '2010-10-31T02:31:00+03:00', lines: [] },
    { occurred_at: '2010-10-31T02:30:00+04:00', lines: [] },
  ]
  const rows = calendarRecords(entries, meals)
  assert.deepEqual(rows.map(row => row.time), [meals[1], entries[0], meals[0]].map(event => Date.parse(event.occurred_at)))
  assert.deepEqual(rows.map(row => [row.entries.length, row.meals.length]), [[0, 1], [1, 0], [0, 1]])
  assert.deepEqual(calendarRecords([], []), [])
})
