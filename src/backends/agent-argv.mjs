import fs from "node:fs"
import { pathToFileURL } from "node:url"

const [promptFile, indexJs, ...args] = process.argv.slice(2)
if (!promptFile || !indexJs) {
  process.stderr.write("usage: agent-argv.mjs <prompt-file> <index.js> [agent args...]\n")
  process.exit(1)
}

const prompt = fs.readFileSync(promptFile, "utf8")
process.argv = [process.execPath, indexJs, ...args, prompt]
await import(pathToFileURL(indexJs).href)
