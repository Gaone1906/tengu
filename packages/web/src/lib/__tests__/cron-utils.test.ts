import { describe, expect, it } from "vitest"
import { agoLabel, formatNextRun, formatRunTime, nextCronDate } from "../cron-utils"
import { filterJobs, groupJobsByEmployee, runOutcome, type CronJobWire } from "@/routes/cron/shared"

/* nextCronDate computes in the given IANA timezone (defaults to the runner's
 * local zone). Tests pin `timezone: "UTC"` so wall-clock expectations are
 * machine-independent, then exercise a real offset zone separately. */

const at = (iso: string) => new Date(iso)

describe("nextCronDate", () => {
  it("finds the next daily fire (same day)", () => {
    const next = nextCronDate("0 8 * * *", "UTC", at("2026-07-11T05:30:00Z"))
    expect(next?.toISOString()).toBe("2026-07-11T08:00:00.000Z")
  })

  it("rolls to tomorrow when today's fire has passed", () => {
    const next = nextCronDate("0 8 * * *", "UTC", at("2026-07-11T09:00:00Z"))
    expect(next?.toISOString()).toBe("2026-07-12T08:00:00.000Z")
  })

  it("is exclusive of the current minute", () => {
    const next = nextCronDate("30 8 * * *", "UTC", at("2026-07-11T08:30:00Z"))
    expect(next?.toISOString()).toBe("2026-07-12T08:30:00.000Z")
  })

  it("handles */N minute steps", () => {
    const next = nextCronDate("*/15 * * * *", "UTC", at("2026-07-11T10:16:00Z"))
    expect(next?.toISOString()).toBe("2026-07-11T10:30:00.000Z")
  })

  it("handles day-of-week (2026-07-11 is a Saturday)", () => {
    const next = nextCronDate("0 9 * * 1", "UTC", at("2026-07-11T12:00:00Z"))
    expect(next?.toISOString()).toBe("2026-07-13T09:00:00.000Z") // Monday
  })

  it("folds dow 7 to Sunday", () => {
    const next = nextCronDate("0 9 * * 7", "UTC", at("2026-07-11T12:00:00Z"))
    expect(next?.toISOString()).toBe("2026-07-12T09:00:00.000Z") // Sunday
  })

  it("handles weekday ranges", () => {
    const next = nextCronDate("0 10 * * 1-5", "UTC", at("2026-07-11T12:00:00Z"))
    expect(next?.toISOString()).toBe("2026-07-13T10:00:00.000Z") // Sat → Monday
  })

  it("handles day-of-month", () => {
    const next = nextCronDate("0 6 1 * *", "UTC", at("2026-07-11T12:00:00Z"))
    expect(next?.toISOString()).toBe("2026-08-01T06:00:00.000Z")
  })

  it("uses the dom ∪ dow union when both are restricted", () => {
    // Standard cron: fires on the 20th OR on Sundays, whichever comes first.
    const next = nextCronDate("0 6 20 * 0", "UTC", at("2026-07-11T12:00:00Z"))
    expect(next?.toISOString()).toBe("2026-07-12T06:00:00.000Z") // Sunday the 12th
  })

  it("computes in the job's timezone", () => {
    // 8 AM in Sofia (EEST, UTC+3 in July) = 05:00 UTC.
    const next = nextCronDate("0 8 * * *", "Europe/Sofia", at("2026-07-11T01:00:00Z"))
    expect(next?.toISOString()).toBe("2026-07-11T05:00:00.000Z")
  })

  it("returns null for unparseable expressions and unknown timezones", () => {
    expect(nextCronDate("not a cron", "UTC")).toBeNull()
    expect(nextCronDate("0 8 * *", "UTC")).toBeNull() // 4 fields
    expect(nextCronDate("99 8 * * *", "UTC")).toBeNull() // out of range
    expect(nextCronDate("0 8 * * *", "Not/AZone")).toBeNull()
  })
})

describe("formatNextRun", () => {
  const now = at("2026-07-11T10:00:00Z")
  it("says minutes, hours, weekday, then date", () => {
    expect(formatNextRun(at("2026-07-11T10:45:00Z"), now)).toBe("in 45m")
    expect(formatNextRun(at("2026-07-11T15:00:00Z"), now)).toBe("in 5h")
    expect(formatNextRun(at("2026-07-14T09:00:00Z"), now)).toMatch(/^Tue /)
    expect(formatNextRun(at("2026-08-01T06:00:00Z"), now)).toBe("Aug 1")
    expect(formatNextRun(null, now)).toBe("")
  })
})

describe("formatRunTime", () => {
  const now = at("2026-07-11T22:00:00")
  it("names today, yesterday, and dates", () => {
    expect(formatRunTime(at("2026-07-11T08:00:00").getTime(), now)).toBe("Today, 8:00 AM")
    expect(formatRunTime(at("2026-07-10T08:00:00").getTime(), now)).toBe("Yesterday, 8:00 AM")
    expect(formatRunTime(at("2026-07-09T08:00:00").getTime(), now)).toBe("Jul 9, 8:00 AM")
    expect(formatRunTime(at("2025-12-31T08:00:00").getTime(), now)).toBe("Dec 31, 2025, 8:00 AM")
  })
})

describe("agoLabel", () => {
  const now = at("2026-07-11T10:00:00Z")
  it("scales from minutes to days", () => {
    expect(agoLabel("2026-07-11T09:59:40Z", now)).toBe("just now")
    expect(agoLabel("2026-07-11T09:20:00Z", now)).toBe("40m ago")
    expect(agoLabel("2026-07-11T07:00:00Z", now)).toBe("3h ago")
    expect(agoLabel("2026-07-08T10:00:00Z", now)).toBe("3d ago")
    expect(agoLabel(undefined, now)).toBe("")
    expect(agoLabel("garbage", now)).toBe("")
  })
})

describe("cron shared helpers", () => {
  const jobs: CronJobWire[] = [
    { id: "a", name: "A", schedule: "0 8 * * *", enabled: true, employee: "ops" },
    { id: "b", name: "B", schedule: "0 9 * * *", enabled: false, employee: "ops" },
    { id: "c", name: "C", schedule: "0 7 * * *", enabled: true, employee: "scout" },
    { id: "d", name: "D", schedule: "0 6 * * *", enabled: true },
  ]

  it("filters by enabled state", () => {
    expect(filterJobs(jobs, "all")).toHaveLength(4)
    expect(filterJobs(jobs, "enabled").map((j) => j.id)).toEqual(["a", "c", "d"])
    expect(filterJobs(jobs, "disabled").map((j) => j.id)).toEqual(["b"])
  })

  it("groups by employee, biggest first, unassigned last", () => {
    const groups = groupJobsByEmployee(jobs)
    expect(groups.map((g) => g.employee)).toEqual(["ops", "scout", null])
    expect(groups[0].jobs.map((j) => j.id)).toEqual(["a", "b"])
  })

  it("maps run status to an outcome glyph", () => {
    expect(runOutcome({ status: "success" })).toBe("ok")
    expect(runOutcome({ status: "error" })).toBe("error")
    expect(runOutcome({ status: "started" })).toBe("running")
    expect(runOutcome({ status: "skipped" })).toBe("none")
    expect(runOutcome(null)).toBe("none")
  })
})
