import { spawn, type ChildProcess } from "node:child_process"
import type { Launch } from "../util/windows.js"

export interface Spawned {
  child: ChildProcess
  lines: AsyncGenerator<string>
  stderr: () => string
}

export function spawnCommand(command: string, args: string[], cwd: string, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env): Spawned {
  const child = spawn(command, args, {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  })
  let err = ""
  child.stderr?.on("data", (chunk) => {
    err = (err + chunk.toString()).slice(-4000)
  })
  const onAbort = () => {
    child.kill()
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener("abort", onAbort, { once: true })
  child.on("close", () => signal.removeEventListener("abort", onAbort))

  async function* lines(): AsyncGenerator<string> {
    let buffer = ""
    const stdout = child.stdout
    if (!stdout) return
    for await (const chunk of stdout) {
      buffer += chunk.toString()
      const parts = buffer.split(/\r?\n/)
      buffer = parts.pop() ?? ""
      for (const part of parts) yield part
    }
    if (buffer.trim()) yield buffer
  }

  return { child, lines: lines(), stderr: () => err }
}

export function spawnLaunch(launch: Launch, args: string[], cwd: string, signal: AbortSignal): Spawned {
  return spawnCommand(launch.command, [...launch.args, ...args], cwd, signal)
}

export async function collectLaunch(launch: Launch, args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  const { child, lines } = spawnLaunch(launch, args, cwd, new AbortController().signal)
  let output = ""
  for await (const line of lines) output += `${line}\n`
  if (child.stderr) {
    for await (const chunk of child.stderr) output += chunk.toString()
  }
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve))
  return { code, output }
}

export function nodeBinary(): string {
  return process.env.CURSOR_ACP_NODE_BIN || "node"
}

export function assertNodeForSdk(version = process.version): void {
  const match = /^v(\d+)\.(\d+)/.exec(version)
  const major = Number(match?.[1] ?? 0)
  const minor = Number(match?.[2] ?? 0)
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`The Cursor SDK backend needs Node.js 22.13 or newer (found ${version}). Set CURSOR_ACP_NODE_BIN to a newer node.`)
  }
}
