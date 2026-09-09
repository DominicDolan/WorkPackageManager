import { fileURLToPath, URL } from "node:url"
import solid from "@solidjs/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

const apiPort = Number(process.env.TASKS_API_PORT ?? 5199)

export default defineConfig({
  root: fileURLToPath(new URL("./src/web-new", import.meta.url)),
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
    outDir: fileURLToPath(new URL("./dist/web-new", import.meta.url)),
    emptyOutDir: true,
  },
})
