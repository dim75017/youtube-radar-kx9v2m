import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(new URL("../public", import.meta.url)),
  base: "/lofi-social-radar-preview/",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("..", import.meta.url)),
    },
  },
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../work/pages-dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
