import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/gemini": {
        target: "https://generativelanguage.googleapis.com",
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.replace(/^\/api\/gemini/, ""),
      },
      "/api/actions": {
        target: process.env.VITE_ACTION_API_URL || process.env.VITE_MCP_SERVER_URL || "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});

