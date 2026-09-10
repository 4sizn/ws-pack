import type { Subscription } from "rxjs";
import type { ReconnectInfo } from "../../lib";
import { ConnectionState } from "../../lib";
import type { ChatMessage, ChatUser } from "../types";
import { buildPayload, toChatMessage } from "./roomMessage";
import { createRoomTransport, type Protocol, type RoomTransport } from "./roomTransport";

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
  /** 방 이름. 프로토콜이 이걸 destination 이나 접속 URL 로 바꾼다. */
  room: string;
  protocol: Protocol;
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
 * 방 하나의 세션. 클라이언트 인스턴스와 그 구독을 여기서만 들고 있고, 프로토콜 차이는
 * RoomTransport 가 흡수한다 — 이 클래스는 STOMP 인지 순수 WebSocket 인지 모른다.
 *
 * React 와 분리된 평범한 클래스다. 밖으로는 (subscribe, getSnapshot) 만 열어두고,
 * 클라이언트 인스턴스 자체는 절대 내보내지 않는다 — 렌더 트리가 인스턴스를 직접 만지지 못하게 한다.
 */
export class RoomSession {
  /** 이 인스턴스가 보낸 메시지를 에코에서 구분하는 식별자. 인스턴스마다 다르다. */
  readonly clientId = crypto.randomUUID();
  /** 화면에 보여줄 실제 접속 대상 (destination 또는 URL) */
  readonly address: string;

  readonly #roomId: string;
  readonly #me: ChatUser;
  readonly #transport: RoomTransport;
  readonly #subscriptions: Subscription[] = [];
  readonly #listeners = new Set<(snapshot: RoomSnapshot) => void>();

  #snapshot: RoomSnapshot;
  #disposed = false;

  constructor(config: RoomSessionConfig) {
    this.#roomId = config.roomId;
    this.#me = config.me;
    this.#transport = createRoomTransport(config.protocol, config.room);
    this.address = this.#transport.address;
    this.#snapshot = idleSnapshot(config.seed);

    this.#subscriptions.push(
      this.#transport.connectionChanges$.subscribe((connection) => {
        this.#patch(
          connection === ConnectionState.OPEN ? { connection, lastError: null } : { connection },
        );
      }),
      this.#transport.reconnectAttempt$.subscribe((reconnect) => this.#patch({ reconnect })),
      this.#transport.error$.subscribe((error) => this.#patch({ lastError: error.message })),
      // 예기치 않게 끊긴 경우엔 close code/reason 을 그대로 보여준다 (1006 = 비정상 종료 등).
      this.#transport.disconnect$.subscribe((info) => {
        if (info.manual) return;
        const reason = info.reason ? `, ${info.reason}` : "";
        this.#patch({ lastError: `연결 끊김 (code=${info.code ?? "unknown"}${reason})` });
      }),
      // 연결 전에 걸어둔다. STOMP 는 어댑터가 기억했다가 재연결마다 구독을 다시 건다.
      this.#transport.messages().subscribe((body) => {
        const message = toChatMessage(body, this.#roomId, this.clientId);
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
    this.#transport.connect().catch(() => {});
  }

  public disconnect(): void {
    if (this.#disposed) return;
    void this.#transport.disconnect();
  }

  public send(text: string): void {
    if (this.#disposed) return;
    try {
      this.#transport.say(JSON.stringify(buildPayload(this.clientId, this.#me, text)));
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
    void this.#transport.disconnect();
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
