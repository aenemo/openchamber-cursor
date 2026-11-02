/**
 * Protobuf body for the native Connect fallback.
 * Field numbers belong to this plugin, not Cursor's AgentService schema:
 * 1 model, 2 prompt, 3 model params JSON, 4 tools JSON, 5 tool results JSON.
 */

function encodeVarint(value: number): number[] {
  const bytes: number[] = []
  let rest = value >>> 0
  while (rest > 127) {
    bytes.push((rest & 0x7f) | 0x80)
    rest >>>= 7
  }
  bytes.push(rest)
  return bytes
}

function encodeString(field: number, value: string): number[] {
  const data = Buffer.from(value)
  return [(field << 3) | 2, ...encodeVarint(data.length), ...data]
}

export interface ConnectRunExtra {
  modelParams?: Array<{ id: string; value: string }>
  tools?: Array<{ name: string; description?: string; parameters?: unknown }>
  toolResults?: Array<{ id: string; content: string }>
}

export function encodeRunRequest(model: string, prompt: string, extra?: ConnectRunExtra): Buffer {
  const bytes = [...encodeString(1, model), ...encodeString(2, prompt)]
  if (extra?.modelParams?.length) bytes.push(...encodeString(3, JSON.stringify(extra.modelParams)))
  if (extra?.tools?.length) bytes.push(...encodeString(4, JSON.stringify(extra.tools)))
  if (extra?.toolResults?.length) bytes.push(...encodeString(5, JSON.stringify(extra.toolResults)))
  return Buffer.from(bytes)
}

/** Connect streaming envelope: one data frame plus an end-of-stream frame. */
export function encodeConnectFrames(payload: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header[0] = 0
  header.writeUInt32BE(payload.length, 1)
  const end = Buffer.alloc(5)
  end[0] = 0x02
  end.writeUInt32BE(2, 1)
  return Buffer.concat([header, payload, end, Buffer.from("{}")])
}

export function decodeConnectData(frame: Buffer): Buffer[] {
  const parts: Buffer[] = []
  let offset = 0
  while (offset + 5 <= frame.length) {
    const flags = frame[offset]
    const length = frame.readUInt32BE(offset + 1)
    offset += 5
    const body = frame.subarray(offset, offset + length)
    offset += length
    if ((flags & 0x02) === 0) parts.push(Buffer.from(body))
  }
  return parts
}

export function stringsInProtobuf(payload: Buffer): string[] {
  const found: string[] = []
  let offset = 0
  while (offset < payload.length) {
    const key = payload[offset]
    if (key === undefined) break
    offset += 1
    const wire = key & 7
    if (wire === 2) {
      let length = 0
      let shift = 0
      while (offset < payload.length) {
        const byte = payload[offset]
        offset += 1
        if (byte === undefined) break
        length |= (byte & 0x7f) << shift
        if ((byte & 0x80) === 0) break
        shift += 7
      }
      const slice = payload.subarray(offset, offset + length)
      offset += length
      const text = readableText(slice)
      if (text) found.push(text)
    } else if (wire === 0) {
      while (offset < payload.length && (payload[offset]! & 0x80) !== 0) offset += 1
      offset += 1
    } else break
  }
  return found
}

function readableText(slice: Buffer): string | undefined {
  if (slice.length === 0 || slice.includes(0)) return undefined
  const text = slice.toString("utf8")
  if (text.includes("\uFFFD")) return undefined
  const chars = [...text]
  let printable = 0
  for (const char of chars) {
    const code = char.codePointAt(0) ?? 0
    if (code === 9 || code === 10 || code === 13 || code >= 32) printable += 1
  }
  if (printable !== chars.length) return undefined
  return text
}

/** A Connect string that is itself a tool call. Plain assistant text is left alone. */
export function toolCallFromText(text: string): { id: string; name: string; arguments: string } | undefined {
  if (!text.startsWith("{")) return undefined
  try {
    const value = JSON.parse(text) as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }
    if (value.type !== "tool_call" || typeof value.name !== "string") return undefined
    const args = typeof value.arguments === "string"
      ? value.arguments
      : value.arguments && typeof value.arguments === "object"
        ? JSON.stringify(value.arguments)
        : undefined
    if (!args) return undefined
    return { id: typeof value.id === "string" ? value.id : "tool", name: value.name, arguments: args }
  } catch {
    return undefined
  }
}
