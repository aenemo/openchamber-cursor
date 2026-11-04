import fs from "node:fs"
import path from "node:path"
import { cacheDir } from "./paths.js"

let dirReady = false

function logFile(): string {
  const dir = cacheDir()
  if (!dirReady) {
    fs.mkdirSync(dir, { recursive: true })
    dirReady = true
  }
  return path.join(dir, "opencodev2-cursor.log")
}

export function log(level: "info" | "warn" | "error", message: string, extra?: unknown): void {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    message,
    extra: extra === undefined ? undefined : extra,
  })
  try {
    fs.appendFileSync(logFile(), line + "\n")
  } catch {
    // Logging must not break a turn.
  }
}
