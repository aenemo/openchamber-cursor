import { describe, expect, it } from "vitest"
import { expandSdkModels } from "./sdk-models.js"

describe("expandSdkModels", () => {
  it("publishes every effort variant instead of only the model family", () => {
    expect(expandSdkModels([{
      id: "grok-4.7",
      name: "Grok 4.7",
      variants: [
        { name: "Grok 4.7 Medium", params: [{ id: "effort", value: "medium" }], isDefault: true },
        { name: "Grok 4.7 High", params: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }] },
      ],
    }])).toEqual([
      { id: "grok-4.7[effort=medium]", name: "Grok 4.7 Medium" },
      { id: "grok-4.7[effort=high,fast=true]", name: "Grok 4.7 High" },
    ])
  })

  it("keeps a model that has no variants", () => {
    expect(expandSdkModels([{ id: "composer-2.5", name: "Composer 2.5" }])).toEqual([
      { id: "composer-2.5", name: "Composer 2.5" },
    ])
  })
})
