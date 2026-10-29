// LoopKit Fiasp preset and exponential IOB model:
// https://github.com/LoopKit/LoopKit/blob/dev/LoopKit/InsulinKit/ExponentialInsulinModel.swift
const duration = 360
const peak = 55
const delay = 10
const tau = peak * (1 - peak / duration) / (1 - 2 * peak / duration)
const a = 2 * tau / duration
const scale = 1 / (1 - a + (1 + a) * Math.exp(-duration / tau))

export function fiaspRemaining(minutes: number): number {
  if (minutes < 0) return 0
  const t = minutes - delay
  if (t <= 0) return 1
  if (t >= duration) return 0
  return Math.max(0, Math.min(1, 1 - scale * (1 - a)
    * ((t * t / (tau * duration * (1 - a)) - t / tau - 1) * Math.exp(-t / tau) + 1)))
}

export function activeInsulinPoints(entries: { occurred_at: string; bolus: string }[], start: number, end: number) {
  const doses = entries.map(entry => ({ time: Date.parse(entry.occurred_at), units: Number(entry.bolus) }))
    .filter(dose => dose.units > 0 && dose.time >= start - (duration + delay) * 60000 && dose.time <= end)
  const times = new Set([start, end])
  for (let time = start; time < end; time += 5 * 60000) times.add(time)
  for (const dose of doses) {
    // Preserve the jump at delivery, including doses between the sampling times.
    for (const time of [dose.time - 1, dose.time, dose.time + (duration + delay) * 60000]) {
      if (time >= start && time <= end) times.add(time)
    }
  }
  return [...times].sort((a, b) => a - b).map(time => ({ time,
    value: doses.reduce((sum, dose) => sum + dose.units * fiaspRemaining((time - dose.time) / 60000), 0),
  }))
}
