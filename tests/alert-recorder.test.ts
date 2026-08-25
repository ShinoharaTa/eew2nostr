import * as fs from "node:fs";
import * as path from "node:path";
import type { JmaTelegram } from "../src/receiver/jma-feed";
import { parseTelegram } from "../src/receiver/jma-xml";
import { AlertRecorder } from "../src/store/alert-recorder";
import { SqliteStatusStore } from "../src/store/sqlite-store";
import { StatusManager } from "../src/store/status-manager";

// 同じ種別の続報を並べたいときはフィクスチャ名と種別コードを分ける
const telegram = (fixture: string, type = fixture): JmaTelegram => ({
  id: `https://example.test/${fixture}.xml`,
  type,
  title: fixture,
  updatedAt: new Date("2026-08-01T00:00:00Z"),
  url: `https://example.test/${fixture}.xml`,
  report: parseTelegram(
    fs.readFileSync(
      path.join(__dirname, "fixtures/telegrams", `${fixture}.xml`),
      "utf-8",
    ),
  ),
});

const newRecorder = async () => {
  const store = new SqliteStatusStore(":memory:");
  await store.init();
  const mirror = { mirror: jest.fn() };
  const status = new StatusManager(store, mirror);
  await status.init();
  return { store, status, mirror, recorder: new AlertRecorder(status) };
};

describe("AlertRecorder", () => {
  it("分類結果をステータスとして記録する", async () => {
    const { recorder, status } = await newRecorder();
    const count = await recorder.record(telegram("VXSE53"));

    expect(count).toBe(1);
    const record = status.get("earthquake:20260801184125");
    expect(record?.category).toBe("earthquake");
    expect(record?.severity).toBe("info");
    expect(record?.status).toBe("active");
    expect(record?.area?.name).toBe("熊本県天草・芦北地方");
    expect(record?.detail.magnitude).toBe("3.8");
  });

  it("気象警報は地域 × 種別の数だけ記録される", async () => {
    const { recorder, store } = await newRecorder();
    const count = await recorder.record(telegram("VPWW53"));

    expect(count).toBeGreaterThan(1);
    const saved = await store.load();
    expect(saved).toHaveLength(count);
    for (const record of saved) {
      expect(record.category).toBe("weather");
      expect(record.key).toMatch(/^weather:\d+:\d+$/);
    }
  });

  it("対象外の電文は何も記録しない", async () => {
    const { recorder, store } = await newRecorder();
    const ignored = { ...telegram("VXSE53"), type: "VPFJ50" };

    expect(await recorder.record(ignored)).toBe(0);
    expect(await store.load()).toHaveLength(0);
  });

  // 同じ事象の続報は同じキーになるため、レコードは増えずに更新される
  it("同じ地震の続報は1レコードにまとまる", async () => {
    const { recorder, store, status } = await newRecorder();
    await recorder.record(telegram("VXSE51")); // 震度速報
    await recorder.record(telegram("VXSE53")); // 震源・震度に関する情報

    expect(await store.load()).toHaveLength(1);
    // 後から届いた震源・震度情報で内容が更新される
    expect(status.get("earthquake:20260801184125")?.detail.magnitude).toBe(
      "3.8",
    );
  });

  it("解除は状態に反映される", async () => {
    const { recorder, status } = await newRecorder();
    await recorder.record(telegram("VTSE41"));

    const record = status.get("tsunami:712");
    expect(record?.status).toBe("resolved");
    expect(record?.headline).toContain("解除");
  });

  // VPWW53 の一次細分区域ブロックは府県予報区の全区域の現況を載せる。
  // 警報から注意報への切り替えでは警報側の解除電文が出ないため、
  // 電文に載らなくなったものを解除できないと発表中のまま残り続ける。
  describe("現況スナップショット", () => {
    it("警報から注意報に切り替わった警報を解除する", async () => {
      const { recorder, status } = await newRecorder();
      await recorder.record(telegram("VPWW53-warning", "VPWW53"));
      expect(status.get("weather:012010:03")?.status).toBe("active");

      await recorder.record(telegram("VPWW53-next", "VPWW53"));

      const warning = status.get("weather:012010:03");
      expect(warning?.status).toBe("resolved");
      expect(warning?.updatedAt).toBe("2026-08-01T22:10:00+09:00");
      // 切り替え先の注意報は発表中として記録される
      expect(status.get("weather:012010:10")?.status).toBe("active");
    });

    it("発表警報・注意報はなし をその区域の全解除として扱う", async () => {
      const { recorder, status } = await newRecorder();
      await recorder.record(telegram("VPWW53-warning", "VPWW53"));
      expect(status.get("weather:012020:20")?.status).toBe("active");

      await recorder.record(telegram("VPWW53-next", "VPWW53"));

      expect(status.get("weather:012020:20")?.status).toBe("resolved");
    });

    it("解除は記録するだけで配信しない", async () => {
      const store = new SqliteStatusStore(":memory:");
      await store.init();
      const status = new StatusManager(store, { mirror: jest.fn() });
      await status.init();
      const delivery = { deliver: jest.fn() };
      const recorder = new AlertRecorder(status, undefined, delivery as never);

      await recorder.record(telegram("VPWW53-warning", "VPWW53"));
      await recorder.record(telegram("VPWW53-next", "VPWW53"));

      // 2通目で配信に渡るのは電文に載っていた注意報だけ
      const delivered = delivery.deliver.mock.calls[1][0] as { key: string }[];
      expect(delivered.map((alert) => alert.key)).toEqual([
        "weather:012010:10",
      ]);
    });

    it("スコープ外のレコードは巻き込まない", async () => {
      const { recorder, status, store } = await newRecorder();
      await recorder.record(telegram("VPWW53-warning", "VPWW53"));
      // 上川・留萌 (012010 / 012020) のスコープに入らない別種別
      await recorder.record(telegram("VXWW50"));
      const before = (await store.load())
        .filter((record) => !record.key.startsWith("weather:0120"))
        .map((record) => [record.key, record.status] as const);
      expect(before.length).toBeGreaterThan(0);

      await recorder.record(telegram("VPWW53-next", "VPWW53"));

      for (const [key, expected] of before) {
        expect(status.get(key)?.status).toBe(expected);
      }
    });
  });

  it("有効期限を保持する", async () => {
    const { recorder, store } = await newRecorder();
    await recorder.record(telegram("VPHW50"));

    const saved = await store.load();
    expect(saved.length).toBeGreaterThan(0);
    for (const record of saved) {
      expect(record.category).toBe("tornado");
      expect(record.expiresAt).not.toBeNull();
    }
  });

  it("記録するたびにリレーへミラーされる", async () => {
    const { recorder, status, mirror } = await newRecorder();
    await recorder.record(telegram("VXSE53"));
    await status.flush();

    expect(mirror.mirror).toHaveBeenCalledTimes(1);
    expect(mirror.mirror.mock.calls[0][0].severity).toBe("info");
  });

  it("再起動しても記録が復元される", async () => {
    const store = new SqliteStatusStore(":memory:");
    await store.init();
    const first = new StatusManager(store, { mirror: jest.fn() });
    await first.init();
    await new AlertRecorder(first).record(telegram("VXSE53"));

    // 同じストアから作り直す
    const second = new StatusManager(store, { mirror: jest.fn() });
    await second.init();
    expect(second.get("earthquake:20260801184125")?.severity).toBe("info");
  });
});
