# opencode-autosuggestions

Copilot-style prompt autosuggestions for the [OpenCode](https://opencode.ai) TUI.

![opencode-autosuggestions demo: autocomplete while typing, then follow-up suggestions after each turn](https://raw.githubusercontent.com/fedeya/opencode-autosuggestions/main/assets/demo.gif)

- **Follow-ups:** when a turn finishes, a cheap model reads the last few messages and suggests what you will probably
  type next, as ghost text in the empty prompt.
- **Autocomplete:** pause while typing and it suggests how to finish your message, right after the cursor.

**Tab** accepts, **Esc** dismisses, and typing keeps going as usual. **Enter** only ever sends what you typed.

Suggestions follow your language and tone: they are written the way you write in the conversation, and completions
continue whatever you are typing.

## Install

Built and tested with OpenCode 2.3. It is a TUI-only plugin, so add it to `~/.config/opencode/cli.json` (not
`opencode.json`):

```json
{
  "plugins": ["opencode-autosuggestions"]
}
```

## Models

By default the plugin picks a model on its own (**Auto**), using only the provider of your current session, so it never
calls an account you are not already using:

1. The cheapest priced model from that provider (for Anthropic, Claude Haiku).
2. Otherwise a model whose name says it is small (`mini`, `nano`, `flash`, `haiku`, `lite`, ...).
3. Otherwise the session's own model.

It asks for the lowest reasoning level first and falls back when an account does not allow it, remembering what failed.

To pick a model yourself, press `Ctrl+P` and run **Choose suggestion model**. The choice is saved across restarts.

## Commands

All in the command palette (`Ctrl+P`):

| Command                         | What it does                                       |
| ------------------------------- | -------------------------------------------------- |
| Choose suggestion model         | Auto, or any model you have                        |
| Toggle suggested prompts        | Turns the plugin on or off                         |
| Toggle follow-up suggestions    | Turns only the suggestion after each turn on or off |
| Toggle autocomplete             | Turns only the completions while typing on or off  |
| Suggest follow-up now           | Generates a follow-up suggestion now, even when the automatic one is off |

## Options

Pass options with the object form in `cli.json`:

```json
{
  "plugins": [
    {
      "package": "opencode-autosuggestions",
      "options": {
        "model": "openai/gpt-6-luna",
        "autocompleteDelay": 800
      }
    }
  ]
}
```

| Option              | Default    | Description                                                            |
| ------------------- | ---------- | ---------------------------------------------------------------------- |
| `enabled`           | `true`     | `false` disables the plugin entirely                                   |
| `model`             | `"auto"`   | `provider/model`, optionally `#variant` (e.g. `openai/gpt-6-luna#low`) |
| `followUps`         | `true`     | Suggest the next prompt after each turn                                |
| `autocomplete`      | `true`     | Completions while typing                                               |
| `autocompleteDelay` | `600`      | Milliseconds of pause before asking for a completion                   |
| `acceptKey`         | `"tab"`    | Key that accepts a suggestion                                          |
| `dismissKey`        | `"escape"` | Key that dismisses a suggestion                                        |
| `maxMessages`       | `8`        | Recent messages sent as context for follow-up suggestions              |
| `maxChars`          | `6000`     | Character cap for that context                                         |

A model picked from the palette overrides the `model` option. Setting `followUps` or `autocomplete` to `false` in
`cli.json` turns that feature off regardless of the palette toggles.

## Cost

Each suggestion is one short model call: one per finished turn, and one per pause while typing. To make fewer calls,
turn either one off with `"followUps": false` or `"autocomplete": false`, or from the command palette.

## How it works

OpenCode's plugin API has no way to read or draw inside the prompt, so the plugin reads the prompt through the
renderer's focused editor and draws suggestions as a layer positioned at the cursor. These are OpenCode internals, not
public API, so an OpenCode update can break the plugin. When that happens, suggestions stop showing; the prompt keeps
working.

## Development

```sh
bun install
bun run build
```

Point `cli.json` at your checkout to try it:

```json
{
  "plugins": ["/path/to/opencode-autosuggestions"]
}
```

Rebuild after changes; OpenCode reloads the plugin on its own.

## License

MIT
