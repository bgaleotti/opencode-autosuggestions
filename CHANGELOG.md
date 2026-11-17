# Changelog

## Unreleased

- Accepting the next word also works with **Option+→** (Alt+→), now the first default. On macOS, Ctrl+→ is taken by
  Mission Control to switch desktops, so it never reached OpenCode.

## 0.1.5

- Accept a suggestion one word at a time with **Ctrl+→** (option `acceptWordKey`). The rest stays as ghost text.
- No automatic follow-up after a turn that ended in an error or was cut off, or while a queued prompt, a permission
  request, or a question is waiting for you. A follow-up already on screen hides while one of those is pending.
  "Suggest follow-up now" still works any time.

## 0.1.4

- Better suggestions, measured with the new prompt eval (`eval/`) on Claude Haiku and GPT Luna:
  - The model now sees which files each tool touched, so suggestions name them ("add tests for slugify in
    utils.py").
  - Follow-ups no longer ask again for something the agent said it cannot do, answer in the agent's voice, or
    suggest running tests in projects without tests; they follow Spanish voseo.
  - Completions are shorter (1 to 8 words) and no longer include notes about the completion itself.
  - Both prompts include a few examples and treat the conversation as data, not instructions.
- Backticks at the ends of a suggestion are kept, so code like `` `fetchUser` `` is not cut.

## 0.1.3

- Remember model and reasoning-level combinations the account rejects. Errors worded "isn't available" were not
  recognized, so every suggestion retried them first and lost about a second.
- With emoji or other wide characters in the prompt, a completion could show up with the cursor in the middle of the
  text: the cursor-at-end check counted characters instead of screen cells.
- Keep models with the same id from different providers apart when Auto picks a model.
- Esc and Tab only act on a suggestion that is visible, so a stale completion no longer swallows Esc.
- New `debug` option: failures are written to a log file instead of discarded.
- Palette commands are grouped under "Autosuggestions"; "Toggle suggested prompts" is now "Toggle autosuggestions".
- Internal: split into modules, with tests, linting, and CI.

## 0.1.2

- Cancel model calls whose result is no longer needed, such as when you keep typing or send a new prompt.

## 0.1.1

- Add repository, homepage, and issue links to the package.

## 0.1.0

- First release: follow-up suggestions after each turn, and autocomplete while typing.
