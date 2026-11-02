import fs from "node:fs"
import path from "node:path"

export interface Launch {
  command: string
  args: string[]
}

export interface LaunchLookup {
  pathEnv: string
  /** Windows PATHEXT. Empty on macOS and Linux, where the launcher has no extension. */
  pathExt: string
  /** PATH separator. Defaults to the host's `path.delimiter`. */
  delimiter?: string
  exists(file: string): boolean
  sibling(file: string, name: string): string | undefined
}

export function launchFromPath(bin: string, lookup: LaunchLookup): Launch | undefined {
  const dirs = lookup.pathEnv.split(lookup.delimiter ?? path.delimiter).filter(Boolean)
  const exts = lookup.pathExt.split(";").filter(Boolean)
  const names = bin.includes(".") ? [bin] : [bin, ...exts.map((ext) => bin + ext.toLowerCase()), ...exts.map((ext) => bin + ext)]
  // Windows paths ignore case. macOS and Linux (no PATHEXT) treat different cases as different files.
  const caseInsensitive = exts.length > 0
  const seen = new Set<string>()
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      const key = caseInsensitive ? candidate.toLowerCase() : candidate
      if (seen.has(key)) continue
      seen.add(key)
      if (!lookup.exists(candidate)) continue
      return launchFor(candidate, lookup)
    }
  }
  return undefined
}

export function launchFor(file: string, lookup: Pick<LaunchLookup, "sibling">): Launch {
  const ext = path.extname(file).toLowerCase()
  if (ext === ".ps1") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file],
    }
  }
  if (ext === ".cmd" || ext === ".bat") {
    const ps1 = lookup.sibling(file, path.basename(file, ext) + ".ps1")
    if (ps1) {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
      }
    }
  }
  return { command: file, args: [] }
}

/** Looks up launchers on the host. Despite the file name, this works on macOS and Linux too. */
export function windowsLookup(platform: NodeJS.Platform = process.platform): LaunchLookup {
  return {
    pathEnv: process.env.PATH ?? "",
    pathExt: platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1") : "",
    exists: (file) => {
      try {
        return fs.existsSync(file)
      } catch {
        return false
      }
    },
    sibling: (file, name) => {
      const next = path.join(path.dirname(file), name)
      return fs.existsSync(next) ? next : undefined
    },
  }
}

export function resolveCursorAgentLaunch(explicit?: string): Launch | undefined {
  if (explicit) return launchFor(explicit, windowsLookup())
  return launchFromPath("cursor-agent", windowsLookup())
}

export interface AgentRuntime {
  node: string
  index: string
}

function versionKey(name: string): number {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?/.exec(name)
  if (!match) return 0
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match
  return Number(year) * 1e10 + Number(month) * 1e8 + Number(day) * 1e6 + Number(hour) * 1e4 + Number(minute) * 100 + Number(second)
}

function realLauncherPath(script: string, realpath: (file: string) => string): string {
  try {
    return realpath(script)
  } catch {
    return script
  }
}

/**
 * cursor-agent.ps1 forwards every argument through powershell. A long prompt then exceeds the Windows command-line limit,
 * and Linux caps one argument near 128 KB. Spawn the versioned node binary directly instead.
 * On macOS and Linux `cursor-agent` is usually a symlink into `versions/<ver>/`, so resolve it first.
 */
export function resolveAgentRuntime(
  launch: Launch,
  exists: (file: string) => boolean = fs.existsSync,
  platform: NodeJS.Platform = process.platform,
  realpath: (file: string) => string = fs.realpathSync,
): AgentRuntime | undefined {
  const fileFlag = launch.args.indexOf("-File")
  const script = fileFlag >= 0 ? launch.args[fileFlag + 1] : launch.command
  if (!script) return undefined
  const dir = path.dirname(realLauncherPath(script, realpath))
  const beside = runtimeIn(dir, exists, platform)
  if (beside) return beside
  const versions = path.join(dir, "versions")
  if (!exists(versions)) return undefined
  let names: string[] = []
  try {
    names = fs.readdirSync(versions)
  } catch {
    return undefined
  }
  const ranked = names
    .filter((name) => /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(name))
    .sort((left, right) => versionKey(right) - versionKey(left))
  for (const name of ranked) {
    const found = runtimeIn(path.join(versions, name), exists, platform)
    if (found) return found
  }
  return undefined
}

function runtimeIn(dir: string, exists: (file: string) => boolean, platform: NodeJS.Platform): AgentRuntime | undefined {
  const node = path.join(dir, platform === "win32" ? "node.exe" : "node")
  const index = path.join(dir, "index.js")
  if (exists(node) && exists(index)) return { node, index }
  return undefined
}
