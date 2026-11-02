/** Cursor tool names that OpenCode can run itself. */
const CURSOR_TO_OPENCODE: Record<string, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  strreplace: "edit",
  grep: "grep",
  glob: "glob",
  find: "glob",
  ls: "glob",
  shell: "shell",
  bash: "shell",
  task: "subagent",
  subagent: "subagent",
}

export function mapCursorTool(name: string, advertised: ReadonlySet<string>): string | undefined {
  const key = name.trim().toLowerCase().replace(/[\s_-]+/g, "")
  const mapped = CURSOR_TO_OPENCODE[key]
  if (!mapped || !advertised.has(mapped)) return undefined
  return mapped
}

export function advertisedNames(tools: ReadonlyArray<{ name: string }>): Set<string> {
  return new Set(tools.map((tool) => tool.name))
}
