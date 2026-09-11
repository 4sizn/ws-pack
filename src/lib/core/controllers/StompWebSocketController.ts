import type { IMessage, StompHeaders } from "@stomp/stompjs";
import type { Observable } from "rxjs";
import {
  type StompSendOptions,
  StompWebSocketClientAdapter,
  type StompWebSocketClientOptions,
} from "../adapters/StompWebSocketClientAdapter";
import type { PubSubAble } from "../PubSubAble";
import { WebSocketController } from "./NetworkController";

export class StompWebSocketController
  extends WebSocketController<IMessage, StompSendOptions, StompWebSocketClientAdapter>
  implements PubSubAble<IMessage, StompHeaders>
{
  public readonly name = "StompWebSocketController";

  constructor(private readonly options: StompWebSocketClientOptions) {
    super(options.reconnect);
    for (const plugin of options.plugins ?? []) {
      this.addPlugin(plugin);
    }
  }

  protected createAdapter(): StompWebSocketClientAdapter {
    return new StompWebSocketClientAdapter(this.options);
  }

  /**
   * STOMP destination 구독. connect() 전에 불러도 되고(연결되면 걸림), 재연결되면 자동으로 다시 걸린다.
   * 반환 Observable 을 unsubscribe 하면 STOMP 구독도 해제된다.
   */
  public subscribe(destination: string, headers?: StompHeaders): Observable<IMessage> {
    return this.ensureAdapter().subscribe(destination, headers);
  }
}
