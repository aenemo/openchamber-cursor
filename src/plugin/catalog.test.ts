import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { FALLBACK_MODELS } from "../backends/types.js"
import { modelsForPublish, noteDiscovered, resetCatalogForTests, resolveCursorModelId } from "./catalog.js"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openchamber-cursor-models-"))
process.env.OPENCHAMBER_CURSOR_CACHE = dir

describe("cursor model catalog", () => {
  afterEach(() => resetCatalogForTests())

  it("registers composer-2.5 before discovery finishes", () => {
    expect(modelsForPublish().map((model) => model.id)).toContain("composer-2.5")
  })

  it("publishes three Auto-Cursor modes instead of raw auto-smart", () => {
    const models = modelsForPublish()
    const ids = models.map((model) => model.id)
    expect(ids).toContain("auto-cursor-balanced")
    expect(ids).toContain("auto-cursor-cost")
    expect(ids).toContain("auto-cursor-intelligence")
    expect(ids).toContain("auto")
    expect(ids).not.toContain("auto-smart")
    expect(models.find((model) => model.id === "auto-cursor-cost")?.name).toBe("Auto-Cursor-Cost")
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

  it("keeps cursor/auto routable after discovery returns auto-smart", () => {
    noteDiscovered([
      { id: "auto-smart", name: "Auto", contextWindow: 1, maxTokens: 1 },
      { id: "default", name: "Default", contextWindow: 1, maxTokens: 1 },
    ])
    const ids = modelsForPublish().map((model) => model.id)
    expect(ids).toContain("auto")
    expect(ids).toContain("auto-cursor-balanced")
    expect(ids).not.toContain("auto-smart")
    expect(ids).not.toContain("default")
    expect(resolveCursorModelId("auto")).toBe("auto-smart")
    expect(resolveCursorModelId("auto-cursor-cost")).toBe("auto-smart")
  })
})
