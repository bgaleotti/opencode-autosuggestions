// Compares two eval runs: a summary per model, and every suggestion side by side for reading.
//
//   bun eval/compare.ts <before> <after>
//
// Prints the summary and writes the full comparison to eval/results/<before>-vs-<after>.md.

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { completionCases, followUpCases } from "./cases"
import type { Result } from "./shared"

const [before, after] = process.argv.slice(2)
if (!before || !after) {
  console.error("usage: bun eval/compare.ts <before> <after>")
  process.exit(1)
}

const directory = join(import.meta.dir, "results")
// Checks are recomputed from the current cases, so runs saved before a case changed are judged the same way.
const avoidPatterns = new Map<string, RegExp | undefined>([
  ...followUpCases.map((testCase) => [`followUp:${testCase.id}`, testCase.avoid] as const),
  ...completionCases.map((testCase) => [`completion:${testCase.id}`, testCase.avoid] as const),
])
const unfinished = new Map(completionCases.map((testCase) => [testCase.id, testCase.unfinished]))
const recheck = (result: Result): Result => {
  const text =
    result.kind === "completion" ? (unfinished.get(result.case) ?? "") + result.suggestion : result.suggestion
  const avoid = avoidPatterns.get(`${result.kind}:${result.case}`)
  return { ...result, avoided: Boolean(result.suggestion && avoid?.test(text)) }
}
const load = (label: string): Result[] =>
  JSON.parse(readFileSync(join(directory, `${label}.json`), "utf8")).results.map(recheck)
const runs = { [before]: load(before), [after]: load(after) }
const models = [...new Set(Object.values(runs).flatMap((results) => results.map((result) => result.model)))].sort()

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? (sorted[Math.floor(sorted.length / 2)] ?? 0) : 0
}
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

function summary(results: Result[]) {
  const shown = results.filter((result) => result.suggestion)
  return {
    shown: `${shown.length}/${results.length}`,
    wrongLanguage: shown.filter((result) => result.language !== result.expectedLanguage).length,
    avoided: results.filter((result) => result.avoided).length,
    errors: results.filter((result) => result.error).length,
    medianMs: median(results.map((result) => result.ms)),
    words: shown.length
      ? (shown.reduce((sum, result) => sum + words(result.suggestion), 0) / shown.length).toFixed(1)
      : "-",
  }
}

const lines: string[] = [`# ${before} vs ${after}`, "", "## Summary", ""]
lines.push("| Kind | Model | Run | Shown | Wrong language | Hit avoid | Errors | Median ms | Avg words |")
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
for (const kind of ["followUp", "completion"] as const) {
  for (const model of models) {
    for (const label of [before, after]) {
      const results = (runs[label] ?? []).filter((result) => result.kind === kind && result.model === model)
      if (!results.length) continue
      const s = summary(results)
      lines.push(
        `| ${kind} | ${model} | ${label} | ${s.shown} | ${s.wrongLanguage} | ${s.avoided} | ${s.errors} | ${s.medianMs} | ${s.words} |`,
      )
    }
  }
}
const summaryText = lines.join("\n")

const show = (result: Result | undefined, unfinished = "") => {
  if (!result) return "—"
  if (result.error) return `ERROR ${result.error.slice(0, 80)}`
  if (!result.suggestion) return `(none) raw: ${JSON.stringify(result.raw.slice(0, 80))}`
  const flags = [
    result.language !== result.expectedLanguage ? "WRONG LANGUAGE" : "",
    result.avoided ? "HIT AVOID" : "",
  ].filter(Boolean)
  const text = unfinished ? `${unfinished}**${result.suggestion}**` : result.suggestion
  return `${text}${flags.length ? `  [${flags.join(", ")}]` : ""}`
}

const pick = (label: string, kind: Result["kind"], id: string, model: string) =>
  (runs[label] ?? []).filter((result) => result.kind === kind && result.case === id && result.model === model)

lines.push("", "## Follow-ups", "")
for (const testCase of followUpCases) {
  lines.push(`### ${testCase.id}`, "", `Good: ${testCase.good}`, "")
  for (const model of models) {
    for (const label of [before, after]) {
      for (const result of pick(label, "followUp", testCase.id, model)) {
        lines.push(`- ${model} · ${label}: ${show(result)}`)
      }
    }
  }
  lines.push("")
}

lines.push("## Completions", "")
for (const testCase of completionCases) {
  lines.push(`### ${testCase.id}`, "", `Typed: \`${testCase.unfinished}\` · Good: ${testCase.good}`, "")
  for (const model of models) {
    for (const label of [before, after]) {
      for (const result of pick(label, "completion", testCase.id, model)) {
        lines.push(`- ${model} · ${label}: ${show(result, testCase.unfinished)}`)
      }
    }
  }
  lines.push("")
}

const file = join(directory, `${before}-vs-${after}.md`)
writeFileSync(file, `${lines.join("\n")}\n`)
console.log(summaryText)
console.log(`\nFull comparison: ${file}`)
