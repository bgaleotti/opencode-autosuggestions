// Prompts for the suggestion model. Both were tuned on small models (Claude Haiku, GPT Luna): asking for the whole
// message instead of only the missing part keeps word boundaries intact, and offering a "NONE" way out made small
// models give up too often while typing.

const FOLLOW_UP_INSTRUCTIONS = `You predict the next message a developer will type to their AI coding agent.
Read the recent conversation and write the single most likely next message from the USER.

Rules:
- Write it as the user, in the user's language and tone (match how they write: casual, lowercase, etc.).
- Short and actionable: one line, ideally 3-12 words. No quotes, no prefix, no explanation.
- Prefer the obvious next step: accepting a proposal the assistant offered ("yes, do it"), running tests, committing, fixing what failed, continuing the plan.
- If the assistant asked a question, answer it the way the user most likely would.
- When the work looks finished, suggest a natural follow-up (verify it, run it, commit, the next related task).
- Output exactly NONE only if you genuinely cannot guess anything useful.`

const COMPLETION_INSTRUCTIONS = `You autocomplete a message a developer is typing to their AI coding agent, like Copilot does for code.
Given the recent conversation and the unfinished message, finish the message the way the user most likely would.

Rules:
- Output the COMPLETE message: the unfinished text exactly as written, character for character, followed by your continuation.
- If it stops mid-word, finish that word first.
- Always add a plausible continuation of 2 to 12 words, even if unsure. Finishing the current sentence is enough.
- Keep the user's language and tone. One line, no quotes around it, no explanation.`

export function followUpPrompt(conversation: string) {
  return `${FOLLOW_UP_INSTRUCTIONS}\n\n<conversation>\n${conversation}\n</conversation>\n\nNext user message:`
}

export function completionPrompt(conversation: string, unfinished: string) {
  return `${COMPLETION_INSTRUCTIONS}\n\n<conversation>\n${conversation || "(new conversation)"}\n</conversation>\n\n<unfinished>\n${unfinished}\n</unfinished>\n\nComplete message:`
}
