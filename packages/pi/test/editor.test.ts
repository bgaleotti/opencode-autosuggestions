import { expect, test } from "bun:test"
import { CURSOR_MARKER, renderFakeCursor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { drawSuggestion } from "../src/editor"

test("ghost text keeps the cursor in place and fits the editor's cell width", () => {
  const line = `fix ${CURSOR_MARKER}${renderFakeCursor(" ")}    `
  const result = drawSuggestion(line, "界面测试", 9)
  expect(result).toContain(CURSOR_MARKER + renderFakeCursor("界"))
  expect(stripTerminalSequences(result)).toBe("fix 界面…")
  expect(visibleWidth(result)).toBe(9)
})

test("ghost text cannot send terminal escapes or overwrite an existing character", () => {
  const blank = CURSOR_MARKER + renderFakeCursor(" ")
  expect(stripTerminalSequences(drawSuggestion(blank, "\x1b[2J", 5))).toBe(" [2J ")
  const middle = CURSOR_MARKER + renderFakeCursor("x")
  expect(drawSuggestion(middle, "suffix", 8)).toBe(middle)
})
