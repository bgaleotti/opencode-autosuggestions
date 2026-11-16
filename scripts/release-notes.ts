// Prints the CHANGELOG section for a version, for the GitHub release notes.
//
//   bun scripts/release-notes.ts 0.1.4

import { readFileSync } from "node:fs"
import { join } from "node:path"

const version = process.argv[2]?.replace(/^v/, "")
if (!version) {
  console.error("usage: bun scripts/release-notes.ts <version>")
  process.exit(1)
}

const changelog = readFileSync(join(import.meta.dir, "..", "CHANGELOG.md"), "utf8")
const sections = changelog.split(/^## /m).slice(1)
const section = sections.find((text) => text.split("\n")[0]?.trim() === version)
if (!section) {
  console.error(`No "## ${version}" section in CHANGELOG.md`)
  process.exit(1)
}
console.log(section.slice(section.indexOf("\n") + 1).trim())
