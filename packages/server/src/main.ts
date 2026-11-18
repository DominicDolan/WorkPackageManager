/**
 * Standalone entry: `bun run packages/server/src/main.ts`. `tasks web` spawns
 * this with `TASKS_DIR` (which workspace), `TASKS_API_PORT` and, when it has
 * already chosen one, `TASKS_WEB_DIST` (which UI).
 */
import { startServer } from "./index"

startServer({ ui: { useDefault: process.env.TASKS_DEFAULT_UI === "1" } })
