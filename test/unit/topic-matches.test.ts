import { describe, expect, it } from "bun:test";
import { topicMatches } from "../../src/lib/core/adapters/MqttWebSocketClientAdapter";

describe("MQTT topic 필터 매칭", () => {
  it("정확히 같은 topic 만 통과시킨다", () => {
    expect(topicMatches("chat/room", "chat/room")).toBe(true);
    expect(topicMatches("chat/room", "chat/other")).toBe(false);
    expect(topicMatches("chat/room", "chat/room/extra")).toBe(false);
    expect(topicMatches("chat/room", "chat")).toBe(false);
  });

  it("+ 는 정확히 한 레벨을 대신한다", () => {
    expect(topicMatches("chat/+", "chat/room")).toBe(true);
    expect(topicMatches("chat/+/msg", "chat/room/msg")).toBe(true);
    expect(topicMatches("chat/+", "chat/room/msg")).toBe(false);
    expect(topicMatches("chat/+", "chat")).toBe(false);
  });

  it("# 는 남은 레벨 전부를 대신한다", () => {
    expect(topicMatches("chat/#", "chat/room")).toBe(true);
    expect(topicMatches("chat/#", "chat/room/msg/deep")).toBe(true);
    expect(topicMatches("#", "anything/at/all")).toBe(true);
    expect(topicMatches("chat/#", "other/room")).toBe(false);
  });
});
