import type { AlertStatusRecord } from "../src/core/status";
import {
  NostrStatusMirror,
  STATUS_EVENT_KIND,
  STATUS_LABEL_NAMESPACE,
  STATUS_SCHEMA,
  toPublicStatus,
} from "../src/store/relay-mirror";

const record = (over: Partial<AlertStatusRecord> = {}): AlertStatusRecord => ({
  key: "weather:130010:03",
  category: "weather",
  kind: "forecast",
  severity: "warning",
  status: "active",
  publishedAt: "2026-08-11T10:00:00+09:00",
  updatedAt: "2026-08-11T10:00:00+09:00",
  expiresAt: null,
  serial: null,
  headline: "東京地方に大雨警報",
  area: { name: "東京地方", code: "130010" },
  areaType: "一次細分区域",
  detail: { kind: "大雨警報", attention: "土砂災害注意" },
  posts: { nostr: { root: "internal-root", parent: "internal-parent" } },
  deliveries: { eew: { concrnt: { root: "internal" } } },
  lastPostText: "前回の投稿文",
  revision: 12,
  ...over,
});

describe("toPublicStatus", () => {
  it("公開スキーマの形になる", () => {
    expect(toPublicStatus(record())).toEqual({
      schema: STATUS_SCHEMA,
      key: "weather:130010:03",
      hazard: "weather",
      kind: "forecast",
      severity: "warning",
      status: "active",
      headline: "東京地方に大雨警報",
      publishedAt: "2026-08-11T10:00:00+09:00",
      updatedAt: "2026-08-11T10:00:00+09:00",
      expiresAt: null,
      area: { name: "東京地方", code: "130010", type: "一次細分区域" },
      detail: { kind: "大雨警報", attention: "土砂災害注意" },
    });
  });

  // 配信管理用の内部状態は外部への契約に含めない
  it("内部フィールドを含まない", () => {
    const publicStatus = toPublicStatus(record()) as unknown as Record<
      string,
      unknown
    >;
    for (const internal of [
      "posts",
      "deliveries",
      "lastPostText",
      "revision",
      "serial",
      "category",
      "areaType",
    ]) {
      expect(publicStatus).not.toHaveProperty(internal);
    }
  });

  it("地域が無い情報は area が null になる", () => {
    expect(toPublicStatus(record({ area: null })).area).toBeNull();
  });
});

describe("NostrStatusMirror", () => {
  it("公開スキーマの content とフィルタ用タグで発行する", async () => {
    const publishReplaceable = jest.fn().mockResolvedValue("event-id");
    const mirror = new NostrStatusMirror({ publishReplaceable }, [
      "wss://relay.example",
    ]);
    await mirror.mirror(record());

    expect(publishReplaceable).toHaveBeenCalledTimes(1);
    const params = publishReplaceable.mock.calls[0][0];
    expect(params.kind).toBe(STATUS_EVENT_KIND);
    expect(params.d).toBe("weather:130010:03");
    expect(params.tags).toEqual([
      ["t", "weather"],
      ["L", STATUS_LABEL_NAMESPACE],
      ["l", "active", STATUS_LABEL_NAMESPACE],
      ["s", "warning"],
    ]);
    const content = JSON.parse(params.content);
    expect(content.schema).toBe(STATUS_SCHEMA);
    expect(content).not.toHaveProperty("lastPostText");
  });

  // replaceable event は created_at 同値だと id の小さい方が残る。
  // 同一秒内の連続更新が失われないよう厳密に単調増加させる
  it("同じキーの created_at は厳密に増える", async () => {
    const publishReplaceable = jest.fn().mockResolvedValue("event-id");
    const mirror = new NostrStatusMirror({ publishReplaceable });
    await mirror.mirror(record());
    await mirror.mirror(record());
    await mirror.mirror(record());
    const stamps = publishReplaceable.mock.calls.map(
      (call) => call[0].createdAt,
    );
    expect(stamps[1]).toBeGreaterThan(stamps[0]);
    expect(stamps[2]).toBeGreaterThan(stamps[1]);
  });
});
