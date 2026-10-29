import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fiaspRemaining, activeInsulinPoints } from '../src/activeInsulin.ts'

test('Fiasp has no effect before delivery, a delay, and a bounded decreasing 370-minute tail', () => {
  assert.equal(fiaspRemaining(-0.001), 0)
  assert.equal(fiaspRemaining(0), 1)
  assert.equal(fiaspRemaining(10), 1)
  assert.equal(fiaspRemaining(370), 0)
  assert.equal(fiaspRemaining(500), 0)
  let previous = 1
  for (let minute = 10; minute <= 370; minute++) {
    const remaining = fiaspRemaining(minute)
    assert.ok(remaining >= 0 && remaining <= previous)
    previous = remaining
  }
  // Independent numeric integration of normalized activity t * (1 - t / duration) * exp(-t / tau).
  const tau = 55 * (1 - 55 / 360) / (1 - 110 / 360)
  let total = 0, tail = 0
  for (let t = 0.005; t < 360; t += 0.01) {
    const activity = t * (1 - t / 360) * Math.exp(-t / tau)
    total += activity
    if (t >= 110) tail += activity
  }
  assert.ok(Math.abs(fiaspRemaining(120) - tail / total) < 1e-7)
})

test('sums overlapping doses, carries the previous evening, and preserves exact delivery jumps', () => {
  const start = Date.parse('2026-10-29T00:00:00+03:00')
  const end = start + 86400000
  const entries = [
    { occurred_at: '2026-10-28T23:00:00+03:00', bolus: '2.0' },
    { occurred_at: '2026-10-28T17:00:00+03:00', bolus: '100.0' },
    { occurred_at: '2026-10-29T01:02:30+03:00', bolus: '1.5' },
    { occurred_at: '2026-10-29T01:02:30+03:00', bolus: '0.5' },
    { occurred_at: '2026-10-29T12:00:00+03:00', bolus: '0.0' },
  ]
  const original = structuredClone(entries)
  const points = activeInsulinPoints(entries, start, end)
  assert.equal(points[0].value, 2 * fiaspRemaining(60))
  const time = Date.parse(entries[2].occurred_at)
  assert.equal(points.find(row => row.time === time).value, 2 * fiaspRemaining(122.5) + 2)
  assert.ok(points.find(row => row.time === time - 1).value < 2)
  assert.equal(points.at(-1).value, 0)
  assert.equal(points.at(-1).time, end)
  assert.ok(activeInsulinPoints([], start, end).every(row => row.value === 0))
  assert.deepEqual(entries, original)
})
