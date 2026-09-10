import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { WindowWebSocketClient } from "../../src/lib";
import { delay } from "../support/async";
import { TestEchoServer } from "../support/echo-server";

/**
 * 순수 WebSocket 은 프로토콜 하트비트가 없어서 애플리케이션 메시지로 대신한다.
 * 여기서 보는 것은 그 왕복이 실제로 성립하는지, 그리고 그 메시지가 화면으로 새지 않는지다.
 */

const heartbeat = { intervalMs: 60_000, timeoutMs: 300, ping: "__ping__" };

let server: TestEchoServer;

beforeEach(async () => {
  server = new TestEchoServer();
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

describe("순수 WebSocket 하트비트", () => {
  it("하트비트가 있으면 revalidate 가 진짜 왕복으로 답한다", async () => {
    const client = new WindowWebSocketClient({ url: `${server.url}/?room=a`, heartbeat });
    await client.connect();

    expect(await client.revalidate(1000)).toBe(true);

    client.destroy();
  });

  it("서버가 응답을 멈추면 죽은 것으로 판정한다", async () => {
    const client = new WindowWebSocketClient({ url: `${server.url}/?room=a`, heartbeat });
    await client.connect();
    server.mute();

    expect(await client.revalidate(300)).toBe(false);

    client.destroy();
  });

  it("하트비트가 없으면 소켓이 열려 있는지까지만 본다", async () => {
    const client = new WindowWebSocketClient({ url: `${server.url}/?room=a` });
    await client.connect();
    server.mute(); // 응답이 끊겨도 소켓은 열려 있다

    // 이 한계는 문서에 적힌 그대로다 — half-open 은 잡지 못한다.
    expect(await client.revalidate(300)).toBe(true);

    client.destroy();
  });

  it("하트비트 메시지는 애플리케이션 스트림으로 새지 않는다", async () => {
    const client = new WindowWebSocketClient({ url: `${server.url}/?room=a`, heartbeat });
    const received: string[] = [];
    client.message$.subscribe((message) => received.push(message));
    await client.connect();

    await client.revalidate(1000);
    client.send("사람이 보낸 말");
    await delay(200);

    expect(received).toEqual(["사람이 보낸 말"]);

    client.destroy();
  });
});
