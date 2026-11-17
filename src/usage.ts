// An estimate of what suggestions cost. OpenCode's generate API returns only text, without token counts, so tokens
// are estimated from text length and priced with the model's list price. Subscriptions have no price: only calls and
// tokens are counted for them.

import type { ModelOption, ModelRef } from "./models"

export const CHARS_PER_TOKEN = 4
const KEEP_DAYS = 90

export type SuggestionKind = "followUp" | "completion"

export interface Counts {
  calls: number
  /** Calls cancelled before the reply arrived. The prompt was sent, so its tokens still count. */
  cancelled: number
  inputTokens: number
  outputTokens: number
  /** USD at list price; undefined for models without a price. */
  cost?: number
}

/** Counts per day ("2026-11-17"), then per model ("provider/model"), then per kind. */
export interface UsageLog {
  days: Record<string, Record<string, Partial<Record<SuggestionKind, Counts>>>>
}

export interface Call {
  readonly date: string
  readonly model: ModelRef
  readonly kind: SuggestionKind
  readonly prompt: string
  /** The reply, or undefined when the call was cancelled. */
  readonly reply?: string
  readonly price?: ModelOption["cost"]
}

export function estimateTokens(text: string) {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function localDate(time = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`
}

/** Adds a call to the log, and drops days older than three months. Mutates `log`, as a store update does. */
export function recordCall(log: UsageLog, call: Call) {
  const inputTokens = estimateTokens(call.prompt)
  const outputTokens = call.reply === undefined ? 0 : estimateTokens(call.reply)
  const tier = call.price?.[0]
  const model = `${call.model.providerID}/${call.model.id}`
  const day = (log.days[call.date] ??= {})
  const byKind = (day[model] ??= {})
  const counts = (byKind[call.kind] ??= { calls: 0, cancelled: 0, inputTokens: 0, outputTokens: 0 })
  counts.calls += 1
  if (call.reply === undefined) counts.cancelled += 1
  counts.inputTokens += inputTokens
  counts.outputTokens += outputTokens
  if (tier) counts.cost = (counts.cost ?? 0) + (inputTokens * tier.input + outputTokens * tier.output) / 1_000_000
  const dates = Object.keys(log.days).sort()
  for (const date of dates.slice(0, Math.max(0, dates.length - KEEP_DAYS))) delete log.days[date]
}

export interface Summary {
  readonly calls: number
  readonly cancelled: number
  readonly followUps: number
  readonly completions: number
  readonly inputTokens: number
  readonly outputTokens: number
  /** USD for the priced models only. */
  readonly cost: number
  /** Whether some calls went to models without a price. */
  readonly unpriced: boolean
}

const EMPTY: Summary = {
  calls: 0,
  cancelled: 0,
  followUps: 0,
  completions: 0,
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
  unpriced: false,
}

function add(summary: Summary, kind: SuggestionKind, counts: Counts): Summary {
  return {
    calls: summary.calls + counts.calls,
    cancelled: summary.cancelled + counts.cancelled,
    followUps: summary.followUps + (kind === "followUp" ? counts.calls : 0),
    completions: summary.completions + (kind === "completion" ? counts.calls : 0),
    inputTokens: summary.inputTokens + counts.inputTokens,
    outputTokens: summary.outputTokens + counts.outputTokens,
    cost: summary.cost + (counts.cost ?? 0),
    unpriced: summary.unpriced || counts.cost === undefined,
  }
}

/** Totals for the days from `from` on (all days when undefined), overall and per model. */
export function summarize(log: UsageLog, from?: string) {
  let total = EMPTY
  const models = new Map<string, Summary>()
  for (const [date, day] of Object.entries(log.days)) {
    if (from && date < from) continue
    for (const [model, byKind] of Object.entries(day)) {
      for (const [kind, counts] of Object.entries(byKind) as [SuggestionKind, Counts][]) {
        total = add(total, kind, counts)
        models.set(model, add(models.get(model) ?? EMPTY, kind, counts))
      }
    }
  }
  return { total, models }
}

const tokens = (count: number) =>
  count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(1)}M`
    : count >= 1_000
      ? `${(count / 1_000).toFixed(1)}K`
      : String(count)

const count = (value: number, one: string, many = `${one}s`) => `${value} ${value === 1 ? one : many}`

const dollars = (summary: Summary) => {
  if (summary.cost === 0 && summary.unpriced) return "subscription"
  const cost = summary.cost < 0.01 && summary.cost > 0 ? "<$0.01" : `$${summary.cost.toFixed(2)}`
  return summary.unpriced ? `${cost} + subscription` : cost
}

function line(summary: Summary) {
  if (!summary.calls) return "  no calls"
  return `  ${count(summary.calls, "call")} · ${tokens(summary.inputTokens + summary.outputTokens)} tokens · ${dollars(summary)}`
}

/** The text of the usage dialog. */
export function formatUsage(log: UsageLog, today = localDate()) {
  const week = new Date(`${today}T00:00:00`)
  week.setDate(week.getDate() - 6)
  const weekStart = localDate(week)
  const first = Object.keys(log.days).sort()[0]
  const lines = [
    "Today",
    line(summarize(log, today).total),
    "Last 7 days",
    line(summarize(log, weekStart).total),
    `Since ${first ?? today}`,
    line(summarize(log).total),
  ]
  const models = [...summarize(log, weekStart).models].sort((a, b) => b[1].calls - a[1].calls)
  if (models.length) {
    lines.push("", "Last 7 days by model")
    for (const [model, summary] of models) {
      lines.push(
        `  ${model} · ${dollars(summary)}`,
        `    ${count(summary.completions, "completion")} · ${count(summary.followUps, "follow-up")} · ${summary.cancelled} cancelled`,
      )
    }
  }
  lines.push(
    "",
    `Estimated from text length (about ${CHARS_PER_TOKEN} characters`,
    "per token) at list prices; subscriptions have no price.",
  )
  return lines.join("\n")
}
