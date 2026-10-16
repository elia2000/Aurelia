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
  const emojiImageDir = path.resolve(import.meta.dirname, "node_modules/emoji-datasource-apple/img/apple/64");

  return {
    define: { __BUILD_ID__: JSON.stringify(buildId) },
    plugins: [
      react(),
      {
        // The Apple-style emoji pictures come from the `emoji-datasource-apple`
        // package: served from it while developing, copied into the build.
        name: "aurelle-emoji-images",
        configureServer(server) {
          server.middlewares.use("/emoji/apple/64", (req, res, next) => {
            const name = path.basename(decodeURIComponent(String(req.url || "").split("?")[0]));
            const file = path.join(emojiImageDir, name);
            if (!/^[0-9a-f-]+\.png$/.test(name) || !fs.existsSync(file)) return next();
            res.setHeader("Content-Type", "image/png");
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            fs.createReadStream(file).pipe(res);
          });
        },
        writeBundle(options) {
          if (!fs.existsSync(emojiImageDir)) return; // package missing: emoji fall back to the device's own
          const outDir = path.join(options.dir || path.resolve(import.meta.dirname, "dist"), "emoji/apple/64");
          fs.mkdirSync(outDir, { recursive: true });
          for (const name of fs.readdirSync(emojiImageDir)) {
            if (name.endsWith(".png")) fs.copyFileSync(path.join(emojiImageDir, name), path.join(outDir, name));
          }
        },
      },
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
