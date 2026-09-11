// 기본 import 만 쓴다: mqtt 의 브라우저 번들(dist/mqtt.esm.js)은 default 하나만 내보내서
// `import { connect }` 는 Node 에서만 되고 브라우저에서는 모듈 로드 자체가 깨진다.
import mqttPackage, {
  type IClientOptions,
  type IClientPublishOptions,
  type IClientSubscribeOptions,
  type IPublishPacket,
  type MqttClient,
} from "mqtt";
import { Observable, type Subscriber } from "rxjs";
import { abortReason, onAbort, type Resolvable, resolveWithSignal, toError } from "../abort";
import type { SocketCloseInfo } from "../CloseInfo";
import { MqttWebsocketError } from "../errors/MqttWebsocketError";
import type { PubSubAble } from "../PubSubAble";
import type { AbstractPlugin, Logger } from "../plugins/AbstractPlugin";
import type { ReconnectConfig } from "../Reconnect";
import { WebSocketClientAdapter } from "./WebSocketClientAdapter";

/**
 * 어댑터가 직접 다루는 MQTT.js 필드.
 * reconnectPeriod/manualConnect 는 어댑터가 강제하고,
 * brokerURL/username/password 는 시도마다 다시 받을 수 있도록 Resolvable 로 재선언한다.
 */
type ManagedClientOptionKeys =
  | "reconnectPeriod"
  | "manualConnect"
  | "brokerURL"
  | "username"
  | "password";

/**
 * MQTT 어댑터 옵션.
 *
 * **keepalive 는 기본으로 켜져 있다.** mqtt.js 기본값은 60초이고, 그 동안 오간 것이 없으면
 * PINGREQ 를 보내 PINGRESP 를 기다린다. 응답이 없으면 연결을 닫고, 그 close 가 이 어댑터를 거쳐
 * Controller 의 재연결로 이어진다 — 죽은 연결을 알아채는 보편적인 경로가 이것이다.
 *
 * 모바일처럼 빨리 알아야 하는 곳에서는 `keepalive` 를 줄인다(초 단위, 0 이면 끔).
 * revalidate() 는 그 간격을 기다리지 않고 지금 당장 확인하고 싶을 때 쓰는 별개 수단이다.
 */
export interface MqttWebSocketClientOptions extends Omit<IClientOptions, ManagedClientOptionKeys> {
  /** 브로커 URL (`ws://` 또는 `wss://`) */
  brokerURL: Resolvable<string>;
  /** MQTT 인증 사용자명 */
  username?: Resolvable<NonNullable<IClientOptions["username"]>>;
  /** MQTT 인증 비밀번호 */
  password?: Resolvable<NonNullable<IClientOptions["password"]>>;
  /** 이미 만들어진 MQTT.js 클라이언트를 주입. 없으면 어댑터가 내부에서 기본 생성한다. */
  client?: MqttClient;
  /** 재연결 정책 (Controller가 소비) */
  reconnect?: ReconnectConfig;
  logger?: Logger;
  plugins?: AbstractPlugin[];
}

/** send(payload, options) 의 options. topic 은 필수다 — MQTT 는 목적지 없이 발행할 수 없다. */
export interface MqttSendOptions extends IClientPublishOptions {
  topic: string;
}

/** 구독 옵션 (qos 등). */
export type MqttSubscribeOptions = IClientSubscribeOptions;

/** 수신 메시지. body 는 payload 를 UTF-8 로 디코드한 것 — STOMP 의 IMessage.body 와 같은 자리다. */
export interface MqttMessage {
  topic: string;
  body: string;
  packet: IPublishPacket;
}

interface SubscriptionRecord {
  /** 구독 필터. `+`, `#` 와일드카드를 포함할 수 있다. */
  filter: string;
  options?: MqttSubscribeOptions;
  observer: Subscriber<MqttMessage>;
  /** 현재 연결에 실제로 구독이 걸려 있는지. 재연결하면 다시 건다. */
  attached: boolean;
}

/**
 * MQTT.js 를 감싸는 어댑터. mqtt 타입이 등장하는 유일한 어댑터 파일.
 *
 * connect(signal) 은 "한 번" 시도한다: CONNACK 이면 resolve, 그 전에 error/close 가 오면 reject.
 * 재시도는 Controller 가 한다.
 *
 * 이 연결의 수명은 `signal` 이 정한다. abort 되면 — 시도 중이든 이미 연결됐든 — 소켓을 놓는다.
 * STOMP·WebSocket 어댑터와 같은 규칙이라 세 프로토콜의 수명 관리가 한 가지 방식으로 통일된다.
 *
 * subscribe(filter) 로 만든 구독은 어댑터가 기억해서, 재연결 후 CONNACK 이 오면 자동으로 다시 건다.
 */
export class MqttWebSocketClientAdapter
  extends WebSocketClientAdapter<
    MqttClient,
    MqttWebSocketClientOptions,
    MqttMessage,
    MqttSendOptions
  >
  implements PubSubAble<MqttMessage, MqttSubscribeOptions>
{
  readonly #options: MqttWebSocketClientOptions;

  readonly #connectCallbacks = new Set<() => void>();
  readonly #messageCallbacks = new Set<(message: MqttMessage) => void>();
  readonly #errorCallbacks = new Set<(error: Error) => void>();
  readonly #closeCallbacks = new Set<(info: SocketCloseInfo) => void>();

  readonly #subscriptions = new Set<SubscriptionRecord>();

  constructor(options: MqttWebSocketClientOptions) {
    super();
    this.#options = options;
  }

  public async connect(signal: AbortSignal): Promise<void> {
    const {
      client,
      brokerURL: _brokerURL,
      username: _username,
      password: _password,
      reconnect: _reconnect,
      logger: _logger,
      plugins: _plugins,
      ...clientOptions
    } = this.#options;

    // 이전 시도가 남긴 연결을 먼저 놓는다 (연결 누수 방지).
    await this.disconnect();

    let instance: MqttClient;
    if (client) {
      instance = client;
    } else {
      let brokerURL: string;
      let username: NonNullable<IClientOptions["username"]> | undefined;
      let password: NonNullable<IClientOptions["password"]> | undefined;
      try {
        const resolvedBrokerURL = resolveWithSignal(this.#options.brokerURL, signal);
        const resolvedUsername = this.#options.username
          ? resolveWithSignal(this.#options.username, signal)
          : Promise.resolve(undefined);
        const resolvedPassword = this.#options.password
          ? resolveWithSignal(this.#options.password, signal)
          : Promise.resolve(undefined);

        [brokerURL, username, password] = await Promise.all([
          resolvedBrokerURL,
          resolvedUsername,
          resolvedPassword,
        ]);
      } catch (error) {
        if (!signal.aborted) {
          for (const cb of this.#errorCallbacks) cb(toError(error));
        }
        throw error;
      }

      instance = mqttPackage.connect(brokerURL, {
        // 브라우저용 라이브러리다. Node/Bun 에서도 같은 전송(네이티브 WebSocket)을 쓰게 해서
        // 실행 환경마다 동작이 갈리지 않게 한다. 필요하면 사용자가 false 로 덮을 수 있다.
        forceNativeWebSocket: true,
        ...clientOptions,
        ...(username === undefined ? {} : { username }),
        ...(password === undefined ? {} : { password }),
        // mqtt.js 자체 재연결 비활성화 — Controller 가 ReconnectConfig 로 재시도한다.
        reconnectPeriod: 0,
      });
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      // 취소된 시도의 콜백은 흘리지 않는다. 판단 기준은 신호 하나뿐이다.
      const live = () => !signal.aborted;

      this.client = instance;

      instance.on("connect", () => {
        if (!live()) return;
        // 재연결이면 살아 있는 구독을 새 연결에 다시 건다
        for (const record of this.#subscriptions) {
          this.#attach(record);
        }
        settle(resolve);
        for (const cb of this.#connectCallbacks) cb();
      });

      instance.on("message", (topic, payload, packet) => {
        if (!live()) return;
        const message: MqttMessage = {
          topic,
          body: payload.toString(),
          packet: packet as IPublishPacket,
        };
        for (const record of this.#subscriptions) {
          if (record.attached && topicMatches(record.filter, topic)) {
            record.observer.next(message);
          }
        }
        for (const cb of this.#messageCallbacks) cb(message);
      });

      instance.on("error", (error: Error) => {
        if (!live()) return;
        const wrapped = new MqttWebsocketError(error.message, error);
        for (const cb of this.#errorCallbacks) cb(wrapped);
        settle(() => reject(wrapped));
      });

      // 연결이 닫히는 모든 경우에 온다. 수동/비수동 판단은 Controller 상태로.
      instance.on("close", () => {
        if (!live()) return;
        settle(() => reject(new Error("MQTT connection closed before CONNACK")));
        // MQTT 는 close code 가 없다. 닫혔다는 사실만 전한다.
        for (const cb of this.#closeCallbacks) cb({ reason: "mqtt connection closed" });
      });

      // 연결의 수명 = signal 의 수명. 이미 취소됐다면 그대로 접는다.
      onAbort(signal, () => {
        settle(() => reject(abortReason(signal)));
        void this.#release(instance);
      });
    });
  }

  /**
   * 연결 종료. 소유권을 먼저 놓고, 정리는 로컬에서 끝낸다. 이미 놓았으면 아무 일도 하지 않는다.
   */
  public async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    await this.#release(client);
  }

  /**
   * 연결 반납. STOMP 어댑터와 같은 두 단계다.
   *
   * 1. 우아한 종료 시도: `endAsync(false)` 는 DISCONNECT 패킷을 보내고 전송 버퍼가 비길 기다린다.
   *    그 완료는 상대에게 달렸으므로 **await 하지 않는다.**
   * 2. 로컬 폐기: `endAsync(true)` 는 스트림을 즉시 끊는다. 상대와 무관하게 유한 시간에 끝나므로
   *    이 단계의 완료를 "끊겼다" 의 기준으로 삼는다.
   */
  async #release(client: MqttClient): Promise<void> {
    if (this.client === client) {
      this.client = undefined;
    }
    for (const record of this.#subscriptions) {
      record.attached = false;
    }
    void client.endAsync(false).catch(() => {});
    await client.endAsync(true).catch(() => {});

    // 스트림까지 확실히 끊는다. 상대가 응답을 멈춘 채 소켓만 살아 있는 경우(half-open),
    // mqtt.js 의 강제 종료가 전송 버퍼를 비우지 못해 옛 연결이 남는다 — 그러면 재연결 뒤
    // 브로커에 구독이 둘이 되어 같은 메시지가 두 번 배달된다.
    const stream = (client as { stream?: { destroy?: () => void } }).stream;
    stream?.destroy?.();
  }

  /**
   * topic 으로 발행. Controller 가 OPEN 인지 먼저 확인하지만, 어댑터 단에서도 방어한다.
   */
  public send(payload: string, options: MqttSendOptions): void {
    if (!this.client?.connected) {
      throw new Error("MQTT client is not connected");
    }
    const { topic, ...publishOptions } = options;
    this.client.publish(topic, payload, publishOptions);
  }

  /**
   * topic 필터 구독. 아직 연결 전이면 CONNACK 시점에 걸리고, 재연결되면 자동으로 다시 걸린다.
   * 반환 Observable 을 unsubscribe 하면 브로커 구독도 해제된다.
   *
   * 필터에 `+`/`#` 와일드카드를 쓸 수 있고, 도착한 메시지는 필터와 맞는 구독에만 흘린다.
   */
  public subscribe(filter: string, options?: MqttSubscribeOptions): Observable<MqttMessage> {
    return new Observable<MqttMessage>((observer) => {
      const record: SubscriptionRecord = { filter, options, observer, attached: false };
      this.#subscriptions.add(record);

      if (this.client?.connected) {
        this.#attach(record);
      }

      return () => {
        this.#subscriptions.delete(record);
        record.attached = false;
        // 같은 필터를 보는 다른 구독이 남아 있으면 브로커 구독은 유지해야 한다.
        const stillWanted = [...this.#subscriptions].some((other) => other.filter === filter);
        if (!stillWanted && this.client?.connected) {
          this.client.unsubscribe(filter);
        }
      };
    });
  }

  #attach(record: SubscriptionRecord): void {
    if (!this.client?.connected) return;
    if (record.options) {
      this.client.subscribe(record.filter, record.options);
    } else {
      this.client.subscribe(record.filter);
    }
    record.attached = true;
  }

  public onConnect(callback: () => void): void {
    this.#connectCallbacks.add(callback);
  }

  public onMessage(callback: (message: MqttMessage) => void): void {
    this.#messageCallbacks.add(callback);
  }

  public onError(callback: (error: Error) => void): void {
    this.#errorCallbacks.add(callback);
  }

  public onClose(callback: (info: SocketCloseInfo) => void): void {
    this.#closeCallbacks.add(callback);
  }

  /**
   * QoS 1 발행의 PUBACK 왕복으로 확인한다. 브로커가 받았다는 응답이 와야만 성립하므로
   * 소켓이 살아 있고 상대가 응답한다는 증거가 된다.
   *
   * 토픽은 이 클라이언트 전용 이름을 쓰고 아무도 구독하지 않는다 — 확인 때문에 남에게
   * 메시지가 가면 안 된다. 응답이 신호 기한 안에 오지 않으면 죽은 것으로 본다.
   */
  public async revalidate(signal: AbortSignal): Promise<boolean> {
    const client = this.client;
    if (!client?.connected) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (alive: boolean) => {
        if (settled) return;
        settled = true;
        resolve(alive);
      };

      onAbort(signal, () => settle(false));
      client.publish(
        `revalidate/${client.options.clientId}`,
        "",
        { qos: 1, retain: false },
        (error) => settle(!error),
      );
    });
  }

  /** MQTT.js 는 readyState 를 노출하지 않는다. 연결 여부만 브라우저 readyState 값으로 옮겨 준다. */
  public networkStatus(): number {
    return this.client?.connected ? 1 : 3;
  }
}

/**
 * MQTT topic 필터 매칭. `+` 는 한 레벨, `#` 는 나머지 전부.
 * 브로커도 같은 규칙으로 배달하지만, 한 연결에 여러 구독이 걸리면 어느 구독에 줄지는
 * 어댑터가 정해야 한다 — MQTT.js 의 message 이벤트는 구독 식별자를 주지 않기 때문이다.
 */
export function topicMatches(filter: string, topic: string): boolean {
  const filterParts = filter.split("/");
  const topicParts = topic.split("/");

  for (let index = 0; index < filterParts.length; index++) {
    const part = filterParts[index];
    if (part === "#") {
      return true;
    }
    if (index >= topicParts.length) {
      return false;
    }
    if (part !== "+" && part !== topicParts[index]) {
      return false;
    }
  }

  return filterParts.length === topicParts.length;
}
