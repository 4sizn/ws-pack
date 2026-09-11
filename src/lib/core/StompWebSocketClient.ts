import type { IMessage, StompHeaders } from "@stomp/stompjs";
import type { Observable } from "rxjs";
import type {
  StompSendOptions,
  StompWebSocketClientOptions,
} from "./adapters/StompWebSocketClientAdapter";
import { StompWebSocketController } from "./controllers/StompWebSocketController";
import type { PubSubAble } from "./PubSubAble";
import { WebSocketClient } from "./WebSocketClient";

export class StompWebSocketClient
  extends WebSocketClient<IMessage, StompSendOptions, StompWebSocketController>
  implements PubSubAble<IMessage, StompHeaders>
{
  constructor(options: StompWebSocketClientOptions) {
    super(new StompWebSocketController(options));
  }

  /**
   * STOMP destination 구독. connect() 전에 불러도 되고, 재연결되면 자동으로 다시 걸린다.
   * 반환 Observable 을 unsubscribe 하면 STOMP 구독도 해제된다.
   */
  public subscribe(destination: string, headers?: StompHeaders): Observable<IMessage> {
    return this.controller.subscribe(destination, headers);
  }
}
