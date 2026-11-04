import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const repo = path.resolve(import.meta.dirname, "..")
const entry = path.join(repo, "dist", "index.js")
if (!fs.existsSync(entry)) {
  console.error("Build dist/index.js first (npm run build).")
  process.exit(1)
}

// OpenCode loads every directory under ~/.config/opencode/plugins automatically.
// A second copy in opencode.json shows up as two plugins and both fail activation.
const autoLoaded = path.join(os.homedir(), ".config", "opencode", "plugins", "opencodev2-cursor")
fs.rmSync(autoLoaded, { recursive: true, force: true })

const packagePath = repo.replaceAll("\\", "/")
const configPath = path.join(os.homedir(), ".config", "opencode", "opencode.json")
const entryLine = `{ "package": ${JSON.stringify(packagePath)} }`

if (!fs.existsSync(configPath)) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [{ package: packagePath }],
  }, null, 2))
} else {
  let text = fs.readFileSync(configPath, "utf8")
  text = text.replace(/\s*\{[^{}]*(?:opencodev2-cursor|openchamber-cursor|cursor-chamber)[^{}]*\},?/g, "")
  if (!text.includes(packagePath)) {
    const next = text.replace(/"plugins"\s*:\s*\[/, (match) => `${match}\n      ${entryLine},`)
    if (next === text) throw new Error("Could not find a plugins array in opencode.json")
    text = next
  }
  fs.writeFileSync(configPath, text)
}

console.log(`Removed auto-loaded copy: ${autoLoaded}`)
console.log(`Single plugin entry: ${packagePath}`)
