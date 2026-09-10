import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * 라이브러리 빌드. 데모(vite.config.ts)와 분리해 둔다 — 데모는 앱이고 이건 패키지다.
 *
 * 진입점이 둘이다:
 * - index: 소비자가 import 하는 공개 API
 * - worker: 워커 스크립트. import 만 해도 허브가 뜨는 부수 효과 진입점이라 따로 낸다.
 *
 * 런타임 의존성은 번들에 넣지 않는다. 소비자 쪽 rxjs 와 인스턴스가 갈리면
 * 같은 Observable 을 두 구현이 오가게 되고, 중복 번들도 그대로 비용이 된다.
 */
export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(import.meta.dirname, "src/lib/index.ts"),
        worker: resolve(import.meta.dirname, "src/lib/worker/socket-worker.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: ["rxjs", /^rxjs\//, "@stomp/stompjs", "mqtt"],
    },
    outDir: "dist/lib",
    emptyOutDir: true,
    target: "es2022",
  },
});
