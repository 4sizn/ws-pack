import type { Observable } from "rxjs";
import type {
  MqttMessage,
  MqttSendOptions,
  MqttSubscribeOptions,
  MqttWebSocketClientOptions,
} from "./adapters/MqttWebSocketClientAdapter";
import { MqttWebSocketController } from "./controllers/MqttWebSocketController";
import type { PubSubAble } from "./PubSubAble";
import { WebSocketClient } from "./WebSocketClient";

export class MqttWebSocketClient
  extends WebSocketClient<MqttMessage, MqttSendOptions, MqttWebSocketController>
  implements PubSubAble<MqttMessage, MqttSubscribeOptions>
{
  constructor(options: MqttWebSocketClientOptions) {
    super(new MqttWebSocketController(options));
  }

  /**
   * MQTT topic 필터 구독. connect() 전에 불러도 되고, 재연결되면 자동으로 다시 걸린다.
   * 반환 Observable 을 unsubscribe 하면 브로커 구독도 해제된다.
   */
  public subscribe(filter: string, options?: MqttSubscribeOptions): Observable<MqttMessage> {
    return this.controller.subscribe(filter, options);
  }
}
