import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import {
  createPlaceholderGuard,
  cursorCell,
  focusedPrompt,
  isCursorAtEnd,
  type PromptEditor,
  setPromptText,
} from "./host"
import { createLog } from "./log"
import {
  AUTO,
  attempts,
  costLabel,
  isSettingsError,
  type ModelOption,
  type ModelRef,
  modelLabel,
  pickModels,
  refKey,
} from "./models"
import { resolveOptions } from "./options"
import { createOverlay } from "./overlay"
import { completionPrompt, followUpPrompt } from "./prompts"
import { fitSuggestion, isCompletable, parseCompletion, parseFollowUp } from "./text"
import { formatTranscript, lastAssistantModel } from "./transcript"

// Two kinds of suggestions share one ghost-text layer:
// - Follow-ups: after a turn, the likely next prompt, drawn in the empty prompt.
// - Completions: after a pause while typing, the rest of the message, drawn after the cursor.
// OpenCode has no event for prompt edits, so a timer watches the prompt and redraws.

/** A follow-up for one session. */
interface FollowUp {
  readonly text: string
  dismissed: boolean
}

/** A completion: `rest` continues the prompt text `base`. */
interface Completion {
  readonly base: string
  readonly rest: string
}

const TICK_MS = 80
const COMPLETION_CONTEXT_MESSAGES = 6
const FOLLOW_UP_HINT = "  ⇥ tab"

export default Plugin.define({
  id: "opencode-autosuggestions",
  setup(context) {
    const options = resolveOptions(context.options)
    if (!options.enabled) return
    const log = createLog(options.debug)

    // Choices made in the command palette, kept across restarts. `model` is "" until one is picked; after that it
    // overrides the `model` option.
    const [settings, updateSettings] = context.storage.store("settings", {
      initial: { enabled: true, model: "", followUps: true, autocomplete: true },
    })
    const modelChoice = () => settings.model || options.model || AUTO
    const followUpsOn = () => options.followUps && settings.followUps !== false
    const autocompleteOn = () => options.autocomplete && settings.autocomplete !== false

    const overlay = createOverlay(context)
    const placeholder = createPlaceholderGuard()

    const currentSessionID = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    // --- Model calls ---------------------------------------------------------------------------------------------

    // The model and level that last worked for each choice, and the combinations the account rejected.
    const working = new Map<string, ModelRef>()
    const rejected = new Set<string>()

    const locationOf = (sessionID?: string) =>
      (sessionID ? context.data.session.get(sessionID)?.location : undefined) ??
      context.location ??
      context.data.location.default()

    const availableModels = async (sessionID?: string): Promise<ModelOption[]> => {
      const location = locationOf(sessionID)
      if (!context.data.location.model.list(location)) await context.data.location.model.sync(location)
      return (context.data.location.model.list(location) ?? []).filter(
        (model) => model.enabled && (model.type ?? "chat") === "chat" && model.status !== "deprecated",
      )
    }

    /** The model the session last ran, else the one selected in the prompt. */
    const sessionModel = (sessionID?: string): ModelRef | undefined => {
      const ran = sessionID ? lastAssistantModel(context.data.session.message.list(sessionID) ?? []) : undefined
      if (ran) return ran
      const selected = context.ui.model.current()
      return selected && { providerID: selected.providerID, id: selected.modelID }
    }

    /** Runs `prompt` on the first model and level that works. Undefined when all fail or `signal` aborts. */
    const generateText = async (prompt: string, sessionID: string | undefined, signal: AbortSignal) => {
      const available = await availableModels(sessionID)
      if (signal.aborted) return
      const choice = modelChoice()
      const candidates = pickModels(available, choice, sessionModel(sessionID))
      const cacheKey = `${choice}|${candidates.map((model) => refKey(model)).join(",")}`
      const cached = working.get(cacheKey)
      const refs = [...(cached ? [cached] : []), ...attempts(candidates, choice)]
      for (const ref of refs.filter((ref) => !rejected.has(refKey(ref)))) {
        try {
          const { text } = await context.client.experimental.generate.text({ prompt, model: ref }, { signal })
          working.set(cacheKey, ref)
          return text
        } catch (error) {
          if (signal.aborted) return
          log(`${refKey(ref)} failed:`, error)
          if (isSettingsError(error)) rejected.add(refKey(ref))
        }
      }
    }

    // --- Follow-ups ----------------------------------------------------------------------------------------------

    const followUps = new Map<string, FollowUp>()
    const followUpCalls = new Map<string, AbortController>()

    const visibleFollowUp = () => {
      const sessionID = currentSessionID()
      const followUp = settings.enabled && sessionID ? followUps.get(sessionID) : undefined
      return followUp && !followUp.dismissed ? followUp : undefined
    }

    const cancelFollowUp = (sessionID: string) => {
      followUpCalls.get(sessionID)?.abort()
      followUpCalls.delete(sessionID)
    }

    const cancelAllFollowUps = () => {
      for (const call of followUpCalls.values()) call.abort()
      followUpCalls.clear()
    }

    const requestFollowUp = async (sessionID: string) => {
      cancelFollowUp(sessionID)
      const call = new AbortController()
      followUpCalls.set(sessionID, call)
      followUps.delete(sessionID)
      try {
        await context.data.session.message.sync(sessionID)
        const messages = context.data.session.message.list(sessionID) ?? []
        const conversation = formatTranscript(messages, options)
        if (!conversation || call.signal.aborted) return
        const raw = await generateText(followUpPrompt(conversation), sessionID, call.signal)
        if (raw === undefined || call.signal.aborted) return
        const text = parseFollowUp(raw)
        if (text) followUps.set(sessionID, { text, dismissed: false })
        else log(`no follow-up in reply: ${JSON.stringify(raw)}`)
      } catch (error) {
        log("follow-up failed:", error)
      } finally {
        if (followUpCalls.get(sessionID) === call) followUpCalls.delete(sessionID)
      }
    }

    // --- Completions ---------------------------------------------------------------------------------------------

    const [completion, setCompletion] = createSignal<Completion>()
    let promptText = ""
    let completionTimer: ReturnType<typeof setTimeout> | undefined
    let completionCall: AbortController | undefined

    const cancelCompletion = () => {
      clearTimeout(completionTimer)
      completionCall?.abort()
      completionCall = undefined
    }

    const visibleCompletion = (editor: PromptEditor | undefined) => {
      const current = completion()
      if (!current || !settings.enabled || !editor) return
      return editor.plainText === current.base && isCursorAtEnd(editor) ? current : undefined
    }

    const requestCompletion = async (text: string) => {
      completionCall?.abort()
      const call = new AbortController()
      completionCall = call
      try {
        const sessionID = currentSessionID()
        const messages = sessionID ? (context.data.session.message.list(sessionID) ?? []) : []
        const conversation = formatTranscript(messages, { ...options, maxMessages: COMPLETION_CONTEXT_MESSAGES })
        const raw = await generateText(completionPrompt(conversation, text), sessionID, call.signal)
        if (raw === undefined || call.signal.aborted || promptText !== text) return
        const rest = parseCompletion(text, raw)
        if (rest) setCompletion({ base: text, rest })
        else log(`no completion in reply: ${JSON.stringify(raw)}`)
      } catch (error) {
        log("completion failed:", error)
      } finally {
        if (completionCall === call) completionCall = undefined
      }
    }

    const onPromptChange = (text: string) => {
      cancelCompletion()
      const current = completion()
      // Typing the next characters of the completion keeps the rest of it.
      if (current && text.length > current.base.length && text.startsWith(current.base)) {
        const added = text.slice(current.base.length)
        if (current.rest.length > added.length && current.rest.startsWith(added)) {
          setCompletion({ base: text, rest: current.rest.slice(added.length) })
          return
        }
      }
      setCompletion(undefined)
      if (!settings.enabled || !autocompleteOn() || !isCompletable(text)) return
      // Typing the start of the follow-up completes it without a model call.
      const sessionID = currentSessionID()
      const followUp = sessionID ? followUps.get(sessionID) : undefined
      if (followUp && followUp.text.length > text.length && followUp.text.startsWith(text)) {
        setCompletion({ base: text, rest: followUp.text.slice(text.length) })
        return
      }
      completionTimer = setTimeout(() => void requestCompletion(text), options.autocompleteDelay)
    }

    // --- Keys ----------------------------------------------------------------------------------------------------

    // Both return false when there is nothing to act on, so the key keeps its usual meaning in OpenCode.
    const accept = () => {
      const editor = focusedPrompt(context.renderer)
      if (!editor) return false
      const current = visibleCompletion(editor)
      if (current) {
        setCompletion(undefined)
        promptText = current.base + current.rest
        setPromptText(editor, promptText)
        return
      }
      const sessionID = currentSessionID()
      const followUp = visibleFollowUp()
      if (!sessionID || !followUp || editor.plainText !== "") return false
      placeholder.restore()
      setPromptText(editor, followUp.text)
      followUps.delete(sessionID)
    }

    const dismiss = () => {
      const editor = focusedPrompt(context.renderer)
      if (!editor) return false
      if (visibleCompletion(editor)) {
        cancelCompletion()
        setCompletion(undefined)
        return
      }
      const followUp = visibleFollowUp()
      if (!followUp || editor.plainText !== "") return false
      followUp.dismissed = true
      placeholder.restore()
    }

    // --- Drawing -------------------------------------------------------------------------------------------------

    const render = (editor: PromptEditor | undefined) => {
      const current = visibleCompletion(editor)
      const followUp = !current && editor?.plainText === "" ? visibleFollowUp() : undefined
      if (editor && followUp) placeholder.hide(editor)
      else placeholder.restore()
      if (!editor || (!current && !followUp)) return overlay.hide()
      const cell = cursorCell(editor)
      const text = current
        ? fitSuggestion(current.rest, "", cell.room)
        : fitSuggestion(followUp?.text ?? "", FOLLOW_UP_HINT, cell.room)
      if (!text) return overlay.hide()
      overlay.show({ x: cell.x, y: cell.y, text })
    }

    const tick = () => {
      const editor = focusedPrompt(context.renderer)
      if (editor && editor.plainText !== promptText) {
        promptText = editor.plainText
        onPromptChange(promptText)
      }
      render(editor)
    }

    // --- Wiring --------------------------------------------------------------------------------------------------

    const isRootSession = (sessionID: string) => !context.data.session.get(sessionID)?.parentID

    const unsubscribes = [
      context.data.on("session.execution.started", (event) => {
        cancelFollowUp(event.data.sessionID)
        followUps.delete(event.data.sessionID)
      }),
      context.data.on("session.execution.succeeded", (event) => {
        if (!settings.enabled || !followUpsOn() || !isRootSession(event.data.sessionID)) return
        void requestFollowUp(event.data.sessionID)
      }),
    ]

    const toast = (message: string) => context.ui.toast.show({ message, variant: "info" })

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "autosuggestions.accept",
          title: "Accept suggestion",
          group: "Autosuggestions",
          bind: options.acceptKey,
          run: accept,
        },
        {
          id: "autosuggestions.dismiss",
          title: "Dismiss suggestion",
          group: "Autosuggestions",
          bind: options.dismissKey,
          run: dismiss,
        },
        {
          id: "autosuggestions.toggle",
          title: "Toggle autosuggestions",
          group: "Autosuggestions",
          palette: true,
          run: async () => {
            await updateSettings((draft) => {
              draft.enabled = !draft.enabled
            })
            if (!settings.enabled) {
              cancelCompletion()
              cancelAllFollowUps()
            }
            toast(`Autosuggestions ${settings.enabled ? "on" : "off"}`)
          },
        },
        {
          id: "autosuggestions.followups",
          title: "Toggle follow-up suggestions",
          group: "Autosuggestions",
          palette: true,
          run: async () => {
            await updateSettings((draft) => {
              draft.followUps = draft.followUps === false
            })
            if (!followUpsOn()) {
              cancelAllFollowUps()
              followUps.clear()
            }
            toast(`Follow-up suggestions ${followUpsOn() ? "on" : "off"}`)
          },
        },
        {
          id: "autosuggestions.autocomplete",
          title: "Toggle autocomplete",
          group: "Autosuggestions",
          palette: true,
          run: async () => {
            await updateSettings((draft) => {
              draft.autocomplete = draft.autocomplete === false
            })
            if (!autocompleteOn()) {
              cancelCompletion()
              setCompletion(undefined)
            }
            toast(`Autocomplete ${autocompleteOn() ? "on" : "off"}`)
          },
        },
        {
          id: "autosuggestions.model",
          title: "Choose suggestion model",
          group: "Autosuggestions",
          palette: true,
          run: async () => {
            const sessionID = currentSessionID()
            const available = await availableModels(sessionID)
            const auto = pickModels(available, AUTO, sessionModel(sessionID))[0]
            const value = await context.ui.dialog.select({
              title: "Suggestion model",
              current: modelChoice(),
              options: [
                { title: "Auto", value: AUTO, description: auto ? `now ${modelLabel(auto, available)}` : undefined },
                ...available.map((model) => ({
                  title: model.name ?? model.id,
                  value: `${model.providerID}/${model.id}`,
                  description: costLabel(model),
                  category: model.providerID,
                })),
              ],
            })
            if (!value) return
            await updateSettings((draft) => {
              draft.model = value
            })
            working.clear()
            const picked = available.find((model) => `${model.providerID}/${model.id}` === value)
            toast(`Suggestions use ${value === AUTO ? "Auto" : (picked?.name ?? value)}`)
          },
        },
        {
          id: "autosuggestions.followup.now",
          title: "Suggest follow-up now",
          group: "Autosuggestions",
          palette: true,
          run: () => {
            const sessionID = currentSessionID()
            if (sessionID) void requestFollowUp(sessionID)
          },
        },
      ],
      bindings: ["autosuggestions.accept", "autosuggestions.dismiss"],
    }))

    const timer = setInterval(tick, TICK_MS)

    return () => {
      clearInterval(timer)
      cancelCompletion()
      cancelAllFollowUps()
      for (const unsubscribe of unsubscribes) unsubscribe()
      placeholder.restore()
      overlay.dispose()
    }
  },
})
