import type { AlertStatusRecord } from "../src/core/status";
import {
  DEFAULT_TTL_MS,
  StatusSweeper,
  dueForSweep,
} from "../src/store/expiry-sweeper";
import { SqliteStatusStore } from "../src/store/sqlite-store";
import { StatusManager } from "../src/store/status-manager";

const NOW = new Date("2026-09-10T12:00:00+09:00");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const record = (over: Partial<AlertStatusRecord>): AlertStatusRecord => ({
  key: "earthquake:1",
  category: "earthquake",
  kind: "observed",
  severity: "info",
  status: "active",
  publishedAt: ago(0),
  updatedAt: ago(0),
  expiresAt: null,
  serial: null,
  headline: "地震情報",
  area: null,
  areaType: null,
  detail: {},
  posts: {},
  deliveries: {},
  lastPostText: null,
  revision: 0,
  ...over,
});

describe("dueForSweep", () => {
  // #63: 竜巻注意情報は解除電文が出ず、有効期限で失効する
  it("expiresAt を過ぎた発表中は resolved になる", () => {
    const target = record({
      key: "tornado:160020",
      category: "tornado",
      expiresAt: ago(60_000),
    });

    expect(dueForSweep([target], NOW)).toEqual([
      {
        key: "tornado:160020",
        status: "resolved",
        reason: "expired",
        headline: "地震情報",
      },
    ]);
  });

  it("expiresAt がまだ先なら残る", () => {
    const target = record({
      category: "tornado",
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });

    expect(dueForSweep([target], NOW)).toHaveLength(0);
  });

  // 有効期限は電文が明示した値なので TTL より優先する
  it("expiresAt と TTL の両方を過ぎていれば resolved を採る", () => {
    const target = record({
      category: "earthquake",
      updatedAt: ago(2 * 60 * 60_000),
      expiresAt: ago(60_000),
    });

    expect(dueForSweep([target], NOW)[0]?.status).toBe("resolved");
  });

  // #64: 地震情報・記録的短時間大雨情報には解除電文が存在しない
  it("TTL を過ぎた発表中は finalized になる", () => {
    const targets = dueForSweep(
      [
        record({ key: "earthquake:1", updatedAt: ago(61 * 60_000) }),
        record({
          key: "heavy-rain:1",
          category: "heavy-rain",
          updatedAt: ago(4 * 60 * 60_000),
        }),
        record({ key: "eew:1", category: "eew", updatedAt: ago(11 * 60_000) }),
      ],
      NOW,
    );

    expect(targets.map((t) => [t.key, t.status, t.reason])).toEqual([
      ["earthquake:1", "finalized", "ttl"],
      ["heavy-rain:1", "finalized", "ttl"],
      ["eew:1", "finalized", "ttl"],
    ]);
  });

  it("TTL ちょうどは落とし、1ミリ秒手前は残す", () => {
    const limit = DEFAULT_TTL_MS.earthquake as number;

    expect(dueForSweep([record({ updatedAt: ago(limit) })], NOW)).toHaveLength(
      1,
    );
    expect(
      dueForSweep([record({ updatedAt: ago(limit - 1) })], NOW),
    ).toHaveLength(0);
  });

  // 続報が来れば updatedAt が進むので、そこから測り直しになる
  it("続報で updatedAt が進んでいれば残る", () => {
    const target = record({
      publishedAt: ago(5 * 60 * 60_000),
      updatedAt: ago(60_000),
    });

    expect(dueForSweep([target], NOW)).toHaveLength(0);
  });

  // 解除電文で終端に到達する種別を時間で切ると、発表中に消えてしまう
  it("解除電文のある種別は TTL では落とさない", () => {
    const old = ago(30 * 24 * 60 * 60_000);
    const targets = dueForSweep(
      [
        record({ key: "weather:1", category: "weather", updatedAt: old }),
        record({ key: "tsunami:1", category: "tsunami", updatedAt: old }),
        record({ key: "volcano:1", category: "volcano", updatedAt: old }),
        record({ key: "flood:1", category: "flood", updatedAt: old }),
        record({ key: "sediment:1", category: "sediment", updatedAt: old }),
        record({ key: "megaquake:1", category: "megaquake", updatedAt: old }),
      ],
      NOW,
    );

    expect(targets).toHaveLength(0);
  });

  it("発表中でないレコードは対象外", () => {
    const old = ago(30 * 24 * 60 * 60_000);
    const targets = dueForSweep(
      [
        record({ key: "a", status: "resolved", updatedAt: old }),
        record({ key: "b", status: "finalized", updatedAt: old }),
        record({ key: "c", status: "cancelled", updatedAt: old }),
      ],
      NOW,
    );

    expect(targets).toHaveLength(0);
  });

  it("日付として読めない値は落とさない", () => {
    const targets = dueForSweep(
      [
        record({ key: "a", expiresAt: "なし" }),
        record({ key: "b", updatedAt: "なし" }),
      ],
      NOW,
    );

    expect(targets).toHaveLength(0);
  });
});

describe("StatusSweeper", () => {
  const newSweeper = async () => {
    const store = new SqliteStatusStore(":memory:");
    await store.init();
    const mirror = { mirror: jest.fn() };
    const status = new StatusManager(store, mirror);
    await status.init();
    return { store, status, mirror, sweeper: new StatusSweeper(status) };
  };

  const put = async (status: StatusManager, over: Partial<AlertStatusRecord>) =>
    status.upsert(record(over), () => {});

  it("落とした状態を保存してリレーへミラーする", async () => {
    const { sweeper, status, store, mirror } = await newSweeper();
    await put(status, { key: "earthquake:1", updatedAt: ago(2 * 60 * 60_000) });
    mirror.mirror.mockClear();

    const targets = await sweeper.sweep(NOW);
    await status.flush();

    expect(targets).toHaveLength(1);
    expect(status.get("earthquake:1")?.status).toBe("finalized");
    expect(status.get("earthquake:1")?.updatedAt).toBe(NOW.toISOString());
    const saved = await store.load();
    expect(saved[0]?.status).toBe("finalized");
    expect(mirror.mirror).toHaveBeenCalledTimes(1);
  });

  // 受信を止めていた間の取り残しが一斉に投稿されるのを避けるため、
  // スイープは記録だけを進めて配信はしない
  it("二度目のスイープでは何も起きない", async () => {
    const { sweeper, status } = await newSweeper();
    await put(status, { key: "earthquake:1", updatedAt: ago(2 * 60 * 60_000) });

    expect(await sweeper.sweep(NOW)).toHaveLength(1);
    expect(await sweeper.sweep(NOW)).toHaveLength(0);
  });

  it("対象が無ければ何も更新しない", async () => {
    const { sweeper, status, mirror } = await newSweeper();
    await put(status, { key: "earthquake:1", updatedAt: ago(60_000) });
    mirror.mirror.mockClear();

    expect(await sweeper.sweep(NOW)).toHaveLength(0);
    await status.flush();
    expect(mirror.mirror).not.toHaveBeenCalled();
  });
});
