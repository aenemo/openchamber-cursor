/** Cursor Router is one model id (`auto-smart`) with optimize_for = cost | balanced | intelligence. */
export type OptimizeFor = "cost" | "balanced" | "intelligence"

export interface AutoCursorModel {
  id: string
  name: string
  optimizeFor: OptimizeFor
}

export const AUTO_CURSOR_MODELS: readonly AutoCursorModel[] = [
  { id: "auto-cursor-balanced", name: "Auto-Cursor-Balanced", optimizeFor: "balanced" },
  { id: "auto-cursor-cost", name: "Auto-Cursor-Cost", optimizeFor: "cost" },
  { id: "auto-cursor-intelligence", name: "Auto-Cursor-Intelligence", optimizeFor: "intelligence" },
] as const

export interface ResolvedCursorModel {
  /** Id shown / selected in OpenCode. */
  pickerId: string
  /** Id sent to Cursor (`auto-smart` for all Auto-Cursor-* variants). */
  cursorId: string
  params?: Array<{ id: string; value: string }>
  /** cursor-agent --model value, including bracket params when needed. */
  cliModel: string
}

export function isAutoCursorId(model: string): boolean {
  return model === "auto"
    || model === "auto-smart"
    || model === "default"
    || AUTO_CURSOR_MODELS.some((entry) => entry.id === model)
}

export function resolveCursorModel(model: string): ResolvedCursorModel {
  const named = AUTO_CURSOR_MODELS.find((entry) => entry.id === model)
  if (named) {
    return {
      pickerId: named.id,
      cursorId: "auto-smart",
      params: [{ id: "optimize_for", value: named.optimizeFor }],
      cliModel: `auto-smart[optimize_for=${named.optimizeFor}]`,
    }
  }
  // OpenCode defaults and Cursor's raw router ids map to Balance (Cursor's default Auto mode).
  if (isAutoCursorId(model)) {
    return {
      pickerId: model,
      cursorId: "auto-smart",
      params: [{ id: "optimize_for", value: "balanced" }],
      cliModel: "auto-smart[optimize_for=balanced]",
    }
  }
  return {
    pickerId: model,
    cursorId: model,
    cliModel: model,
  }
}

export function modelSelectionKey(model: string, params?: Array<{ id: string; value: string }>): string {
  const list = [...(params ?? [])]
    .map((param) => ({ id: String(param.id), value: String(param.value) }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return JSON.stringify({ id: model, params: list })
}
