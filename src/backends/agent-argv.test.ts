import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

describe("agent argv wrapper", () => {
  it("delivers a long prompt without putting it on the command line", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-argv-"))
    const index = path.join(dir, "index.js")
    const promptFile = path.join(dir, "prompt.txt")
    const prompt = `hello ${"x".repeat(40_000)}`
    fs.writeFileSync(index, "process.stdout.write(process.argv.at(-1) ?? '')")
    fs.writeFileSync(promptFile, prompt)
    const wrapper = fileURLToPath(new URL("./agent-argv.mjs", import.meta.url))
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [wrapper, promptFile, index, "--print"], { stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      child.stdout?.on("data", (chunk) => { stdout += chunk.toString() })
      child.stderr?.on("data", (chunk) => { stderr += chunk.toString() })
      child.once("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`))))
    })
    expect(output).toBe(prompt)
  })
})
