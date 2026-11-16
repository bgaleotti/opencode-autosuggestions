# Changelog

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
