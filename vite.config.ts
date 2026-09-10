import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // 데모는 dist/demo 로 뺀다. 라이브러리 산출물(dist/lib, dist/types)과 서로 지우지 않게.
  build: { outDir: "dist/demo" },
});
