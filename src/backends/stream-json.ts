import type { BackendEvent } from "./types.js"

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const record = part as { type?: string; text?: string }
      if (record.type === "text" && typeof record.text === "string") return record.text
      return ""
    })
    .join("")
}

function toolName(value: unknown): { name: string; args: unknown } | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (typeof record.name === "string") return { name: record.name, args: record.arguments ?? record.args ?? record.input }
  for (const [key, entry] of Object.entries(record)) {
    if (!key.endsWith("ToolCall") || !entry || typeof entry !== "object") continue
    const call = entry as { args?: unknown; name?: string }
    const name = typeof call.name === "string" ? call.name : key.replace(/ToolCall$/, "")
    return { name, args: call.args ?? {} }
  }
  return undefined
}

/** Turns one cursor-agent stream-json line into backend events. Malformed lines are ignored. */
export function parseStreamJsonLine(line: string): BackendEvent[] {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("data:")) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.startsWith("data:") ? trimmed.slice(5) : trimmed)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object") return []
  const event = parsed as Record<string, unknown>
  const type = typeof event.type === "string" ? event.type : ""

  if (type === "thinking" && typeof event.text === "string") return [{ type: "reasoning", text: event.text }]
  if (type === "reasoning" && typeof event.text === "string") return [{ type: "reasoning", text: event.text }]

  if (type === "assistant" || type === "text") {
    const message = event.message as { content?: unknown } | undefined
    const text = textFromContent(message?.content ?? event.content ?? event.text)
    return text ? [{ type: "text", text }] : []
  }

  if (type === "tool_call" || type === "tool_use") {
    const call = toolName(event.tool_call ?? event)
    if (!call) return []
    const status = typeof event.subtype === "string" ? event.subtype : typeof event.status === "string" ? event.status : ""
    if (status && !/start|running|call/i.test(status) && status !== "") return []
    return [{
      type: "tool_call",
      id: typeof event.call_id === "string" ? event.call_id : typeof event.id === "string" ? event.id : `call_${call.name}`,
      name: call.name,
      arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {}),
    }]
  }

  if (type === "result") {
    const text = typeof event.result === "string" ? event.result : typeof event.text === "string" ? event.text : undefined
    if (event.is_error === true || event.subtype === "error") {
      return [{ type: "error", message: text || "cursor-agent failed" }]
    }
    return [{ type: "done", text }]
  }

  if (type === "error") {
    return [{ type: "error", message: typeof event.message === "string" ? event.message : "cursor-agent failed" }]
  }
  return []
}

export function parseModelList(output: string): Array<{ id: string; name: string }> {
  const models: Array<{ id: string; name: string }> = []
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#") || /available models/i.test(trimmed)) continue
    try {
      const parsed = JSON.parse(trimmed) as { id?: string; name?: string; model?: string }
      const id = parsed.id || parsed.model
      if (id) {
        models.push({ id, name: parsed.name || id })
        continue
      }
    } catch {
      // Plain text listing.
    }
    const id = trimmed.split(/\s+/)[0]?.replace(/^-/, "")
    if (id && /^[a-z0-9][a-z0-9._-]*$/i.test(id)) models.push({ id, name: trimmed })
  }
  return models
}
