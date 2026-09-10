import type { Observable, Subscription } from "rxjs";

/** 구독해서 받은 메시지를 순서대로 쌓아두는 수신함. 테스트는 이걸 들여다본다. */
export interface Inbox {
  readonly messages: string[];
  close(): void;
}

export function inbox(source: Observable<string>): Inbox {
  const messages: string[] = [];
  const subscription: Subscription = source.subscribe((message) => messages.push(message));
  return {
    messages,
    close: () => subscription.unsubscribe(),
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 조건이 참이 될 때까지 짧게 폴링한다. 고정 sleep 은 느리거나 불안정하다.
 * 제한 시간을 넘기면 label 을 담아 실패시킨다.
 */
export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`timeout ${timeoutMs}ms: ${label}`);
}

/** 제한 시간 안에 promise 가 끝나는지 확인한다. 끝나지 않으면 실패. */
export async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${timeoutMs}ms: ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
