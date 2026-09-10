import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // host: true 로 LAN 에 노출한다 — 폰 같은 다른 기기에서 열어 확인하기 위해.
  server: { port: 5173, host: true },
  // 데모는 dist/demo 로 뺀다. 라이브러리 산출물(dist/lib, dist/types)과 서로 지우지 않게.
  build: { outDir: "dist/demo" },
});
