import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base: the app routes by hash, so the build can be served from any path.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { target: "es2022", chunkSizeWarningLimit: 900 },
  preview: { port: 4173, strictPort: true },
});
