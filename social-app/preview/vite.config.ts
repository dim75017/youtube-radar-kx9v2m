import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const publicBase = process.env.LOFI_SOCIAL_BASE_PATH ?? "/youtube-radar-kx9v2m/social/";
const outputDirectory = process.env.LOFI_SOCIAL_OUT_DIR
  ? resolve(projectRoot, process.env.LOFI_SOCIAL_OUT_DIR)
  : fileURLToPath(new URL("../work/pages-dist", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(new URL("../public", import.meta.url)),
  base: publicBase,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("..", import.meta.url)),
    },
  },
  plugins: [react()],
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
    sourcemap: false,
  },
});
