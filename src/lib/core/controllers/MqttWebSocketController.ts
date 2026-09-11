import type { Observable } from "rxjs";
import {
  type MqttMessage,
  type MqttSendOptions,
  type MqttSubscribeOptions,
  MqttWebSocketClientAdapter,
  type MqttWebSocketClientOptions,
} from "../adapters/MqttWebSocketClientAdapter";
import type { PubSubAble } from "../PubSubAble";
import { WebSocketController } from "./NetworkController";

export class MqttWebSocketController
  extends WebSocketController<MqttMessage, MqttSendOptions, MqttWebSocketClientAdapter>
  implements PubSubAble<MqttMessage, MqttSubscribeOptions>
{
  public readonly name = "MqttWebSocketController";

  constructor(private readonly options: MqttWebSocketClientOptions) {
    super(options.reconnect);
    for (const plugin of options.plugins ?? []) {
      this.addPlugin(plugin);
    }
  }

  protected createAdapter(): MqttWebSocketClientAdapter {
    return new MqttWebSocketClientAdapter(this.options);
  }

  /**
   * topic 필터 구독. connect() 전에 불러도 되고(연결되면 걸림), 재연결되면 자동으로 다시 걸린다.
   * 반환 Observable 을 unsubscribe 하면 브로커 구독도 해제된다.
   */
  public subscribe(filter: string, options?: MqttSubscribeOptions): Observable<MqttMessage> {
    return this.ensureAdapter().subscribe(filter, options);
  }
}
