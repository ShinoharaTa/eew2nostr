import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AlertStatusRecord } from "../src/core/status";
import {
  NostrStatusMirror,
  type ReplaceablePublisherPort,
  STATUS_EVENT_KIND,
  STATUS_LABEL_NAMESPACE,
} from "../src/store/relay-mirror";
import { SqliteStatusStore } from "../src/store/sqlite-store";
import { StatusManager } from "../src/store/status-manager";

const sampleRecord = (
  overrides: Partial<AlertStatusRecord> = {},
): AlertStatusRecord => ({
  key: "eew:20240109012003",
  category: "eew",
  kind: "forecast",
  severity: "info",
  status: "active",
  publishedAt: "2024-01-08T16:20:44.000Z",
  updatedAt: "2024-01-08T16:20:44.000Z",
  expiresAt: null,
  serial: "1",
  headline: "石川県能登地方 震度3（M3.5）",
  area: { name: "石川県能登地方", code: "390" },
  areaType: "震央地名",
  detail: { place: "石川県能登地方", magnitude: "3.5" },
  posts: {},
  deliveries: {},
  lastPostText: null,
  revision: 1,
  ...overrides,
});

describe("SqliteStatusStore", () => {
  let store: SqliteStatusStore;

  beforeEach(async () => {
    store = new SqliteStatusStore(":memory:");
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it("保存したレコードを復元できる", async () => {
    const record = sampleRecord({
      posts: { nostr: { root: "note-1", parent: "note-2" } },
    });
    await store.save(record);

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(record);
  });

  it("同じキーの保存は上書きになる", async () => {
    await store.save(sampleRecord({ serial: "1" }));
    await store.save(sampleRecord({ serial: "2", status: "finalized" }));

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].serial).toBe("2");
    expect(loaded[0].status).toBe("finalized");
  });

  it("保存直後は未ミラー、印を付けると外れる", async () => {
    const record = sampleRecord();
    await store.save(record);
    expect(await store.listUnmirrored()).toHaveLength(1);

    await store.markMirrored(record.key, record.revision);
    expect(await store.listUnmirrored()).toHaveLength(0);
  });

  it("ミラー中に更新されたレコードは未ミラーのまま残る", async () => {
    await store.save(sampleRecord({ revision: 1 }));
    // revision 1 をミラー中に revision 2 が保存された状況
    await store.save(sampleRecord({ revision: 2 }));
    await store.markMirrored("eew:20240109012003", 1);

    expect(await store.listUnmirrored()).toHaveLength(1);
  });

  it("ファイルに保存され別インスタンスから読み出せる", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eew-status-"));
    const filename = path.join(dir, "nested", "status.db");
    const writer = new SqliteStatusStore(filename);
    await writer.init();
    await writer.save(sampleRecord());
    await writer.close();

    const reader = new SqliteStatusStore(filename);
    await reader.init();
    const loaded = await reader.load();
    await reader.close();
    fs.rmSync(dir, { recursive: true, force: true });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].key).toBe("eew:20240109012003");
  });
});

describe("StatusManager", () => {
  const newManager = async (mirror = { mirror: jest.fn() }) => {
    const store = new SqliteStatusStore(":memory:");
    await store.init();
    const manager = new StatusManager(store, mirror);
    await manager.init();
    return { store, manager, mirror };
  };

  it("upsert は新規作成し、2回目は既存レコードを変更する", async () => {
    const { manager } = await newManager();
    await manager.upsert(sampleRecord({ revision: 0 }), () => {});
    await manager.upsert(sampleRecord({ revision: 0 }), (record) => {
      record.serial = "2";
    });
    await manager.flush();

    const record = manager.get("eew:20240109012003");
    expect(record?.serial).toBe("2");
    // 初回作成時の publishedAt が保たれている
    expect(record?.publishedAt).toBe("2024-01-08T16:20:44.000Z");
    expect(record?.revision).toBe(2);
  });

  it("保存のたびにリレーへミラーされる", async () => {
    const { manager, mirror } = await newManager();
    await manager.upsert(sampleRecord({ revision: 0 }), () => {});
    await manager.update("eew:20240109012003", (record) => {
      record.status = "finalized";
    });
    await manager.flush();

    expect(mirror.mirror).toHaveBeenCalledTimes(2);
    const [[first], [second]] = mirror.mirror.mock.calls;
    expect(first.status).toBe("active");
    expect(second.status).toBe("finalized");
  });

  it("ミラーが失敗しても本体の保存は成功したままになる", async () => {
    const mirror = {
      mirror: jest.fn().mockRejectedValue(new Error("relay down")),
    };
    const { store, manager } = await newManager(mirror);
    await manager.upsert(sampleRecord({ revision: 0 }), () => {});
    await manager.flush();

    expect(manager.get("eew:20240109012003")).toBeDefined();
    // 未ミラーのまま残るので次回起動時に再送される
    expect(await store.listUnmirrored()).toHaveLength(1);
  });

  it("起動時に保存済みレコードを復元し、未ミラー分を再送する", async () => {
    const store = new SqliteStatusStore(":memory:");
    await store.init();
    await store.save(sampleRecord());
    const mirror = { mirror: jest.fn() };

    const manager = new StatusManager(store, mirror);
    await manager.init();
    await manager.flush();

    expect(manager.get("eew:20240109012003")?.serial).toBe("1");
    expect(mirror.mirror).toHaveBeenCalledTimes(1);
    expect(await store.listUnmirrored()).toHaveLength(0);
  });

  it("存在しないキーの update は何もしない", async () => {
    const { manager, mirror } = await newManager();
    await manager.update("eew:unknown", (record) => {
      record.status = "cancelled";
    });
    await manager.flush();

    expect(manager.get("eew:unknown")).toBeUndefined();
    expect(mirror.mirror).not.toHaveBeenCalled();
  });
});

describe("NostrStatusMirror", () => {
  let nostr: jest.Mocked<ReplaceablePublisherPort>;
  let mirror: NostrStatusMirror;

  beforeEach(() => {
    nostr = { publishReplaceable: jest.fn().mockResolvedValue("event-id") };
    mirror = new NostrStatusMirror(nostr);
  });

  it("d タグをキー、種別を t タグ、状態を NIP-32 ラベルで発行する", async () => {
    await mirror.mirror(sampleRecord());

    const params = nostr.publishReplaceable.mock.calls[0][0];
    expect(params.kind).toBe(STATUS_EVENT_KIND);
    expect(params.d).toBe("eew:20240109012003");
    expect(params.tags).toEqual([
      ["t", "eew"],
      ["L", STATUS_LABEL_NAMESPACE],
      ["l", "active", STATUS_LABEL_NAMESPACE],
      ["s", "info"],
    ]);
    expect(JSON.parse(params.content).headline).toBe(
      "石川県能登地方 震度3（M3.5）",
    );
  });

  // 種別と状態が別のタグ名に載っていないと、購読側は
  // {"#t":["eew","active"]} という OR クエリしか組めず
  // 「発表中の緊急地震速報だけ」をサーバサイドで絞り込めない
  it("種別と状態は別のタグ名に載る", async () => {
    await mirror.mirror(sampleRecord({ status: "finalized" }));

    const tags = nostr.publishReplaceable.mock.calls[0][0].tags;
    const topicValues = tags.filter((tag) => tag[0] === "t").map((t) => t[1]);
    const labelValues = tags.filter((tag) => tag[0] === "l").map((t) => t[1]);
    expect(topicValues).toEqual(["eew"]);
    expect(labelValues).toEqual(["finalized"]);
  });

  it("同一秒に連続更新しても created_at が単調増加する", async () => {
    await mirror.mirror(sampleRecord({ status: "active" }));
    await mirror.mirror(sampleRecord({ status: "finalized" }));
    await mirror.mirror(sampleRecord({ status: "cancelled" }));

    const [first, second, third] = nostr.publishReplaceable.mock.calls.map(
      (call) => call[0].createdAt,
    );
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it("キーが違えば created_at は独立している", async () => {
    await mirror.mirror(sampleRecord({ key: "eew:a" }));
    await mirror.mirror(sampleRecord({ key: "eew:a" }));
    await mirror.mirror(sampleRecord({ key: "eew:b" }));

    const calls = nostr.publishReplaceable.mock.calls.map(
      (call) => call[0].createdAt,
    );
    // 同一キーは +1 されるが、別キーはその影響を受けない
    expect(calls[1]).toBe(calls[0] + 1);
    expect(calls[2]).toBeLessThanOrEqual(calls[1]);
  });
});
