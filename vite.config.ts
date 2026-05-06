import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  root: "client",
  publicDir: "../public",
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: false,
        proxyTimeout: 0,
        timeout: 0
      }
    }
  },
  build: {
    outDir: "../dist/client",
    emptyOutDir: true
  },
  test: {
    root: ".",
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"]
  }
});
