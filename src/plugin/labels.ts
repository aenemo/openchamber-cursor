/**
 * `Cursor - Claude Opus 5.5`. Safe to apply twice: an existing provider prefix is not repeated,
 * because model transforms run again on every provider reload.
 */
export function pickerLabel(provider: string, name: string): string {
  const prefix = `${provider} - `
  return name.startsWith(prefix) ? name : prefix + name
}
