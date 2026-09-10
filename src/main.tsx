import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { DemoApp } from "./demo/DemoApp"
import "./demo/styles/global.css"

const container = document.getElementById("root")
if (!container) {
  throw new Error("#root element not found in index.html")
}

createRoot(container).render(
  <StrictMode>
    <DemoApp />
  </StrictMode>,
)
