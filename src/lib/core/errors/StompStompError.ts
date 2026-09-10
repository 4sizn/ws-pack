import type { IFrame } from "@stomp/stompjs";

/**
 * @description StompConfig.onStompError 에러
 */
export class StompStompError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;
  public readonly frame: IFrame;
  public readonly details?: unknown;

  constructor(message: string, frame: IFrame, details?: unknown) {
    super(message);
    this.name = "StompStompError";
    this.code = "STOMP_STOMP_ERROR";
    this.timestamp = new Date();
    this.frame = frame;
    this.details = details;
  }
}
