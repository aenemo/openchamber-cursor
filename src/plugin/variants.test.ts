import { describe, expect, it } from "vitest"
import type { CursorModel } from "../backends/types.js"
import { groupModels, parseContextSize, selectCursorModel } from "./variants.js"

function row(id: string, name: string, isDefault = false): CursorModel {
  return { id, name, contextWindow: 256000, maxTokens: 32000, ...(isDefault ? { isDefault: true } : {}) }
}

const sol = ["272k", "1m"].flatMap((context) =>
  ["low", "medium", "high"].flatMap((reasoning) =>
    ["false", "true"].map((fast) => row(`gpt-5.6-sol[context=${context},reasoning=${reasoning},fast=${fast}]`, "GPT-5.6 Sol")),
  ),
)

describe("groupModels", () => {
  it("splits a family by context window and makes effort and fast into variants", () => {
    const published = groupModels(sol)
    expect(published.map((model) => [model.id, model.contextWindow])).toEqual([
      ["gpt-5.6-sol[context=272k]", 272000],
      ["gpt-5.6-sol[context=1m]", 1000000],
    ])
    const small = published[0]!
    expect(small.name).toBe("GPT-5.6 Sol")
    expect(small.variants.map((variant) => variant.id)).toEqual([
      "low", "low-fast", "medium", "medium-fast", "high", "high-fast",
    ])
    expect(small.variants.find((variant) => variant.id === "high-fast")?.cursorId)
      .toBe("gpt-5.6-sol[context=272k,reasoning=high,fast=true]")
    expect(small.defaultCursorId).toBe("gpt-5.6-sol[context=272k,reasoning=medium,fast=false]")
  })

  it("names thinking as a flag and drops params that never change", () => {
    const published = groupModels([
      row("claude-opus-4-8[cyber=false,thinking=false,context=300k,effort=high,fast=false]", "Opus 4.8"),
      row("claude-opus-4-8[cyber=false,thinking=true,context=300k,effort=high,fast=false]", "Opus 4.8"),
      row("claude-opus-4-8[cyber=false,thinking=true,context=300k,effort=high,fast=true]", "Opus 4.8"),
    ])
    expect(published).toHaveLength(1)
    expect(published[0]!.variants.map((variant) => variant.id)).toEqual(["standard", "thinking", "thinking-fast"])
  })

  it("prefers the default Cursor reported", () => {
    const published = groupModels([
      row("composer-2.5[fast=false]", "Composer 2.5"),
      row("composer-2.5[fast=true]", "Composer 2.5", true),
    ])
    expect(published[0]!.id).toBe("composer-2.5")
    expect(published[0]!.defaultCursorId).toBe("composer-2.5[fast=true]")
    expect(published[0]!.variants.map((variant) => variant.id)).toEqual(["standard", "fast"])
  })

  it("leaves plain models and Auto modes without variants", () => {
    const published = groupModels([row("auto-cursor-balanced", "Auto-Cursor-Balanced"), row("gemini-3-flash", "Gemini 3 Flash")])
    expect(published.map((model) => [model.id, model.variants.length])).toEqual([
      ["auto-cursor-balanced", 0],
      ["gemini-3-flash", 0],
    ])
  })
})

describe("selectCursorModel", () => {
  const published = groupModels(sol)

  it("maps the selected variant to the full Cursor id", () => {
    expect(selectCursorModel(published, "gpt-5.6-sol[context=1m]", "high-fast"))
      .toBe("gpt-5.6-sol[context=1m,reasoning=high,fast=true]")
  })

  it("uses the group default when no variant or an unknown one is sent", () => {
    expect(selectCursorModel(published, "gpt-5.6-sol[context=1m]")).toBe("gpt-5.6-sol[context=1m,reasoning=medium,fast=false]")
    expect(selectCursorModel(published, "gpt-5.6-sol[context=1m]", "nope")).toBe("gpt-5.6-sol[context=1m,reasoning=medium,fast=false]")
  })

  it("passes older full Cursor ids through", () => {
    const old = "gpt-5.6-sol[context=272k,reasoning=low,fast=true]"
    expect(selectCursorModel(published, old)).toBe(old)
  })
})

describe("parseContextSize", () => {
  it("reads k and m suffixes", () => {
    expect(parseContextSize("272k")).toBe(272000)
    expect(parseContextSize("1m")).toBe(1000000)
    expect(parseContextSize("wide")).toBeUndefined()
  })
})
