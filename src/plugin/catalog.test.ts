import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { FALLBACK_MODELS } from "../backends/types.js"
import { labelOtherProviders, modelInfo, modelsForPublish, noteDiscovered, publishedModels, resetCatalogForTests, resolveCursorModelId } from "./catalog.js"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodev2-cursor-models-"))
process.env.OPENCODEV2_CURSOR_CACHE = dir

describe("cursor model catalog", () => {
  afterEach(() => resetCatalogForTests())

  it("registers composer-2.5 before discovery finishes", () => {
    expect(modelsForPublish().map((model) => model.id)).toContain("composer-2.5")
  })

  it("publishes three distinct Auto-Cursor modes without the cursor/auto alias", () => {
    const models = modelsForPublish()
    const ids = models.map((model) => model.id)
    expect(ids).toContain("auto-cursor-balanced")
    expect(ids).toContain("auto-cursor-cost")
    expect(ids).toContain("auto-cursor-intelligence")
    expect(ids).not.toContain("auto")
    expect(ids).not.toContain("auto-smart")
    expect(models.find((model) => model.id === "auto-cursor-cost")?.name).toBe("Auto-Cursor-Cost")
    expect(new Set(models.map((model) => model.name)).size).toBe(models.length)
  })

  it("keeps discovered models when a later refresh falls back", () => {
    expect(noteDiscovered([{ id: "gpt-5", name: "GPT-5", contextWindow: 1, maxTokens: 1 }])).toBe(true)
    expect(noteDiscovered(FALLBACK_MODELS)).toBe(false)
    const ids = modelsForPublish().map((model) => model.id)
    expect(ids).toContain("gpt-5")
    expect(ids).toContain("auto-cursor-balanced")
  })

  it("reloads a persisted catalog on the next process", () => {
    noteDiscovered([{ id: "sonnet", name: "Sonnet", contextWindow: 1, maxTokens: 1 }])
    resetCatalogForTests()
    expect(modelsForPublish().some((model) => model.id === "sonnet")).toBe(true)
  })

  it("keeps cursor/auto routable without publishing the alias", () => {
    noteDiscovered([
      { id: "auto-smart", name: "Auto", contextWindow: 1, maxTokens: 1 },
      { id: "default", name: "Default", contextWindow: 1, maxTokens: 1 },
      { id: "auto-smart[optimize_for=cost]", name: "Auto", contextWindow: 1, maxTokens: 1 },
    ])
    const ids = modelsForPublish().map((model) => model.id)
    expect(ids).not.toContain("auto")
    expect(ids).toContain("auto-cursor-balanced")
    expect(ids).not.toContain("auto-smart")
    expect(ids).not.toContain("auto-smart[optimize_for=cost]")
    expect(ids).not.toContain("default")
    expect(resolveCursorModelId("auto")).toBe("auto-smart")
    expect(resolveCursorModelId("auto-cursor-cost")).toBe("auto-smart")
  })

  it("labels picker rows with the provider", () => {
    noteDiscovered([
      { id: "claude-opus-5-5[context=1m,effort=medium]", name: "Claude Opus 5.5", contextWindow: 1, maxTokens: 1 },
      { id: "claude-opus-5-5[context=1m,effort=high]", name: "Claude Opus 5.5", contextWindow: 1, maxTokens: 1 },
    ])
    const opus = publishedModels().find((model) => model.id === "claude-opus-5-5[context=1m]")!
    expect(modelInfo(opus).name).toBe("Cursor - Claude Opus 5.5")
  })

  it("labels other providers' models and leaves Cursor rows alone", () => {
    const models = [
      { providerID: "claude-code", id: "claude-opus-5-5", name: "Opus 5.5" },
      { providerID: "claude-code", id: "already", name: "Claude Code - Sonnet 5.5" },
      { providerID: "cursor", id: "gpt-5", name: "Cursor - GPT-5" },
    ]
    const renamed: Record<string, string> = {}
    labelOtherProviders({
      list: () => models,
      update: (providerID, modelID, update) => {
        const draft = { name: "" }
        update(draft)
        renamed[`${providerID}/${modelID}`] = draft.name
      },
      provider: { get: (providerID) => (providerID === "claude-code" ? { provider: { name: "Claude Code" } } : undefined) },
    })
    expect(renamed).toEqual({ "claude-code/claude-opus-5-5": "Claude Code - Opus 5.5" })
  })
})
