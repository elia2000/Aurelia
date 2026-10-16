import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, path.resolve(import.meta.dirname, ".."), "");
  const apiPort = Number(
    rootEnv.SERVER_PORT ||
      rootEnv.PORT ||
      process.env.SERVER_PORT ||
      process.env.PORT ||
      5174,
  );
  const analyze =
    String(rootEnv.ANALYZE || process.env.ANALYZE || "").toLowerCase() ===
    "true";

  // Identifies this build. The server serves it (build-id.txt) so that a page
  // loaded before an update can tell it is out of date.
  const gitSha = (() => {
    try {
      return execSync("git rev-parse --short HEAD", {
        cwd: import.meta.dirname,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
    } catch {
      return "build";
    }
  })();
  const buildId = `${gitSha}-${Date.now().toString(36)}`;

  return {
    define: { __BUILD_ID__: JSON.stringify(buildId) },
    plugins: [
      react(),
      {
        name: "aurelle-build-id",
        writeBundle(options) {
          const outDir = options.dir || path.resolve(import.meta.dirname, "dist");
          fs.writeFileSync(path.join(outDir, "build-id.txt"), `${buildId}\n`);
        },
      },
      ...(analyze
        ? [
            visualizer({
              filename: "dist/stats.html",
              gzipSize: true,
              brotliSize: true,
              open: false,
            }),
          ]
        : []),
    ],
    envDir: "..",
    envPrefix: ["APP_", "CHAT_", "FILE_", "MESSAGE_", "ACCOUNT_", "SIGN_"],
    build: {
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return;
            if (
              id.includes("/react/") ||
              id.includes("/react-dom/") ||
              id.includes("/scheduler/")
            ) {
              return "react-core";
            }
            if (id.includes("/lucide-react/")) {
              return "icons";
            }
            if (
              id.includes("/marked/") ||
              id.includes("/dompurify/") ||
              id.includes("/highlight.js/")
            ) {
              return "markdown";
            }
            return "vendor";
          },
        },
      },
    },
    server: {
      host: "0.0.0.0",
      port: 5173,
      proxy: {
        "/api": `http://localhost:${apiPort}`,
        "/ws": {
          target: `http://localhost:${apiPort}`,
          ws: true,
        },
      },
    },
  };
});
