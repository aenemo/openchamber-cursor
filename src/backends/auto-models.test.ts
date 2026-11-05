import { describe, expect, it } from "vitest"
import { modelSelectionKey, resolveCursorModel } from "./auto-models.js"
import { resumeAgentId } from "./sdk.js"
import { assertNodeForSdk } from "./spawn.js"

describe("resolveCursorModel", () => {
  it("maps Auto-Cursor-* picker ids to auto-smart with optimize_for", () => {
    expect(resolveCursorModel("auto-cursor-cost")).toEqual({
      pickerId: "auto-cursor-cost",
      cursorId: "auto-smart",
      params: [{ id: "optimize_for", value: "cost" }],
      cliModel: "auto-smart[optimize_for=cost]",
    })
    expect(resolveCursorModel("auto-cursor-balanced").params).toEqual([
      { id: "optimize_for", value: "balanced" },
    ])
    expect(resolveCursorModel("auto-cursor-intelligence").cliModel).toBe(
      "auto-smart[optimize_for=intelligence]",
    )
  })

  it("treats auto / auto-smart / default as Balance", () => {
    expect(resolveCursorModel("auto").cliModel).toBe("auto-smart[optimize_for=balanced]")
    expect(resolveCursorModel("auto-smart").params?.[0]?.value).toBe("balanced")
    expect(resolveCursorModel("default").cursorId).toBe("auto-smart")
  })

  it("sends a variant's parameters with its base model id", () => {
    expect(resolveCursorModel("grok-4.7[effort=high,fast=true]")).toEqual({
      pickerId: "grok-4.7[effort=high,fast=true]",
      cursorId: "grok-4.7",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
      ],
      cliModel: "grok-4.7[effort=high,fast=true]",
    })
  })

  it("passes non-auto models through unchanged", () => {
    expect(resolveCursorModel("composer-2.5")).toEqual({
      pickerId: "composer-2.5",
      cursorId: "composer-2.5",
      cliModel: "composer-2.5",
    })
  })

  it("gives each Auto-Cursor mode its own selection key", () => {
    const cost = resolveCursorModel("auto-cursor-cost")
    const intelligence = resolveCursorModel("auto-cursor-intelligence")
    expect(modelSelectionKey(cost.cursorId, cost.params)).not.toBe(
      modelSelectionKey(intelligence.cursorId, intelligence.params),
    )
  })
})

describe("resumeAgentId", () => {
  const balanced = resolveCursorModel("auto-cursor-balanced")
  const cost = resolveCursorModel("auto-cursor-cost")
  const balancedKey = modelSelectionKey(balanced.cursorId, balanced.params)

  it("resumes a live agent only for the same model selection", () => {
    const live = { agentId: "agent-1", modelKey: balancedKey }
    expect(resumeAgentId(balanced.cursorId, balanced.params, live, undefined)).toBe("agent-1")
    expect(resumeAgentId(cost.cursorId, cost.params, live, undefined)).toBeUndefined()
  })

  it("keeps an older checkpoint that stored the plain model id", () => {
    expect(resumeAgentId("composer-2.5", undefined, undefined, { agentId: "agent-2", model: "composer-2.5" })).toBe("agent-2")
    expect(resumeAgentId("composer-2", undefined, undefined, { agentId: "agent-2", model: "composer-2.5" })).toBeUndefined()
    expect(resumeAgentId(balanced.cursorId, balanced.params, undefined, { agentId: "agent-3", model: "auto-smart" })).toBeUndefined()
  })
})

describe("assertNodeForSdk", () => {
  it("rejects Node older than 22.13 and names CURSOR_ACP_NODE_BIN", () => {
    expect(() => assertNodeForSdk("v22.12.0")).toThrow(/CURSOR_ACP_NODE_BIN/)
    expect(() => assertNodeForSdk("v22.13.0")).not.toThrow()
  })
})
