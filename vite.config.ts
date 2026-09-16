import { fileURLToPath, URL } from "node:url"
import { defineConfig } from "vite"
import solid from "@solidjs/vite-plugin"
import tailwindcss from "@tailwindcss/vite"

// Port the bun API server listens on. In dev the SPA runs on its own port and
// proxies /api through, so the frontend talks to a single origin either way.
const apiPort = Number(process.env.TASKS_API_PORT ?? 5199)

export default defineConfig({
  root: fileURLToPath(new URL("./src/web", import.meta.url)),
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  server: {
    port: Number(process.env.TASKS_WEB_PORT ?? 5200),
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
  build: {
    // `dist/web`, not `dist`, because the package ships this build and the
    // server resolves it as packageRoot/dist/web.
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
  },
})
