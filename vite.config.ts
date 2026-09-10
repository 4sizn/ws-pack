import { appendFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * 기기 점검 결과 수집기.
 *
 * 폰 화면은 개발 머신에서 볼 수 없다. 그래서 device-check 페이지가 결과를 여기로 보내고,
 * 서버가 터미널과 `.proof/device-reports.log` 에 남긴다 — 기기에서 URL 하나만 열면 된다.
 */
function deviceReports(): Plugin {
  return {
    name: "ws-pack-device-reports",
    configureServer(server) {
      server.middlewares.use("/device-report", (request, response) => {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end();
          return;
        }
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          const line = `[${new Date().toISOString()}] ${request.headers["user-agent"] ?? ""}\n${body}\n`;
          console.log(`\n=== 기기 점검 결과 ===\n${line}`);
          try {
            appendFileSync(".proof/device-reports.log", line);
          } catch {
            // .proof 가 없으면 콘솔 기록만으로 충분하다
          }
          response.statusCode = 204;
          response.end();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), deviceReports()],
  // host: true 로 LAN 에 노출한다 — 폰 같은 다른 기기에서 열어 확인하기 위해.
  server: { port: 5173, host: true },
  // 데모는 dist/demo 로 뺀다. 라이브러리 산출물(dist/lib, dist/types)과 서로 지우지 않게.
  build: { outDir: "dist/demo" },
});
