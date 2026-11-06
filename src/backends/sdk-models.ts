export interface SdkModelVariant {
  name?: string
  params?: Array<{ id: string; value: string }>
  isDefault?: boolean
}

export interface SdkListedModel {
  id: string
  name: string
  variants?: SdkModelVariant[]
}

/** Picker id for one SDK variant. Params stay in the id so a later request can rebuild the SDK model selection. */
export function variantPickerId(modelId: string, params?: Array<{ id: string; value: string }>): string {
  if (!params?.length) return modelId
  return `${modelId}[${params.map((param) => `${param.id}=${param.value}`).join(",")}]`
}

/**
 * Cursor.models.list() returns one catalog entry per model family. Effort and speed
 * are variants of that entry, and each one needs its own picker row.
 */
export function expandSdkModels(models: readonly SdkListedModel[]): Array<{ id: string; name: string; isDefault?: boolean }> {
  const seen = new Set<string>()
  const expanded: Array<{ id: string; name: string; isDefault?: boolean }> = []
  for (const model of models) {
    const variants = model.variants ?? []
    const rows = variants.length > 0
      ? variants.map((variant) => ({
          id: variantPickerId(model.id, variant.params),
          name: model.name,
          ...(variant.isDefault ? { isDefault: true } : {}),
        }))
      : [{ id: model.id, name: model.name }]
    for (const row of rows) {
      if (!row.id || seen.has(row.id)) continue
      seen.add(row.id)
      expanded.push(row)
    }
  }
  return expanded
}
