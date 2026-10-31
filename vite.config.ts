import { defineConfig } from "vite";

// Static, frontend-only build. No plugins needed: Vite handles TypeScript,
// CSS, and Web Workers natively.
export default defineConfig({
  base: "./",
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
  build: {
    target: "es2022",
    sourcemap: false,
    // three.js is large by itself; keep it in its own cacheable chunk.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
        },
      },
    },
  },
});
