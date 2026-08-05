export interface ExperimentMetric {
  name: string
  unit?: string
  howToMeasure: string
}

export interface ExperimentReading {
  id: string
  experimentId: string
  at: string
  metric: string
  value: number
  note?: string
}

export interface ExperimentVerdict {
  outcome: "win" | "loss" | "inconclusive"
  note: string
  concludedAt: string
}

export interface Experiment {
  id: string
  name: string
  hypothesis: string
  status: "running" | "concluded"
  startedAt: string
  horizonDays: number
  baseline: Record<string, number>
  metrics: ExperimentMetric[]
  readings: ExperimentReading[]
  verdict?: ExperimentVerdict
  checkInCronJobId?: string
}

export interface ExperimentsResponse {
  experiments: Experiment[]
}

export interface ExperimentResponse {
  experiment: Experiment
}
