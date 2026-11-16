/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"

// Codex-style "next prompt" suggestions for the OpenCode TUI.
//
// When a root session finishes a turn, a cheap model reads the last few messages
// and predicts what the user will probably type next. The suggestion is shown as
// the prompt's placeholder (ghost text inside the empty input); Tab accepts it,
// Esc dismisses it, and typing anything hides it.
//
// While typing, a pause asks the same model to finish the sentence, Copilot
// style. The textarea cannot draw text after the cursor, and inserting real text
// would be sent on Enter, so the completion is drawn as a layer over the input,
// right where the cursor is.
//
// V2 has no prompt-text API, so this reads and writes the prompt through
// `renderer.currentFocusedEditor` (an OpenTUI TextareaRenderable). The host sets
// the placeholder reactively and may overwrite ours (resize, session switch); the
// poller re-applies it while a suggestion is active.

type Options = {
  enabled?: boolean
  model?: string
  acceptKey?: string
  dismissKey?: string
  maxMessages?: number
  maxChars?: number
  followUps?: boolean
  autocomplete?: boolean
  autocompleteDelay?: number
}

type Editor = {
  plainText?: string
  cursorOffset?: number
  placeholder?: unknown
  isDestroyed?: boolean
  traits?: { role?: string; status?: string }
  setText?(text: string): void
  gotoBufferEnd?(): void
}

type Suggestion = { text: string; dismissed: boolean }

// `rest` continues the prompt text `base`.
type Completion = { base: string; rest: string }

type ModelRef = { providerID: string; id: string; variant?: string }

type ModelEntry = {
  providerID: string
  id: string
  name?: string
  type?: string
  enabled?: boolean
  status?: string
  variants?: { id: string }[]
  cost?: { input: number; output: number }[]
}

const POLL_MS = 80
const AUTO = "auto"
// Names that usually mean a small, fast model. Used when a provider reports no
// prices (subscriptions), so cost cannot rank its models.
const SMALL_MODEL = /haiku|mini|nano|flash|lite|small|lightning|tiny/i
// Speed tiers are often not included in a subscription and cost more otherwise.
const SPEED_TIER = /-(fast|ultrafast|flex|priority)$/i
// Reasoning off first; not every account allows it, so generation falls back to
// the model default and then "low" (which some models handle worse than default).
const QUICK_VARIANTS = ["none", "minimal"]
const FALLBACK_VARIANTS = ["low"]

const INSTRUCTIONS = `You predict the next message a developer will type to their AI coding agent.
Read the recent conversation and write the single most likely next message from the USER.

Rules:
- Write it as the user, in the user's language and tone (match how they write: casual, lowercase, etc.).
- Short and actionable: one line, ideally 3-12 words. No quotes, no prefix, no explanation.
- Prefer the obvious next step: accepting a proposal the assistant offered ("yes, do it"), running tests, committing, fixing what failed, continuing the plan.
- If the assistant asked a question, answer it the way the user most likely would.
- When the work looks finished, suggest a natural follow-up (verify it, run it, commit, the next related task).
- Output exactly NONE only if you genuinely cannot guess anything useful.`

const TYPING_INSTRUCTIONS = `You autocomplete a message a developer is typing to their AI coding agent, like Copilot does for code.
Given the recent conversation and the unfinished message, finish the message the way the user most likely would.

Rules:
- Output the COMPLETE message: the unfinished text exactly as written, character for character, followed by your continuation.
- If it stops mid-word, finish that word first.
- Always add a plausible continuation of 2 to 12 words, even if unsure. Finishing the current sentence is enough.
- Keep the user's language and tone. One line, no quotes around it, no explanation.`

export default Plugin.define({
  id: "opencode-autosuggestions",
  setup(context) {
    const options = (context.options ?? {}) as Options
    if (options.enabled === false) return

    // `model` is "" until a model is picked from the palette; then it overrides
    // the `model` option from cli.json. "auto" chooses from the session's provider.
    const [settings, updateSettings] = context.storage.store("settings", {
      initial: { enabled: true, model: "", followUps: true, autocomplete: true },
    })
    const choice = () => settings.model || options.model || AUTO
    const working = new Map<string, ModelRef>()
    // Model and variant combinations the account rejected, so they are not retried.
    const rejected = new Set<string>()
    const maxMessages = options.maxMessages ?? 8
    const maxChars = options.maxChars ?? 6000

    const suggestions = new Map<string, Suggestion>()
    let applied: { editor: Editor; original: unknown; text: string } | undefined

    const typingDelay = options.autocompleteDelay ?? 600
    const typingOn = () => options.autocomplete !== false && settings.autocomplete !== false
    // Only the automatic suggestion after each turn; "Suggest follow-up now" still works.
    const followUpsOn = () => options.followUps !== false && settings.followUps !== false
    const [completion, setCompletion] = createSignal<Completion>()
    let typed = ""
    let typingTimer: ReturnType<typeof setTimeout> | undefined
    // In-flight model calls, aborted as soon as their result can no longer be shown
    // so a stale suggestion is not paid for.
    let typingCall: AbortController | undefined
    const followUpCalls = new Map<string, AbortController>()

    const cancelTyping = () => {
      clearTimeout(typingTimer)
      typingCall?.abort()
      typingCall = undefined
    }

    const cancelFollowUp = (sessionID: string) => {
      followUpCalls.get(sessionID)?.abort()
      followUpCalls.delete(sessionID)
    }

    // Only the main composer: dialogs have their own focused editors, and the
    // composer marks itself with `role: "prompt"` (status "SHELL" in shell mode).
    const editor = (): Editor | undefined => {
      const value = (context.renderer as unknown as { currentFocusedEditor?: Editor }).currentFocusedEditor
      if (!value || value.isDestroyed) return
      if (value.traits?.role !== "prompt" || value.traits.status === "SHELL") return
      return value
    }

    const routeSessionID = () => {
      const route = context.ui.router.current() as { type: string; sessionID?: string }
      return route.type === "session" ? route.sessionID : undefined
    }

    const active = (): Suggestion | undefined => {
      if (!settings.enabled) return
      const sessionID = routeSessionID()
      if (!sessionID) return
      const suggestion = suggestions.get(sessionID)
      return suggestion && !suggestion.dismissed ? suggestion : undefined
    }

    const restore = () => {
      if (!applied) return
      if (!applied.editor.isDestroyed && applied.editor.placeholder === applied.text) {
        applied.editor.placeholder = applied.original
      }
      applied = undefined
    }


    // Prompts that belong to the host: slash commands, shell, and @ mentions in progress.
    const completable = (text: string) =>
      text.trim().length >= 3 && !text.startsWith("/") && !text.startsWith("!") && !/(^|\s)@\S*$/.test(text)

    const atEnd = (target: Editor, text: string) =>
      target.cursorOffset === undefined || target.cursorOffset >= [...text].length

    const onTyped = (text: string) => {
      cancelTyping()
      const current = completion()
      // Typing the next characters of the completion keeps the rest of it.
      if (current && text.length > current.base.length && text.startsWith(current.base)) {
        const added = text.slice(current.base.length)
        if (current.rest.startsWith(added) && current.rest.length > added.length) {
          setCompletion({ base: text, rest: current.rest.slice(added.length) })
          return
        }
      }
      setCompletion(undefined)
      if (!settings.enabled || !typingOn() || !completable(text)) return
      // Typing over the empty-prompt suggestion completes it without a model call.
      const sessionID = routeSessionID()
      const suggestion = sessionID ? suggestions.get(sessionID) : undefined
      if (suggestion && suggestion.text.length > text.length && suggestion.text.startsWith(text)) {
        setCompletion({ base: text, rest: suggestion.text.slice(text.length) })
        return
      }
      typingTimer = setTimeout(() => void completeTyping(text), typingDelay)
    }

    const sync = () => {
      const target = editor()
      const value = target?.plainText ?? ""
      if (target && value !== typed) {
        typed = value
        onTyped(value)
      }
      const suggestion = active()
      const show = target && suggestion && (target.plainText ?? "") === ""
      if (!show) return restore()
      // The suggestion itself is drawn by the overlay; clear the host placeholder
      // so the two do not overlap.
      const text = ""
      if (applied && applied.editor !== target) restore()
      if (applied && target.placeholder === applied.text) return
      // The host replaced the placeholder (or we have not applied yet): remember
      // its value so it can be restored once the suggestion goes away.
      applied = { editor: target, original: target.placeholder, text }
      target.placeholder = text
    }

    const transcript = (sessionID: string, limit = maxMessages) => {
      const messages = context.data.session.message.list(sessionID) ?? []
      const lines: string[] = []
      for (const message of messages as Array<Record<string, any>>) {
        if (message.type === "user" && typeof message.text === "string" && message.text.trim()) {
          lines.push(`USER: ${clip(message.text.trim(), 1200)}`)
          continue
        }
        if (message.type !== "assistant" || !Array.isArray(message.content)) continue
        const text = message.content
          .filter((part: any) => part.type === "text" && typeof part.text === "string")
          .map((part: any) => part.text.trim())
          .filter(Boolean)
          .join("\n")
        const tools = [
          ...new Set(
            message.content.filter((part: any) => part.type === "tool").map((part: any) => String(part.name)),
          ),
        ]
        if (tools.length) lines.push(`ASSISTANT (used tools: ${tools.join(", ")})`)
        if (text) lines.push(`ASSISTANT: ${clipEnd(text, 2000)}`)
      }
      return clipEnd(lines.slice(-limit).join("\n\n"), maxChars)
    }

    const locationOf = (sessionID?: string) =>
      (sessionID ? (context.data.session.get(sessionID) as { location?: any } | undefined)?.location : undefined) ??
      context.location ??
      context.data.location.default()

    const models = async (sessionID?: string): Promise<ModelEntry[]> => {
      const location = locationOf(sessionID)
      if (!context.data.location.model.list(location)) await context.data.location.model.sync(location)
      return ((context.data.location.model.list(location) ?? []) as unknown as ModelEntry[]).filter(
        (model) => model.enabled !== false && (model.type ?? "chat") === "chat" && model.status !== "deprecated",
      )
    }

    // The model the session actually ran last, else the composer's selection.
    const sessionModel = (sessionID?: string): { providerID: string; id: string } | undefined => {
      const messages = sessionID ? ((context.data.session.message.list(sessionID) ?? []) as any[]) : []
      for (let index = messages.length - 1; index >= 0; index--) {
        const model = messages[index]?.type === "assistant" ? messages[index].model : undefined
        if (model?.providerID && model?.id) return { providerID: model.providerID, id: model.id }
      }
      const current = (context.ui as any).model?.current?.()
      const id = current?.id ?? current?.modelID
      if (current?.providerID && id) return { providerID: current.providerID, id }
    }

    // Models to try, best first. Auto stays on the session's provider, so it only
    // uses an account you already use: the cheapest priced model, else one whose
    // name says it is small, and finally the session's own model.
    const pickModels = (available: ModelEntry[], sessionID?: string, pinned = choice()): ModelEntry[] => {
      if (pinned !== AUTO) {
        const ref = parseModel(pinned)
        const found = available.find((model) => model.providerID === ref.providerID && model.id === ref.id)
        return [found ?? { providerID: ref.providerID, id: ref.id }]
      }
      const base = sessionModel(sessionID)
      const own = base ? available.filter((model) => model.providerID === base.providerID) : available
      const pool = own.filter((model) => !SPEED_TIER.test(model.id))
      const price = (model: ModelEntry) => (model.cost?.[0] ? model.cost[0].input + model.cost[0].output : 0)
      const priced = pool.filter((model) => price(model) > 0).sort((a, b) => price(a) - price(b))
      const small = pool.filter((model) => SMALL_MODEL.test(`${model.id} ${model.name ?? ""}`))
      const current = base && own.find((model) => model.id === base.id)
      const picks = [...priced.slice(0, 1), ...small.slice(0, 1), ...(current ? [current] : [])]
      return picks.filter((model, index) => picks.findIndex((other) => other.id === model.id) === index)
    }

    const attempts = (picks: ModelEntry[]): ModelRef[] => {
      if (choice() !== AUTO) {
        const variant = parseModel(choice()).variant
        const model = picks[0]
        if (!model) return []
        return variant ? [{ ...model, variant }, { providerID: model.providerID, id: model.id }] : [model]
      }
      return picks.flatMap((model) => {
        const listed = new Set((model.variants ?? []).map((variant) => variant.id))
        return [
          ...QUICK_VARIANTS.filter((variant) => listed.has(variant)).map((variant) => ({
            providerID: model.providerID,
            id: model.id,
            variant,
          })),
          { providerID: model.providerID, id: model.id },
          ...FALLBACK_VARIANTS.filter((variant) => listed.has(variant)).map((variant) => ({
            providerID: model.providerID,
            id: model.id,
            variant,
          })),
        ]
      })
    }

    const modelLabel = (ref: ModelRef, available: ModelEntry[]) => {
      const name = available.find((model) => model.providerID === ref.providerID && model.id === ref.id)?.name
      return `${name ?? `${ref.providerID}/${ref.id}`}${ref.variant ? ` (${ref.variant})` : ""}`
    }

    const complete = async (prompt: string, sessionID: string | undefined, signal: AbortSignal) => {
      const client = context.client as any
      const generateText = client.experimental?.generate?.text ?? client.generate?.text
      if (typeof generateText !== "function") return
      const available = await models(sessionID)
      if (signal.aborted) return
      const picks = pickModels(available, sessionID)
      const key = `${choice()}|${picks.map((model) => `${model.providerID}/${model.id}`).join(",")}`
      const cached = working.get(key)
      const refKey = (ref: ModelRef) => `${ref.providerID}/${ref.id}#${ref.variant ?? ""}`
      const refs = [...(cached ? [cached] : []), ...attempts(picks)].filter((ref) => !rejected.has(refKey(ref)))
      for (const ref of refs) {
        const model = { providerID: ref.providerID, id: ref.id, ...(ref.variant ? { variant: ref.variant } : {}) }
        let failure: unknown
        const response = await generateText({ prompt, model }, { signal }).catch((error: unknown) => {
          failure = error
          return undefined
        })
        if (signal.aborted) return
        const text = response?.data?.text ?? response?.text
        if (typeof text !== "string") {
          // Only settings errors are permanent; network or rate-limit errors may pass next time.
          if (/not available|unavailable|invalid|unsupported/i.test(String((failure as any)?.message ?? ""))) {
            rejected.add(refKey(ref))
          }
          continue
        }
        working.set(key, ref)
        return text
      }
    }

    const generate = async (sessionID: string) => {
      cancelFollowUp(sessionID)
      const call = new AbortController()
      followUpCalls.set(sessionID, call)
      suggestions.delete(sessionID)
      try {
        await context.data.session.message.sync(sessionID)
        const conversation = transcript(sessionID)
        if (!conversation || call.signal.aborted) return
        const prompt = `${INSTRUCTIONS}\n\n<conversation>\n${conversation}\n</conversation>\n\nNext user message:`
        const raw = await complete(prompt, sessionID, call.signal)
        if (call.signal.aborted) return
        const text = clean(raw ?? "")
        if (!text) return
        suggestions.set(sessionID, { text, dismissed: false })
        sync()
      } catch {
        // A failed suggestion is not worth interrupting the user for.
      } finally {
        if (followUpCalls.get(sessionID) === call) followUpCalls.delete(sessionID)
      }
    }

    const completeTyping = async (text: string) => {
      typingCall?.abort()
      const call = new AbortController()
      typingCall = call
      try {
        const sessionID = routeSessionID()
        const conversation = sessionID ? transcript(sessionID, 6) : ""
        const prompt = `${TYPING_INSTRUCTIONS}\n\n<conversation>\n${conversation || "(new conversation)"}\n</conversation>\n\n<unfinished>\n${text}\n</unfinished>\n\nComplete message:`
        const raw = await complete(prompt, sessionID, call.signal)
        if (call.signal.aborted || typed !== text) return
        const rest = continuation(text, raw ?? "")
        if (rest) setCompletion({ base: text, rest })
      } catch {
        // Same as above: no completion this time.
      } finally {
        if (typingCall === call) typingCall = undefined
      }
    }

    const isRoot = (sessionID: string) => {
      const session = context.data.session.get(sessionID) as { parentID?: string } | undefined
      return !session?.parentID
    }

    const stops = [
      context.data.on("session.execution.started", (event) => {
        cancelFollowUp(event.data.sessionID)
        suggestions.delete(event.data.sessionID)
        sync()
      }),
      context.data.on("session.execution.succeeded", (event) => {
        if (!settings.enabled || !followUpsOn() || !isRoot(event.data.sessionID)) return
        void generate(event.data.sessionID)
      }),
    ]

    const acceptCompletion = () => {
      const target = editor()
      const current = completion()
      if (!target || !current || typeof target.setText !== "function") return false
      const text = target.plainText ?? ""
      if (text !== current.base || !atEnd(target, text)) return false
      const next = current.base + current.rest
      setCompletion(undefined)
      typed = next
      target.setText(next)
      target.gotoBufferEnd?.()
    }

    const accept = () => {
      if (completion()) return acceptCompletion()
      const target = editor()
      const suggestion = active()
      if (!target || !suggestion || (target.plainText ?? "") !== "" || typeof target.setText !== "function") {
        return false
      }
      restore()
      target.setText(suggestion.text)
      target.gotoBufferEnd?.()
      suggestions.delete(routeSessionID()!)
    }

    const dismiss = () => {
      if (completion()) {
        cancelTyping()
        setCompletion(undefined)
        return
      }
      const target = editor()
      const suggestion = active()
      if (!target || !suggestion || (target.plainText ?? "") !== "") return false
      suggestion.dismissed = true
      restore()
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "autosuggestions.accept",
          title: "Accept suggested prompt",
          group: "Prompt",
          bind: options.acceptKey ?? "tab",
          run: () => accept(),
        },
        {
          id: "autosuggestions.dismiss",
          title: "Dismiss suggested prompt",
          group: "Prompt",
          bind: options.dismissKey ?? "escape",
          run: () => dismiss(),
        },
        {
          id: "autosuggestions.toggle",
          title: "Toggle suggested prompts",
          group: "Prompt",
          palette: true,
          run: async () => {
            await updateSettings((draft) => {
              draft.enabled = !draft.enabled
            })
            if (!settings.enabled) restore()
            context.ui.toast.show({
              message: `Suggested prompts ${settings.enabled ? "on" : "off"}`,
              variant: "info",
            })
          },
        },
        {
          id: "autosuggestions.followups",
          title: "Toggle follow-up suggestions",
          group: "Prompt",
          palette: true,
          run: async () => {
            await updateSettings((draft) => {
              draft.followUps = draft.followUps === false
            })
            if (!followUpsOn()) {
              followUpCalls.forEach((call) => call.abort())
              followUpCalls.clear()
              suggestions.clear()
              restore()
            }
            context.ui.toast.show({
              message: `Follow-up suggestions ${followUpsOn() ? "on" : "off"}`,
              variant: "info",
            })
          },
        },
        {
          id: "autosuggestions.autocomplete",
          title: "Toggle autocomplete",
          group: "Prompt",
          palette: true,
          run: async () => {
            await updateSettings((draft) => {
              draft.autocomplete = draft.autocomplete === false
            })
            if (!typingOn()) {
              cancelTyping()
              setCompletion(undefined)
            }
            context.ui.toast.show({
              message: `Autocomplete ${typingOn() ? "on" : "off"}`,
              variant: "info",
            })
          },
        },
        {
          id: "autosuggestions.model",
          title: "Choose suggestion model",
          group: "Prompt",
          palette: true,
          run: async () => {
            const sessionID = routeSessionID()
            const available = await models(sessionID)
            const key = (model: { providerID: string; id: string }) => `${model.providerID}/${model.id}`
            const autoPicks = pickModels(available, sessionID, AUTO)
            const cost = (model: ModelEntry) => {
              const tier = model.cost?.[0]
              if (!tier) return "subscription"
              if (tier.input === 0 && tier.output === 0) return "free"
              return `$${tier.input} / $${tier.output} per 1M`
            }
            const value = await context.ui.dialog.select({
              title: "Suggestion model",
              current: choice(),
              options: [
                {
                  title: "Auto",
                  value: AUTO,
                  description: autoPicks[0] ? `now ${modelLabel(autoPicks[0], available)}` : "session's provider",
                },
                ...available.map((model) => ({
                  title: model.name ?? model.id,
                  value: key(model),
                  description: cost(model),
                  category: model.providerID,
                })),
              ],
            })
            if (!value) return
            await updateSettings((draft) => {
              draft.model = value
            })
            working.clear()
            const picked = available.find((model) => key(model) === value)
            context.ui.toast.show({
              message: `Suggestions use ${value === AUTO ? "Auto" : (picked?.name ?? value)}`,
              variant: "info",
            })
          },
        },
        {
          id: "autosuggestions.generate",
          title: "Suggest follow-up now",
          group: "Prompt",
          palette: true,
          run: () => {
            const sessionID = routeSessionID()
            if (sessionID) void generate(sessionID)
          },
        },
      ],
      bindings: ["autosuggestions.accept", "autosuggestions.dismiss"],
    }))

    const ghost = () => {
      const current = completion()
      if (!current || !settings.enabled) return
      const target = editor()
      if (!target || target.plainText !== current.base || !atEnd(target, current.base)) return
      return current
    }

    // Drawn over the input, starting at the cursor: an absolutely positioned layer
    // in the app slot, placed from the textarea's screen position and its cursor.
    const [overlay, setOverlay] = createSignal<{ x: number; y: number; text: string }>()

    // The empty-prompt suggestion and the typing completion share this layer.
    const place = () => {
      const target = editor() as (Editor & Record<string, any>) | undefined
      const typing = ghost()
      const suggestion = !typing && target && (target.plainText ?? "") === "" ? active() : undefined
      const cursor = target?.visualCursor
      if (
        (!typing && !suggestion) ||
        !target ||
        !cursor ||
        typeof target.x !== "number" ||
        typeof target.y !== "number"
      ) {
        if (overlay()) setOverlay(undefined)
        return
      }
      const x = target.x + cursor.visualCol
      const y = target.y + cursor.visualRow
      const room = target.x + target.width - x
      const body = typing ? typing.rest : suggestion!.text
      const hint = typing ? "" : "  ⇥ tab"
      const text =
        room < hint.length + 4
          ? ""
          : body.length + hint.length > room
            ? `${body.slice(0, room - hint.length - 1)}…${hint}`
            : `${body}${hint}`
      const previous = overlay()
      if (!text) return previous && setOverlay(undefined)
      if (previous && previous.x === x && previous.y === y && previous.text === text) return
      setOverlay({ x, y, text })
    }

    const unregisterSlot = context.ui.slot({
      append: "app",
      render: () => (
        <Show when={overlay()}>
          {(current) => (
            <box position="absolute" left={current().x} top={current().y} height={1} zIndex={1000}>
              <text wrapMode="none" fg={context.theme.text.muted}>
                {current().text}
              </text>
            </box>
          )}
        </Show>
      ),
    })

    const timer = setInterval(() => {
      sync()
      place()
    }, POLL_MS)

    return () => {
      clearInterval(timer)
      cancelTyping()
      followUpCalls.forEach((call) => call.abort())
      followUpCalls.clear()
      if (typeof unregisterSlot === "function") unregisterSlot()
      stops.forEach((stop) => stop())
      restore()
    }
  },
})

// "provider/model" or "provider/model#variant".
function parseModel(value: string): ModelRef {
  const [path, variant] = value.split("#")
  const index = path.indexOf("/")
  const ref = index > 0 ? { providerID: path.slice(0, index), id: path.slice(index + 1) } : { providerID: "", id: path }
  return variant ? { ...ref, variant } : ref
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function clipEnd(text: string, max: number) {
  return text.length > max ? `…${text.slice(-max)}` : text
}

function clean(raw: string) {
  const line = raw
    .trim()
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean)
  if (!line) return ""
  const text = line.replace(/^(next user message|user)\s*:\s*/i, "").replace(/^["'`“”]+|["'`“”]+$/g, "").trim()
  if (!text || /^none\.?$/i.test(text)) return ""
  return text.length > 200 ? "" : text
}

// The model returns the whole message; keep only what comes after `text`.
function continuation(text: string, raw: string) {
  const line = raw.split("\n").find((value) => value.trim()) ?? ""
  const full = line.replace(/^(complete message)\s*:\s*/i, "").replace(/^["'`“”]+|["'`“”]+$/g, "")
  if (!full.trim() || /^none\.?$/i.test(full.trim())) return ""
  if (/(^|\s)NONE\.?$/.test(full.trim()) && !/(^|\s)NONE\.?$/.test(text.trim())) return ""
  const lastLine = text.split("\n").at(-1) ?? ""
  // Multi-line prompts: the model may only echo the last line.
  const base = full.startsWith(text) ? text : full.startsWith(lastLine) && lastLine.trim() ? lastLine : undefined
  if (base === undefined) return ""
  const rest = full.slice(base.length).trimEnd()
  return rest.trim() && rest.length <= 160 ? rest : ""
}
