import type { SessionMessageInfo } from "@opencode/client"
import type { ModelRef } from "./models"
import { clip, clipEnd } from "./text"

const MAX_USER_MESSAGE_CHARS = 1200
const MAX_ASSISTANT_MESSAGE_CHARS = 2000

export interface TranscriptLimits {
  /** Lines kept from the end; an assistant turn takes one line for its tools and one for its text. */
  readonly maxMessages: number
  readonly maxChars: number
}

/** The recent conversation as plain text for the suggestion model. Tools appear by name only, without output. */
export function formatTranscript(messages: readonly SessionMessageInfo[], limits: TranscriptLimits) {
  const lines: string[] = []
  for (const message of messages) {
    if (message.type === "user") {
      const text = message.text.trim()
      if (text) lines.push(`USER: ${clip(text, MAX_USER_MESSAGE_CHARS)}`)
      continue
    }
    if (message.type !== "assistant") continue
    const tools = new Set(message.content.flatMap((part) => (part.type === "tool" ? [part.name] : [])))
    const text = message.content
      .flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text.trim()] : []))
      .join("\n")
    if (tools.size) lines.push(`ASSISTANT (used tools: ${[...tools].join(", ")})`)
    if (text) lines.push(`ASSISTANT: ${clipEnd(text, MAX_ASSISTANT_MESSAGE_CHARS)}`)
  }
  return clipEnd(lines.slice(-limits.maxMessages).join("\n\n"), limits.maxChars)
}

/** The model of the latest assistant message: what the session actually ran. */
export function lastAssistantModel(messages: readonly SessionMessageInfo[]): ModelRef | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type === "assistant") return { providerID: message.model.providerID, id: message.model.id }
  }
}
