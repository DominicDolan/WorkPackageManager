import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CONFIG_FILENAME, merge } from "./config/config"
import { lazyWorkspace } from "./config/paths"
import { announceChange } from "./watch"

const ws = lazyWorkspace()

/** `tasks.config.json` exactly as written, or `{}` when there is none. */
export function readConfigContent(): string {
    const path = join(ws.tasksDir, CONFIG_FILENAME)
    return existsSync(path) ? readFileSync(path, "utf8") : "{}"
}

/**
 * Replace `tasks.config.json` with `content`, validated first so a bad edit
 * never reaches disk, and applied to the running process at once. Returns the
 * file as saved (normalised indentation).
 */
export function writeConfigContent(content: string): string {
    let raw: unknown
    try {
        raw = JSON.parse(content)
    } catch (error) {
        throw new Error(`Config must be valid JSON: ${String(error)}`)
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        throw new Error("Config must contain a JSON object.")
    const effective = merge(raw as Record<string, unknown>)
    const saved = `${JSON.stringify(raw, null, 4)}\n`
    writeFileSync(join(ws.tasksDir, CONFIG_FILENAME), saved)
    Object.assign(ws.config, effective)
    announceChange("tasks")
    return saved
}
