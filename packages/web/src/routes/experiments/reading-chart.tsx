import type { ExperimentMetric, ExperimentReading } from "./types"

export function formatMetricValue(value: number | undefined, unit?: string): string {
  if (value === undefined) return "—"
  const formatted = Number.isInteger(value) ? String(value) : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  return unit ? `${formatted}${unit}` : formatted
}

export function ReadingChart({
  metric,
  readings,
  baseline,
}: {
  metric: ExperimentMetric
  readings: ExperimentReading[]
  baseline: number | undefined
}) {
  if (readings.length < 2) return null

  const width = 720
  const height = 180
  const insetX = 18
  const insetY = 16
  const values = [...readings.map((reading) => reading.value), ...(baseline === undefined ? [] : [baseline])]
  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  const padding = rawMin === rawMax ? Math.max(Math.abs(rawMin) * 0.08, 1) : (rawMax - rawMin) * 0.12
  const min = rawMin - padding
  const max = rawMax + padding
  const timestamps = readings.map((reading) => Date.parse(reading.at))
  const firstAt = Math.min(...timestamps)
  const lastAt = Math.max(...timestamps)
  const x = (at: number, index: number) => lastAt === firstAt
    ? insetX + (index / (readings.length - 1)) * (width - insetX * 2)
    : insetX + ((at - firstAt) / (lastAt - firstAt)) * (width - insetX * 2)
  const y = (value: number) => height - insetY - ((value - min) / (max - min)) * (height - insetY * 2)
  const points = readings.map((reading, index) => `${x(timestamps[index], index)},${y(reading.value)}`).join(" ")

  return (
    <div className="mt-4 overflow-hidden rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] px-2 py-3">
      <svg
        role="img"
        aria-label={`${metric.name} readings over time`}
        viewBox={`0 0 ${width} ${height}`}
        className="group block h-[180px] w-full overflow-visible"
        preserveAspectRatio="none"
      >
        {baseline !== undefined && (
          <line
            x1={insetX}
            x2={width - insetX}
            y1={y(baseline)}
            y2={y(baseline)}
            stroke="currentColor"
            strokeDasharray="6 6"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            style={{ color: "var(--separator-opaque)" }}
          />
        )}
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{ color: "var(--accent)" }}
        />
        {readings.map((reading, index) => (
          <circle
            key={reading.id}
            cx={x(timestamps[index], index)}
            cy={y(reading.value)}
            r="4"
            fill="currentColor"
            stroke="var(--bg-secondary)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            className="opacity-0 transition-opacity duration-150 group-hover:opacity-100"
            style={{ color: "var(--accent)" }}
          >
            <title>{`${new Date(reading.at).toLocaleDateString()}: ${formatMetricValue(reading.value, metric.unit)}${reading.note ? ` — ${reading.note}` : ""}`}</title>
          </circle>
        ))}
      </svg>
      <div className="flex justify-between px-2 text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
        <span>{new Date(readings[0].at).toLocaleDateString()}</span>
        <span>{new Date(readings.at(-1)!.at).toLocaleDateString()}</span>
      </div>
    </div>
  )
}
