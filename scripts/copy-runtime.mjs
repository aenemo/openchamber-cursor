import fs from "node:fs"
import path from "node:path"

const roots = ["src/backends", "src/backends/native"]
for (const root of roots) {
  if (!fs.existsSync(root)) continue
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith(".mjs")) continue
    const from = path.join(root, name)
    const to = path.join("dist", root.slice("src/".length), name)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
  }
}
