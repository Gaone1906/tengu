/**
 * Cron schedule parsing and human-readable description utilities.
 * No external dependencies — covers the common patterns used in Jinn cron jobs.
 */

const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']

function formatTime(hour: number, minute: number): string {
  const h = hour % 12 || 12
  const ampm = hour < 12 ? 'AM' : 'PM'
  const m = minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`
  return `${h}${m} ${ampm}`
}

function formatTimeWithMinute(hour: number, minute: number): string {
  const h = hour % 12 || 12
  const ampm = hour < 12 ? 'AM' : 'PM'
  return `${h}:${String(minute).padStart(2, '0')} ${ampm}`
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * e.g. 147116 -> "2m 27s", 45000 -> "45s", 3600000 -> "1h 0m"
 */
export function formatDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '\u2014'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return `${hrs}h ${remMins}m`
}

/**
 * Parse a 5-field cron expression into schedule slots for weekly grid display.
 * Returns { hour, minute, days } where days is 0=Sun..6=Sat.
 * Returns null for unparseable expressions.
 */
export function parseScheduleSlots(
  schedule: string
): { hour: number; minute: number; days: number[] } | null {
  if (!schedule || !schedule.trim()) return null
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const [min, hour, , , dow] = parts
  const minNum = parseInt(min, 10)
  const hourNum = parseInt(hour, 10)
  if (isNaN(minNum) || isNaN(hourNum)) return null

  let days: number[]

  if (dow === '*') {
    days = [0, 1, 2, 3, 4, 5, 6]
  } else if (dow === '1-5') {
    days = [1, 2, 3, 4, 5]
  } else if (dow === '0-6' || dow === '0,1,2,3,4,5,6') {
    days = [0, 1, 2, 3, 4, 5, 6]
  } else if (dow.includes(',')) {
    days = dow.split(',').map(Number).filter(n => !isNaN(n) && n >= 0 && n <= 6)
    if (days.length === 0) return null
  } else {
    const dowNum = parseInt(dow, 10)
    if (isNaN(dowNum) || dowNum < 0 || dowNum > 6) return null
    days = [dowNum]
  }

  return { hour: hourNum, minute: minNum, days }
}

/**
 * Convert a 5-field cron expression to a human-readable description.
 * Falls back to the raw expression for anything unparseable.
 */
export function describeCron(schedule: string): string {
  if (!schedule || !schedule.trim()) return ''

  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return schedule

  const [min, hour, dom, , dow] = parts

  // Every minute: * * * * *
  if (min === '*' && hour === '*' && dom === '*' && dow === '*') {
    return 'Every minute'
  }

  // Every N minutes: */5 * * * *
  if (min.startsWith('*/') && hour === '*' && dom === '*' && dow === '*') {
    const interval = parseInt(min.slice(2), 10)
    if (!isNaN(interval)) {
      return `Every ${interval} minutes`
    }
  }

  // Every hour: 0 * * * *
  if (min !== '*' && hour === '*' && dom === '*' && dow === '*') {
    return 'Every hour'
  }

  const hourNum = parseInt(hour, 10)
  const minNum = parseInt(min, 10)
  if (isNaN(hourNum) || isNaN(minNum)) return schedule

  const time = minNum === 0 ? formatTime(hourNum, minNum) : formatTimeWithMinute(hourNum, minNum)

  // Every N days: 0 12 */2 * *
  if (dom.startsWith('*/') && dow === '*') {
    const interval = parseInt(dom.slice(2), 10)
    if (!isNaN(interval)) {
      return `Every ${interval} days at ${time}`
    }
  }

  // Monthly: 0 8 1 * *
  if (dom !== '*' && dow === '*') {
    const dayNum = parseInt(dom, 10)
    if (!isNaN(dayNum)) {
      const suffix = dayNum === 1 ? 'st' : dayNum === 2 ? 'nd' : dayNum === 3 ? 'rd' : 'th'
      return `Monthly on the ${dayNum}${suffix} at ${time}`
    }
  }

  // Weekdays: 0 10 * * 1-5
  if (dom === '*' && dow === '1-5') {
    return `Weekdays at ${time}`
  }

  // Specific day of week: 0 6 * * 1
  if (dom === '*') {
    const dowNum = parseInt(dow, 10)
    if (!isNaN(dowNum) && dowNum >= 0 && dowNum <= 6) {
      return `${DAY_NAMES[dowNum]} at ${time}`
    }
  }

  // Daily: 0 8 * * *
  if (dom === '*' && dow === '*') {
    return `Daily at ${time}`
  }

  return schedule
}

/* ------------------------------------------------------------------ */
/*  Next-run computation                                               */
/*                                                                     */
/*  The gateway's scheduler (node-cron v3) exposes no next-fire time,  */
/*  so the Cron page computes it here: standard 5-field cron with      */
/*  lists/ranges/steps and the dom∪dow union rule, in the job's IANA   */
/*  timezone. Anything unparseable returns null — the UI shows nothing */
/*  rather than a wrong time.                                          */
/* ------------------------------------------------------------------ */

// Expand one cron field ("*", "*/N", "A", "A-B", "A-B/N", "A,B,C") into a
// Set of allowed values, or null when unparseable. `dow` 7 folds to 0.
function expandField(field: string, min: number, max: number, foldSeven = false): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const stepMatch = /^(.+?)\/(\d+)$/.exec(part)
    const base = stepMatch ? stepMatch[1] : part
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1
    if (!Number.isFinite(step) || step < 1) return null
    let lo: number
    let hi: number
    if (base === '*') {
      lo = min
      hi = max
    } else {
      const range = /^(\d+)(?:-(\d+))?$/.exec(base)
      if (!range) return null
      lo = parseInt(range[1], 10)
      hi = range[2] !== undefined ? parseInt(range[2], 10) : stepMatch ? max : lo
    }
    if (lo < min || hi > max || lo > hi) return null
    // dow accepts 0-7 with 7 folding to Sunday at add time.
    for (let v = lo; v <= hi; v += step) out.add(foldSeven && v === 7 ? 0 : v)
  }
  return out.size > 0 ? out : null
}

interface CronSets {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

function parseCronFields(schedule: string): CronSets | null {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minF, hourF, domF, monF, dowF] = parts
  const minute = expandField(minF, 0, 59)
  const hour = expandField(hourF, 0, 23)
  const dom = expandField(domF, 1, 31)
  const month = expandField(monF, 1, 12)
  const dow = expandField(dowF, 0, 7, true)
  if (!minute || !hour || !dom || !month || !dow) return null
  return {
    minute, hour, dom, month, dow,
    domRestricted: domF !== '*',
    dowRestricted: dowF !== '*',
  }
}

interface WallClock {
  minute: number
  hour: number
  dom: number
  month: number
  dow: number
}

const dtfCache = new Map<string, Intl.DateTimeFormat>()

function tzFormatter(timezone: string | undefined): Intl.DateTimeFormat | null {
  const key = timezone ?? ''
  const cached = dtfCache.get(key)
  if (cached) return cached
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      ...(timezone ? { timeZone: timezone } : {}),
      hour12: false,
      minute: 'numeric',
      hour: 'numeric',
      day: 'numeric',
      month: 'numeric',
      weekday: 'short',
    })
    dtfCache.set(key, dtf)
    return dtf
  } catch {
    return null // unknown IANA name
  }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function wallClockAt(t: number, dtf: Intl.DateTimeFormat): WallClock {
  const parts = dtf.formatToParts(t)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    minute: parseInt(get('minute'), 10),
    // hour12:false can yield "24" at midnight in some engines; fold it.
    hour: parseInt(get('hour'), 10) % 24,
    dom: parseInt(get('day'), 10),
    month: parseInt(get('month'), 10),
    dow: WEEKDAYS[get('weekday')] ?? 0,
  }
}

function matches(w: WallClock, sets: CronSets): boolean {
  if (!sets.minute.has(w.minute) || !sets.hour.has(w.hour) || !sets.month.has(w.month)) return false
  // Standard cron: when BOTH dom and dow are restricted, either may match.
  if (sets.domRestricted && sets.dowRestricted) return sets.dom.has(w.dom) || sets.dow.has(w.dow)
  return sets.dom.has(w.dom) && sets.dow.has(w.dow)
}

const MINUTE = 60_000
const HOUR = 3_600_000
/** How far ahead to search before giving up (monthly jobs need ~31 days). */
const HORIZON_MS = 60 * 86_400_000

/**
 * The next instant a 5-field cron expression fires at or after `from`
 * (exclusive of `from`'s own minute), in `timezone` (defaults to the
 * browser's). Returns null for unparseable expressions, unknown timezones,
 * or nothing within 60 days.
 */
export function nextCronDate(schedule: string, timezone?: string, from: Date = new Date()): Date | null {
  const sets = parseCronFields(schedule)
  if (!sets) return null
  const dtf = tzFormatter(timezone)
  if (!dtf) return null

  // Start at the next whole minute after `from`.
  const start = Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE
  const end = start + HORIZON_MS

  // Hour-block scan: check each hour's start; only minute-scan hours whose
  // hour/day/month could match (the wall hour at any minute of a UTC hour is
  // the start's hour or the one after it, for non-whole-hour tz offsets).
  for (let hourStart = start; hourStart < end; ) {
    const nextHour = Math.floor(hourStart / HOUR) * HOUR + HOUR
    const w = wallClockAt(hourStart, dtf)
    // Prefilter on hour only — day/month roll mid-block in half-hour-offset
    // timezones, so they're validated by the full minute-scan instead.
    const candidate = sets.hour.has(w.hour) || sets.hour.has((w.hour + 1) % 24)
    if (candidate) {
      for (let t = hourStart; t < nextHour && t < end; t += MINUTE) {
        if (matches(wallClockAt(t, dtf), sets)) return new Date(t)
      }
    }
    hourStart = nextHour
  }
  return null
}

/** Compact "at a glance" label for a next fire: "in 45m", "in 5h",
 *  "Mon 9 AM", "Aug 1". Empty string when `next` is null. */
export function formatNextRun(next: Date | null, now: Date = new Date()): string {
  if (!next) return ''
  const diff = next.getTime() - now.getTime()
  if (diff <= 0) return 'now'
  const mins = Math.round(diff / MINUTE)
  if (mins < 60) return `in ${mins}m`
  if (mins < 24 * 60) return `in ${Math.round(mins / 60)}h`
  if (diff < 7 * 86_400_000) {
    const day = next.toLocaleDateString('en-US', { weekday: 'short' })
    return `${day} ${formatTime(next.getHours(), next.getMinutes())}`
  }
  return next.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Friendly absolute time for run history: "Today, 8:00 AM",
 *  "Yesterday, 8:00 AM", "Jul 9, 8:00 AM" (+year when not this year). */
export function formatRunTime(iso: string | number, now: Date = new Date()): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const time = formatTimeWithMinute(d.getHours(), d.getMinutes())
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (dayDiff === 0) return `Today, ${time}`
  if (dayDiff === 1) return `Yesterday, ${time}`
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' }
  return `${d.toLocaleDateString('en-US', opts)}, ${time}`
}

/** Relative "ran 2h ago" ago-label. Returns "" for missing input. */
export function agoLabel(iso: string | number | null | undefined, now: Date = new Date()): string {
  if (iso == null || iso === '') return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const diff = now.getTime() - d.getTime()
  if (diff < MINUTE) return 'just now'
  const mins = Math.floor(diff / MINUTE)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}
