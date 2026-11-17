import { describe, expect, test } from "bun:test"
import { estimateTokens, formatUsage, localDate, recordCall, summarize, type UsageLog } from "../src/usage"

const haiku = { providerID: "anthropic", id: "claude-haiku-5-5", variant: "none" }
const luna = { providerID: "openai", id: "gpt-6-luna" }
const haikuPrice = [{ input: 0.1, output: 0.5 }]

describe("estimateTokens", () => {
  test("counts about four characters per token", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcde")).toBe(2)
  })
})

describe("recordCall", () => {
  test("adds calls per day, model, and kind, and prices them", () => {
    const log: UsageLog = { days: {} }
    const prompt = "x".repeat(4000)
    recordCall(log, {
      date: "2026-11-17",
      model: haiku,
      kind: "followUp",
      prompt,
      reply: "yes, add the tests",
      price: haikuPrice,
    })
    recordCall(log, { date: "2026-11-17", model: haiku, kind: "followUp", prompt, price: haikuPrice })
    const counts = log.days["2026-11-17"]?.["anthropic/claude-haiku-5-5"]?.followUp
    expect(counts).toEqual({ calls: 2, cancelled: 1, inputTokens: 2000, outputTokens: 5, cost: expect.any(Number) })
    expect(counts?.cost).toBeCloseTo((2000 * 0.1 + 5 * 0.5) / 1_000_000)
  })

  test("leaves the cost out for models without a price", () => {
    const log: UsageLog = { days: {} }
    recordCall(log, { date: "2026-11-17", model: luna, kind: "completion", prompt: "abcd", reply: "abcd" })
    expect(log.days["2026-11-17"]?.["openai/gpt-6-luna"]?.completion?.cost).toBeUndefined()
  })

  test("keeps three months of days", () => {
    const log: UsageLog = { days: {} }
    const start = new Date("2026-01-01T00:00:00")
    for (let day = 0; day < 95; day++) {
      const date = new Date(start)
      date.setDate(date.getDate() + day)
      recordCall(log, { date: localDate(date), model: luna, kind: "completion", prompt: "a", reply: "b" })
    }
    const dates = Object.keys(log.days).sort()
    expect(dates.length).toBe(90)
    expect(dates[0]).toBe("2026-01-06")
  })
})

describe("summarize and formatUsage", () => {
  const log: UsageLog = { days: {} }
  recordCall(log, {
    date: "2026-11-10",
    model: haiku,
    kind: "completion",
    prompt: "x".repeat(400),
    reply: "y",
    price: haikuPrice,
  })
  recordCall(log, {
    date: "2026-11-17",
    model: haiku,
    kind: "completion",
    prompt: "x".repeat(400),
    reply: "y",
    price: haikuPrice,
  })
  recordCall(log, { date: "2026-11-17", model: luna, kind: "followUp", prompt: "x".repeat(400), reply: "y" })

  test("totals from a date on, overall and per model", () => {
    const { total, models } = summarize(log, "2026-11-17")
    expect(total.calls).toBe(2)
    expect(total.followUps).toBe(1)
    expect(total.completions).toBe(1)
    expect(total.unpriced).toBe(true)
    expect(models.get("openai/gpt-6-luna")?.cost).toBe(0)
    expect(summarize(log).total.calls).toBe(3)
  })

  test("formats today, the last week, and everything", () => {
    const text = formatUsage(log, "2026-11-17")
    expect(text).toContain("Today\n  2 calls · 202 tokens · <$0.01 + subscription")
    expect(text).toContain("Last 7 days\n  2 calls")
    expect(text).toContain("Since 2026-11-10\n  3 calls")
    expect(text).toContain("  openai/gpt-6-luna · subscription\n    0 completions · 1 follow-up · 0 cancelled")
    expect(text).toContain("Estimated from text length")
  })

  test("says when there were no calls", () => {
    expect(formatUsage({ days: {} }, "2026-11-17")).toContain("Today\n  no calls")
  })
})
