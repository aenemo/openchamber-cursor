import { describe, expect, it } from "vitest"
import { pickerLabel } from "./labels.js"

describe("pickerLabel", () => {
  it("puts the provider in front of the model name", () => {
    expect(pickerLabel("Cursor", "Claude Opus 5.5")).toBe("Cursor - Claude Opus 5.5")
    expect(pickerLabel("Claude Code", "Opus 5.5")).toBe("Claude Code - Opus 5.5")
  })

  it("does not repeat the prefix when applied twice", () => {
    const once = pickerLabel("Claude Code", "Opus 5.5")
    expect(pickerLabel("Claude Code", once)).toBe(once)
  })
})
