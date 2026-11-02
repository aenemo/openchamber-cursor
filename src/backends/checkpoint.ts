import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { conversationDir } from "../util/paths.js"

const CHECKPOINT_VERSION = 2

export interface Checkpoint {
  version?: number
  agentId: string
  model: string
  updatedAt: number
}

function fileFor(sessionKey: string): string {
  const safe = sessionKey.replace(/[^a-z0-9_-]/gi, "_").slice(0, 120)
  return path.join(conversationDir(), `${safe}.json.gz`)
}

export function readCheckpoint(sessionKey: string): Checkpoint | undefined {
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(fileFor(sessionKey)))
    const parsed = JSON.parse(raw.toString()) as Checkpoint
    if (!parsed.agentId || parsed.version !== CHECKPOINT_VERSION) return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function writeCheckpoint(sessionKey: string, checkpoint: Omit<Checkpoint, "updatedAt">): void {
  const dir = conversationDir()
  fs.mkdirSync(dir, { recursive: true })
  const body = zlib.gzipSync(JSON.stringify({ ...checkpoint, version: CHECKPOINT_VERSION, updatedAt: Date.now() }))
  fs.writeFileSync(fileFor(sessionKey), body)
}
