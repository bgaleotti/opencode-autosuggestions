import type { Language } from "./cases"

export interface Result {
  readonly kind: "followUp" | "completion"
  readonly case: string
  readonly model: string
  readonly sample: number
  /** The model's reply as returned. */
  readonly raw: string
  /** What the plugin would show: the follow-up, or the text appended to the unfinished message. */
  readonly suggestion: string
  readonly ms: number
  readonly error?: string
  readonly language?: Language
  readonly expectedLanguage: Language
  /** The suggestion matched the case's `avoid` pattern. */
  readonly avoided: boolean
}

const SPANISH = /[áéíóúñ¿¡]|\b(que|el|la|los|las|del|de|por|pero|dale|sí|también|con|para|una|lo|mejor|esto|ahora)\b/gi
const ENGLISH = /\b(the|and|to|it|add|use|yes|please|for|with|this|that|now|also|then|of|run)\b/gi

/** A rough guess between English and Spanish, good enough to flag a suggestion in the wrong language. */
export function detectLanguage(text: string): Language {
  const spanish = text.match(SPANISH)?.length ?? 0
  const english = text.match(ENGLISH)?.length ?? 0
  return spanish > english ? "es" : "en"
}
