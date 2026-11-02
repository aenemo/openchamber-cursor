import type { PreparedTurn } from "./translate.js"

const TITLE_HINT =
  /\b(session title|chat title|conversation title|generate (a )?(short )?(title|name)|short title|concise title|title for (this|the) (chat|conversation|session)|name this (chat|conversation|session)|1-?2 words|one or two words|one-word|title only)\b/i

/** OpenChamber's session-title plugin asks for a short name with no tools. Answer locally so it never starts a Cursor agent. */
export function isTitleRequest(turn: PreparedTurn): boolean {
  if (turn.tools.length > 0 || turn.continuation) return false
  return TITLE_HINT.test(turn.prompt)
}

export function localTitle(userText: string): string {
  const cleaned = userText.replace(/\s+/g, " ").trim()
  if (!cleaned) return "New chat"
  const words = cleaned
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
  if (words.length === 0) return "New chat"
  const title = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
  return title.length > 48 ? `${title.slice(0, 45).trimEnd()}...` : title
}
