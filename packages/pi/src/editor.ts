import { isCompletable, splitNextWord } from "@autosuggestions/core/text"
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent"
import {
  CURSOR_MARKER,
  type EditorTheme,
  matchesKey,
  renderFakeCursor,
  replaceControlCharacters,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui"

type Suggest = (base: string, signal: AbortSignal) => Promise<string>
const cursor = CURSOR_MARKER + renderFakeCursor(" ")
const graphemes = new Intl.Segmenter()

/** Replace the blank cursor cell and trailing editor padding without changing the editor text or cursor position. */
export function drawSuggestion(line: string, text: string, width: number) {
  const at = line.indexOf(cursor)
  if (at < 0) return line
  const before = line.slice(0, at)
  const room = width - visibleWidth(before)
  if (room < 1) return line
  const visible = truncateToWidth(replaceControlCharacters(text), room, "…", true)
  const first = graphemes.segment(visible).containing(0)?.segment
  if (!first) return line
  return `${before}\x1b[2m${CURSOR_MARKER}${renderFakeCursor(first)}${visible.slice(first.length)}\x1b[22m`
}

export class SuggestionEditor extends CustomEditor {
  private draft?: string
  private suggestion?: { base: string; rest: string }
  private timer?: ReturnType<typeof setTimeout>
  private request?: AbortController

  constructor(
    private ui: TUI,
    theme: EditorTheme,
    keys: KeybindingsManager,
    private canSuggest: () => boolean,
    private suggest: Suggest,
  ) {
    super(ui, theme, keys, { embedWorkingStatus: true })
  }

  private active() {
    const { line, col } = this.getCursor()
    const lines = this.getLines()
    return (
      this.canSuggest() &&
      this.focused &&
      !this.isShowingAutocomplete() &&
      line === lines.length - 1 &&
      col === lines[line]?.length
    )
  }

  private currentSuggestion() {
    return this.active() && this.suggestion?.base === this.getText() ? this.suggestion : undefined
  }

  private clear() {
    clearTimeout(this.timer)
    this.request?.abort()
    this.suggestion = undefined
  }

  reset() {
    this.clear()
    this.draft = undefined
    this.ui.requestRender()
  }

  followUp() {
    if (!this.active() || this.getText() !== "") return
    this.clear()
    this.draft = ""
    void this.generate("")
  }

  private async generate(base: string) {
    const request = new AbortController()
    this.request = request
    try {
      const rest = await this.suggest(base, request.signal)
      if (rest && !request.signal.aborted && this.active() && this.getText() === base) {
        this.suggestion = { base, rest: replaceControlCharacters(rest) }
        this.ui.requestRender()
      }
    } catch {
      // A background suggestion failure must never interrupt editing.
    } finally {
      if (this.request === request) this.request = undefined
    }
  }

  override handleInput(data: string) {
    const suggestion = this.currentSuggestion()
    if (suggestion) {
      if (matchesKey(data, "escape")) {
        this.clear()
        return
      }
      const wordOnly = matchesKey(data, "alt+right") || matchesKey(data, "alt+f") || matchesKey(data, "ctrl+right")
      if (wordOnly || matchesKey(data, "tab")) {
        const { word, rest } = wordOnly ? splitNextWord(suggestion.rest) : { word: suggestion.rest, rest: "" }
        this.insertTextAtCursor(word)
        const base = this.getText()
        this.draft = base
        this.suggestion = rest ? { base, rest } : undefined
        return
      }
    }
    super.handleInput(data)
  }

  override render(width: number) {
    const lines = super.render(width)
    const draft = this.active() ? this.getText() : undefined
    // Observe programmatic edits and cursor moves as well as typing, without replacing Pi's onChange callback.
    if (draft !== this.draft) {
      this.clear()
      this.draft = draft
      if (draft !== undefined && isCompletable(draft.trimStart())) {
        this.timer = setTimeout(() => {
          if (this.active() && this.getText() === draft) void this.generate(draft)
        }, 600)
      }
    }
    const suggestion = this.currentSuggestion()
    return suggestion ? lines.map((line) => drawSuggestion(line, suggestion.rest, width)) : lines
  }
}
