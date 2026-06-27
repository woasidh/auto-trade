import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://localhost:30001";

export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      "Cache-Control": "no-store"
    },
    proxy: {
      "/api": apiProxyTarget
    }
  }
});
