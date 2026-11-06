import { parseParameterizedModel } from "../backends/auto-models.js"
import type { CursorModel } from "../backends/types.js"

export interface PublishedVariant {
  /** OpenCode variant id shown in the Thinking picker, such as `high-fast`. */
  id: string
  /** Full Cursor id this variant stands for. */
  cursorId: string
}

export interface PublishedModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /** Cursor id used when OpenCode sends no variant. */
  defaultCursorId: string
  variants: PublishedVariant[]
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "extra-high", "max"]
const EFFORT_KEYS = new Set(["effort", "reasoning", "reasoning_effort"])

/** `272k` → 272000, `1m` → 1000000. */
export function parseContextSize(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(value.trim())
  if (!match) return undefined
  const scale = match[2]!.toLowerCase() === "m" ? 1_000_000 : 1_000
  return Math.round(Number(match[1]) * scale)
}

function isBoolean(value: string): boolean {
  return value === "true" || value === "false"
}

function effortRank(value: string): number {
  const index = EFFORT_ORDER.indexOf(value)
  return index === -1 ? EFFORT_ORDER.length : index
}

interface Member {
  model: CursorModel
  params: Array<{ id: string; value: string }>
}

function variantName(params: Array<{ id: string; value: string }>, varying: Set<string>): string {
  const relevant = params.filter((param) => varying.has(param.id))
  const values = relevant.filter((param) => !isBoolean(param.value)).map((param) => param.value)
  const flags = relevant.filter((param) => param.value === "true").map((param) => param.id)
  const name = [...values, ...flags].join("-")
  return name || "standard"
}

function sortKey(member: Member): [number, number, string] {
  const effort = member.params.find((param) => EFFORT_KEYS.has(param.id))
  const flags = member.params.filter((param) => param.value === "true").length
  return [effort ? effortRank(effort.value) : 0, flags, member.model.id]
}

function compareMembers(left: Member, right: Member): number {
  const a = sortKey(left)
  const b = sortKey(right)
  return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2])
}

/** Cursor's own default when the SDK reported it, otherwise medium effort, thinking on, fast off. */
function pickDefault(members: Member[]): Member {
  const flagged = members.find((member) => member.model.isDefault)
  if (flagged) return flagged
  const score = (member: Member) => {
    let total = 0
    for (const param of member.params) {
      if (EFFORT_KEYS.has(param.id)) total += param.value === "medium" ? 4 : param.value === "high" ? 2 : 0
      if (param.id === "fast" && param.value === "false") total += 1
      if (param.id === "thinking" && param.value === "true") total += 1
    }
    return total
  }
  return [...members].sort((left, right) => score(right) - score(left) || compareMembers(left, right))[0]!
}

/**
 * Cursor lists every effort/speed/thinking/context combination as its own id. OpenCode wants one
 * model per context window (it drives compaction and the token meter) with the rest as variants.
 */
export function groupModels(models: readonly CursorModel[]): PublishedModel[] {
  const groups = new Map<string, { base: string; context?: string; members: Member[] }>()
  const order: string[] = []
  for (const model of models) {
    const parsed = parseParameterizedModel(model.id)
    const base = parsed?.cursorId ?? model.id
    const params = parsed?.params ?? []
    const context = params.find((param) => param.id === "context")?.value
    const key = context ? `${base}[context=${context}]` : base
    let group = groups.get(key)
    if (!group) {
      group = { base, context, members: [] }
      groups.set(key, group)
      order.push(key)
    }
    group.members.push({ model, params: params.filter((param) => param.id !== "context") })
  }

  return order.map((key) => {
    const group = groups.get(key)!
    const first = group.members[0]!.model
    const contextWindow = (group.context && parseContextSize(group.context)) || first.contextWindow
    const fallback = pickDefault(group.members)
    if (group.members.length === 1 && group.members[0]!.params.length === 0) {
      return { id: key, name: first.name, contextWindow, maxTokens: first.maxTokens, defaultCursorId: first.id, variants: [] }
    }

    const values = new Map<string, Set<string>>()
    for (const member of group.members) {
      for (const param of member.params) {
        if (!values.has(param.id)) values.set(param.id, new Set())
        values.get(param.id)!.add(param.value)
      }
    }
    const varying = new Set([...values].filter(([, set]) => set.size > 1).map(([id]) => id))

    const variants: PublishedVariant[] = []
    const used = new Set<string>()
    for (const member of [...group.members].sort(compareMembers)) {
      let id = variantName(member.params, varying)
      if (used.has(id)) id = member.params.map((param) => `${param.id}=${param.value}`).join(",")
      if (used.has(id)) continue
      used.add(id)
      variants.push({ id, cursorId: member.model.id })
    }

    return {
      id: key,
      name: first.name,
      contextWindow,
      maxTokens: first.maxTokens,
      defaultCursorId: fallback.model.id,
      variants: variants.length > 1 ? variants : [],
    }
  })
}

/**
 * Map an OpenCode model id plus optional variant back to the Cursor id to run.
 * Ids that are not a published group (older sessions, raw Cursor ids) pass through unchanged.
 */
export function selectCursorModel(published: readonly PublishedModel[], model: string, variant?: string): string {
  const group = published.find((entry) => entry.id === model)
  if (!group) return model
  if (variant) {
    const match = group.variants.find((entry) => entry.id === variant)
    if (match) return match.cursorId
  }
  return group.defaultCursorId
}
