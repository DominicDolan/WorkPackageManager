import { existsSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { loadConfig, type TasksConfig } from "./config"

/**
 * The two roots this tool works from, and everything derived from them.
 *
 * There are two, and conflating them is the mistake this module exists to
 * prevent. The **package root** is where the tool itself is installed — the
 * server entry point, the built SPA, the vite config. The **workspace** is the
 * `.tasks/` folder of whichever repository the command was invoked inside — the
 * database, the config file, scratch files. A globally installed `tasks` has one
 * package root and as many workspaces as there are repositories.
 */

/** Where the tool is installed. `import.meta.dir` is `<pkg>/src/config`. */
export const packageRoot = resolve(import.meta.dir, "..", "..")

export interface Workspace {
  /** Repo root — the directory that contains `.tasks/`. */
  repoRoot: string
  /** The `.tasks/` directory itself. */
  tasksDir: string
  /** SQLite file. */
  dbPath: string
  /** The aio-vr workspace, whether or not it exists yet. */
  aioVrDir: string
  /** The notes folder, whether or not it exists yet. Unlike the others this one
   *  is routinely *outside* the repo — a sibling directory with its own Git
   *  history — so nothing may assume it sits under `repoRoot`. */
  notesDir: string
  /** Built SPA assets, shipped with the package. */
  distDir: string
  /**
   * Canonical Markdown for the agent commands (`plan-tasks`, `work-task`,
   * `work-group`), shipped with the package. Inlined into the prompt at
   * `src/server/agents.ts` rather than invoked as a slash command, so a run
   * needs nothing installed beyond the harness binary — see
   * `<promptsDir>/<command>.md`. A workspace may override one by placing its
   * own at `.tasks/prompts/<command>.md`.
   */
  promptsDir: string
  /** This repository's resolved settings. */
  config: TasksConfig
}

/**
 * Walk up from `startDir` looking for a `.tasks/` directory.
 *
 * The anchor is the directory itself, not a file inside it: before the tool was
 * extracted, `.tasks/` held its own `package.json` and that was what identified
 * it. A workspace now holds nothing but config and data, so there is no marker
 * file to look for — and requiring `tasks.config.json` would make the file
 * mandatory when its whole point is that every key has a default.
 */
function findTasksDir(startDir: string): string {
  let current = resolve(startDir)

  while (true) {
    const candidate = join(current, ".tasks")
    if (existsSync(candidate)) return candidate

    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  throw new Error(
    `Could not find a .tasks/ workspace by walking up from ${startDir}. ` +
      "Run `tasks init` in the repository root, or set TASKS_DIR.",
  )
}

let cached: Workspace | undefined

export function workspace(startDir = process.cwd()): Workspace {
  if (cached) return cached

  const tasksDir = process.env.TASKS_DIR
    ? resolve(process.env.TASKS_DIR)
    : findTasksDir(startDir)
  const repoRoot = dirname(tasksDir)
  const config = loadConfig(tasksDir)

  cached = {
    repoRoot,
    tasksDir,
    dbPath: process.env.TASKS_DB
      ? resolve(process.env.TASKS_DB)
      : join(tasksDir, "data", "tasks.db"),
    // Relative config values resolve against .tasks/, so the default
    // `../.aio-vr` lands beside it in the repo root.
    aioVrDir: process.env.AIO_VR_DIR
      ? resolve(process.env.AIO_VR_DIR)
      : resolve(tasksDir, config.aioVrDir),
    notesDir: process.env.TASKS_NOTES_DIR
      ? resolve(process.env.TASKS_NOTES_DIR)
      : resolve(tasksDir, config.notesDir),
    // The CLI selects the legacy or Solid build before starting the shared API
    // server. Keeping that choice in the environment also works when this
    // package is globally installed and the workspace lives elsewhere.
    distDir: process.env.TASKS_WEB_DIST
      ? resolve(process.env.TASKS_WEB_DIST)
      : join(packageRoot, "dist", "web"),
    promptsDir: join(packageRoot, "prompts"),
    config,
  }
  return cached
}

/**
 * Resolve a repo-root-relative path emitted by aio-vr, refusing anything that
 * escapes the aio-vr workspace. The server serves screenshots straight off
 * disk, so this is what stops `?path=../../../../etc/passwd`.
 */
export function resolveArtifact(relativePath: string): string | null {
  const ws = workspace()
  const absolute = resolve(ws.repoRoot, relativePath)
  const root = ws.aioVrDir.endsWith(sep) ? ws.aioVrDir : ws.aioVrDir + sep

  if (absolute !== ws.aioVrDir && !absolute.startsWith(root)) return null
  return existsSync(absolute) ? absolute : null
}
