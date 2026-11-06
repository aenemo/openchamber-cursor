import fs from "node:fs"
import path from "node:path"
import { Integration, Model, Provider, type Plugin } from "@opencode/plugin"
import { AUTO_CURSOR_MODELS, parseParameterizedModel, resolveCursorModel } from "../backends/auto-models.js"
import { FALLBACK_MODELS, type CursorModel } from "../backends/types.js"
import { cacheDir } from "../util/paths.js"
import { pickerLabel } from "./labels.js"
import { groupModels, selectCursorModel, type PublishedModel } from "./variants.js"

export const PROVIDER_ID = "cursor"
export const PROVIDER_NAME = "Cursor"
export const INTEGRATION_ID = "cursor"

export const CURSOR_MODEL_HEADER = "x-opencodev2-cursor-model"
export const CURSOR_VARIANT_HEADER = "x-opencodev2-cursor-variant"

export function modelInfo(model: PublishedModel) {
  const providerID = Provider.ID.make(PROVIDER_ID)
  const id = Model.ID.make(model.id)
  return {
    ...Model.Info.default(providerID, id),
    name: pickerLabel(PROVIDER_NAME, model.name),
    limit: { context: model.contextWindow, output: model.maxTokens },
    time: { released: 0 },
    variants: model.variants.map((variant) => ({
      id: Model.VariantID.make(variant.id),
      headers: { [CURSOR_MODEL_HEADER]: variant.cursorId },
    })),
  }
}

function modelsFile(): string {
  return path.join(cacheDir(), "models.json")
}

function isModel(value: unknown): value is CursorModel {
  if (!value || typeof value !== "object") return false
  const model = value as CursorModel
  return typeof model.id === "string" && model.id.length > 0 && typeof model.name === "string"
    && typeof model.contextWindow === "number" && typeof model.maxTokens === "number"
}

function readPersisted(): CursorModel[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(modelsFile(), "utf8"))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isModel)
  } catch {
    return []
  }
}

let current: CursorModel[] | undefined
let grouped: PublishedModel[] | undefined

export function resetCatalogForTests(): void {
  current = undefined
  grouped = undefined
}

/**
 * Cursor Router (`auto-smart`) has three optimize_for modes. Publish them as distinct picker models
 * and keep `auto` as an OpenCode-compatible alias of Auto-Cursor-Balanced.
 */
export function ensureRoutableAliases(models: CursorModel[]): CursorModel[] {
  const byId = new Map(models.map((model) => [model.id, model]))
  const source = byId.get("auto-smart")
    || byId.get("default")
    || byId.get("auto-cursor-balanced")
    || byId.get("auto")
    || FALLBACK_MODELS[0]!

  for (const id of [...byId.keys()]) {
    const base = parseParameterizedModel(id)?.cursorId ?? id
    if (base === "auto-smart" || base === "default") byId.delete(id)
  }
  // `auto` routes to Balanced for compatibility, but publishing it makes a second
  // picker row with the same display name as Auto-Cursor-Balanced.
  byId.delete("auto")

  for (const auto of AUTO_CURSOR_MODELS) {
    byId.set(auto.id, {
      id: auto.id,
      name: auto.name,
      contextWindow: source.contextWindow,
      maxTokens: source.maxTokens,
    })
  }

  const autos = ["auto-cursor-balanced", "auto-cursor-cost", "auto-cursor-intelligence"]
  const rest = [...byId.values()].filter((model) => !autos.includes(model.id))
  return [
    ...autos.map((id) => byId.get(id)!),
    ...rest,
  ]
}

/** @deprecated Prefer resolveCursorModel; kept for callers that only need the Cursor id string. */
export function resolveCursorModelId(model: string): string {
  return resolveCursorModel(model).cursorId
}

export function modelsForPublish(): CursorModel[] {
  if (!current) {
    const persisted = readPersisted()
    current = ensureRoutableAliases(persisted.length > 0 ? persisted : [...FALLBACK_MODELS])
  }
  return current
}

/** One OpenCode model per Cursor family and context window; effort, thinking and fast are variants. */
export function publishedModels(): PublishedModel[] {
  if (!grouped) grouped = groupModels(modelsForPublish())
  return grouped
}

/** The Cursor id to run for an OpenCode model id and its selected variant. */
export function selectModel(model: string, variant?: string, cursorModel?: string): string {
  const published = publishedModels()
  const group = published.find((entry) => entry.id === model)
  if (group && cursorModel && group.variants.some((entry) => entry.cursorId === cursorModel)) return cursorModel
  return selectCursorModel(published, model, variant)
}

/** Keep a real Cursor model list. A failed discovery returns the shared fallback array and must not wipe it. */
export function noteDiscovered(next: CursorModel[]): boolean {
  if (next === FALLBACK_MODELS || next.length === 0) return false
  current = ensureRoutableAliases(next.map((model) => ({ ...model })))
  grouped = undefined
  try {
    fs.mkdirSync(cacheDir(), { recursive: true })
    fs.writeFileSync(modelsFile(), JSON.stringify(current))
  } catch {
    // The in-memory catalog still routes this process.
  }
  return true
}

export async function publishProvider(ctx: Plugin.Context, state: { port: number; token: string }): Promise<void> {
  const providerID = Provider.ID.make(PROVIDER_ID)
  await ctx.provider.transform((editor) => {
    editor.add({
      info: {
        ...Provider.Info.empty(providerID),
        name: PROVIDER_NAME,
        activation: "enabled",
        integrationID: Integration.ID.make("cursor"),
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: `http://127.0.0.1:${state.port}/v1`,
          apiKey: state.token,
        },
        headers: { Authorization: `Bearer ${state.token}` },
      },
      models: publishedModels().map((model) => modelInfo(model)),
    })
  })
}

interface LabelEditor {
  list(): ReadonlyArray<{ providerID: string; id: string; name: string }>
  update(providerID: string, modelID: string, update: (model: { name: string }) => void): void
  provider: { get(providerID: string): { provider: { name?: string } } | undefined }
}

/** Give every other provider's models the same `<Provider> - <name>` picker label. */
export function labelOtherProviders(editor: LabelEditor): void {
  for (const model of editor.list()) {
    if (model.providerID === PROVIDER_ID) continue
    const provider = editor.provider.get(model.providerID)?.provider.name || model.providerID
    const label = pickerLabel(provider, model.name)
    if (label !== model.name) editor.update(model.providerID, model.id, (draft) => { draft.name = label })
  }
}
