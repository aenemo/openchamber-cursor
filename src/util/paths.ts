import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"

export function cacheDir(): string {
  const override = process.env.OPENCHAMBER_CURSOR_CACHE || process.env.CURSOR_CHAMBER_CACHE
  if (override) return override
  // Windows keeps %USERPROFILE%\.cache. macOS and Linux follow XDG_CACHE_HOME when it is set.
  const xdg = process.platform === "win32" ? undefined : process.env.XDG_CACHE_HOME
  return path.join(xdg || path.join(os.homedir(), ".cache"), "openchamber-cursor")
}

/** V8 compile cache shared by the SDK worker and direct cursor-agent runs. */
export function compileCacheDir(): string {
  if (process.env.NODE_COMPILE_CACHE) return process.env.NODE_COMPILE_CACHE
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "cursor-compile-cache")
  }
  return path.join(cacheDir(), "compile-cache")
}

export function conversationDir(): string {
  return path.join(cacheDir(), "conversations")
}

/** Short SDK store path. SQLite fails when the workspace path itself is the store on Windows. */
export function sdkStateDir(workspace: string): string {
  const root = process.env.CURSOR_ACP_SDK_STATE_ROOT || path.join(os.homedir(), ".cursor", "oc-sdk")
  const id = createHash("sha256").update(workspace).digest("hex").slice(0, 12)
  return path.join(root, id)
}
