import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  resolve: { alias: { "@vectra/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)) } },
  server: {
    host: "127.0.0.1", port: Number(process.env.VECTRA_WEB_PORT || 5173), strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.VECTRA_PORT || 8000}`, changeOrigin: false, timeout: 0, proxyTimeout: 0 } },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 600 },
});
