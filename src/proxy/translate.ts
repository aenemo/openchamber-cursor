import type { ToolSpec } from "../backends/types.js"

export interface ChatMessage {
  role?: string
  content?: unknown
  tool_calls?: Array<{
    id?: string
    function?: { name?: string; arguments?: string }
  }>
  tool_call_id?: string
  name?: string
}

export interface ChatRequest {
  model?: string
  messages?: ChatMessage[]
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown } }>
  stream?: boolean
}

export interface PreparedTurn {
  model: string
  prompt: string
  lastUserPrompt: string
  tools: ToolSpec[]
  toolResults: Array<{ id: string; content: string }>
  /** True when this request is the tool output that continues a paused Cursor run. */
  continuation: boolean
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

export function prepareTurn(body: ChatRequest): PreparedTurn {
  const messages = body.messages ?? []
  const toolResults: Array<{ id: string; content: string }> = []
  const lines: string[] = []
  let lastUserPrompt = ""
  for (const message of messages) {
    if (message.role === "tool" || message.tool_call_id) {
      toolResults.push({
        id: message.tool_call_id || "tool",
        content: contentText(message.content),
      })
      continue
    }
    const text = contentText(message.content)
    if (message.role === "system") lines.push(`System:\n${text}`)
    else if (message.role === "assistant") {
      const calls = (message.tool_calls ?? [])
        .map((call) => `${call.function?.name ?? "tool"}(${call.function?.arguments ?? ""})`)
        .join("\n")
      lines.push(`Assistant:\n${[text, calls].filter(Boolean).join("\n")}`)
    } else {
      lastUserPrompt = text
      lines.push(`User:\n${text}`)
    }
  }
  let trailing = messages.length
  while (trailing > 0 && (messages[trailing - 1]?.role === "tool" || messages[trailing - 1]?.tool_call_id)) trailing -= 1
  const continuation = trailing < messages.length
  const tools: ToolSpec[] = (body.tools ?? [])
    .map((tool) => tool.function)
    .filter((fn): fn is NonNullable<typeof fn> & { name: string } => Boolean(fn?.name))
    .map((fn) => ({
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
    }))
  return {
    model: body.model || "auto",
    prompt: lines.join("\n\n"),
    lastUserPrompt: lastUserPrompt || lines.join("\n\n"),
    tools,
    toolResults: continuation ? toolResults.slice(toolResults.length - (messages.length - trailing)) : [],
    continuation,
  }
}

export function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

export function chunk(model: string, id: string, delta: Record<string, unknown>, finish: string | null): unknown {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}
