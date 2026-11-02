import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { developmentPorts, runtimeDeployment } from "../../scripts/runtime.ts";

export default defineConfig(({ command }) => {
  const runtime = command === "serve" ? runtimeDeployment(process.env.VECTRA_RUNTIME_IDENTITY) : undefined;
  const ports = runtime ? developmentPorts(runtime.deployment.port, process.env.VECTRA_DEV_API_PORT) : undefined;
  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    // Each dev server keeps its own dependency versions and optimization output.
    cacheDir: runtime ? fileURLToPath(new URL(`../../node_modules/.vite/${runtime.identity}`, import.meta.url)) : undefined,
    plugins: [vue()],
    resolve: { alias: { "@vectra/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)) } },
    server: ports ? {
      host: "127.0.0.1", port: ports.publicPort, strictPort: true,
      proxy: { "/api": { target: `http://127.0.0.1:${ports.apiPort}`, changeOrigin: false, timeout: 0, proxyTimeout: 0 } },
    } : undefined,
    optimizeDeps: { include: ["element-plus/es/components/table/style/css", "element-plus/es/components/pagination/style/css"] },
    build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 600,
      rolldownOptions: { output: { codeSplitting: { groups: [{ name: "math-renderer", test: /[\\/]node_modules[\\/]katex[\\/]/ }] } } },
    },
  };
});
