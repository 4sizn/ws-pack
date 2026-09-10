import type { Subscription } from "rxjs";
import type { ReconnectInfo, StompWebSocketClient } from "../../lib";
import { ConnectionState } from "../../lib";
import type { ChatMessage, ChatUser } from "../types";
import { buildPayload, createRoomClient, toChatMessage } from "./roomClient";

/** React 가 읽는 값. 전부 불변 — 렌더는 이 스냅샷만 보고, 클라이언트 인스턴스는 보지 않는다. */
export interface RoomSnapshot {
  connection: ConnectionState;
  reconnect: ReconnectInfo;
  messages: ChatMessage[];
  /** 마지막 에러 메시지. 연결/전송에 성공하면 지워진다. */
  lastError: string | null;
}

export interface RoomSessionConfig {
  roomId: string;
  destination: string;
  me: ChatUser;
  /** 화면 초기 표시용 과거 메시지 */
  seed: ChatMessage[];
}

const idleReconnect: ReconnectInfo = { attempts: 0, maxAttempts: 0, isReconnecting: false };

export function idleSnapshot(seed: ChatMessage[]): RoomSnapshot {
  return {
    connection: ConnectionState.IDLE,
    reconnect: idleReconnect,
    messages: seed,
    lastError: null,
  };
}

/**
 * 방 하나의 STOMP 세션. StompWebSocketClient 인스턴스와 그 구독을 여기서만 들고 있다.
 *
 * React 와 분리된 평범한 클래스다. 밖으로는 (subscribe, getSnapshot) 만 열어두고,
 * 클라이언트 인스턴스 자체는 절대 내보내지 않는다 — 렌더 트리가 인스턴스를 직접 만지지 못하게 한다.
 */
export class RoomSession {
  /** 이 인스턴스가 보낸 메시지를 에코에서 구분하는 식별자. 인스턴스마다 다르다. */
  readonly clientId = crypto.randomUUID();
  readonly destination: string;

  readonly #roomId: string;
  readonly #me: ChatUser;
  readonly #client: StompWebSocketClient;
  readonly #subscriptions: Subscription[] = [];
  readonly #listeners = new Set<(snapshot: RoomSnapshot) => void>();

  #snapshot: RoomSnapshot;
  #disposed = false;

  constructor(config: RoomSessionConfig) {
    this.#roomId = config.roomId;
    this.#me = config.me;
    this.destination = config.destination;
    this.#snapshot = idleSnapshot(config.seed);
    this.#client = createRoomClient();

    this.#subscriptions.push(
      this.#client.connectionChanges$.subscribe((connection) => {
        this.#patch(
          connection === ConnectionState.OPEN ? { connection, lastError: null } : { connection },
        );
      }),
      this.#client.reconnectAttempt$.subscribe((reconnect) => this.#patch({ reconnect })),
      this.#client.error$.subscribe((error) => this.#patch({ lastError: error.message })),
      // 예기치 않게 끊긴 경우엔 close code/reason 을 그대로 보여준다 (1006 = 비정상 종료 등).
      this.#client.disconnect$.subscribe((info) => {
        if (info.manual) return;
        const reason = info.reason ? `, ${info.reason}` : "";
        this.#patch({ lastError: `연결 끊김 (code=${info.code ?? "unknown"}${reason})` });
      }),
      // 연결 전에 걸어둔다. 어댑터가 기억했다가 CONNECTED 및 재연결마다 다시 건다.
      this.#client.subscribe(this.destination).subscribe((frame) => {
        const message = toChatMessage(frame, this.#roomId, this.clientId);
        this.#patch({ messages: [...this.#snapshot.messages, message] });
      }),
    );
  }

  /** 연결 시작. 실패 원인은 error$ 를 통해 스냅샷의 lastError 로 이미 들어간다. */
  public start(): void {
    this.connect();
  }

  public connect(): void {
    if (this.#disposed) return;
    this.#client.connect().catch(() => {});
  }

  public disconnect(): void {
    if (this.#disposed) return;
    void this.#client.disconnect();
  }

  public send(text: string): void {
    if (this.#disposed) return;
    try {
      this.#client.send(JSON.stringify(buildPayload(this.clientId, this.#me, text)), {
        destination: this.destination,
      });
      this.#patch({ lastError: null });
    } catch (error) {
      this.#patch({ lastError: (error as Error).message });
    }
  }

  /** 세션 폐기. 구독을 끊고 소켓을 닫는다. 폐기한 세션은 재사용하지 않는다. */
  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const subscription of this.#subscriptions) {
      subscription.unsubscribe();
    }
    this.#listeners.clear();
    void this.#client.disconnect();
  }

  public getSnapshot = (): RoomSnapshot => this.#snapshot;

  public subscribe = (listener: (snapshot: RoomSnapshot) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #patch(partial: Partial<RoomSnapshot>): void {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...partial };
    for (const listener of this.#listeners) {
      listener(this.#snapshot);
    }
  }
}
