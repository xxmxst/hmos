import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: ".",
  resolve: {
    alias: {
      stream: "stream-browserify",
      events: "events",
      buffer: "buffer",
      process: "process/browser"
    }
  },
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "index.html")
    }
  }
});
