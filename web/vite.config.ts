import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  server: {
    port: 5173,
    // The repo lives on a Windows mount where file-change events don't arrive
    watch: { usePolling: true, interval: 300 },
    proxy: { "/api": "http://localhost:8050" },
  },
});
