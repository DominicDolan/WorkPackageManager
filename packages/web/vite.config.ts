import { fileURLToPath, URL } from "node:url"
import { defineConfig } from "vite"
import solid from "@solidjs/vite-plugin"
import tailwindcss from "@tailwindcss/vite"

// Port the bun API server listens on. In dev the SPA runs on its own port and
// proxies /api through, so the frontend talks to a single origin either way.
const apiPort = Number(process.env.TASKS_API_PORT ?? 5199)

export default defineConfig({
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [solid(), tailwindcss()],
    server: {
        port: Number(process.env.TASKS_WEB_PORT ?? 5200),
        strictPort: true,
        proxy: {
            "/api": {
                target: `http://127.0.0.1:${apiPort}`,
                changeOrigin: false,
            },
        },
    },
    build: {
        // The server finds this as `@work-task-manager/web`'s `dist/`
        // (see packages/server/src/ui.ts).
        outDir: fileURLToPath(new URL("./dist", import.meta.url)),
        emptyOutDir: true,
    },
})
