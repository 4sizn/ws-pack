import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorSurface, showFailure } from "./demo/components/ErrorSurface";
import { DemoApp } from "./demo/DemoApp";
import "./demo/styles/global.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found in index.html");
}

// 폰에는 콘솔이 없다. 화면에 띄우지 않으면 백지만 남고 이유는 사라진다.
window.addEventListener("error", (event) => showFailure(event.message, event.error));
window.addEventListener("unhandledrejection", (event) =>
  showFailure("처리되지 않은 거부", event.reason),
);

createRoot(container).render(
  <StrictMode>
    <ErrorSurface>
      <DemoApp />
    </ErrorSurface>
  </StrictMode>,
);
