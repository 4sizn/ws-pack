import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 실패를 화면에 남긴다.
 *
 * 기기에서 열었을 때 렌더가 죽으면 남는 건 백지뿐이고, 폰에는 열어 볼 콘솔이 없다.
 * 그래서 잡은 에러를 그대로 그린다 — 개발 도구가 없는 곳에서 원인을 보기 위한 장치다.
 */
let sink: ((message: string, cause?: unknown) => void) | undefined;

/** React 밖(window.onerror 등)에서 잡은 실패도 같은 자리에 보낸다. */
export function showFailure(message: string, cause?: unknown): void {
  if (sink) {
    sink(message, cause);
    return;
  }
  // 아직 마운트 전이라면 최소한 흔적은 남긴다.
  const root = document.getElementById("root");
  if (root && !root.textContent) {
    root.textContent = `${message}\n${describe(cause)}`;
  }
}

interface State {
  message?: string;
  detail?: string;
}

export class ErrorSurface extends Component<{ children: ReactNode }, State> {
  state: State = {};

  componentDidMount(): void {
    sink = (message, cause) => this.setState({ message, detail: describe(cause) });
  }

  componentWillUnmount(): void {
    sink = undefined;
  }

  static getDerivedStateFromError(error: unknown): State {
    return { message: describe(error), detail: stackOf(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.setState({ message: describe(error), detail: info.componentStack ?? stackOf(error) });
  }

  render(): ReactNode {
    if (!this.state.message) {
      return this.props.children;
    }
    return (
      <pre className="failure">
        {this.state.message}
        {"\n\n"}
        {this.state.detail}
      </pre>
    );
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return String(value);
}

function stackOf(value: unknown): string {
  return value instanceof Error ? (value.stack ?? "") : "";
}
