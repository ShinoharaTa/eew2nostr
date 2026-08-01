import * as fs from "node:fs";
import * as path from "node:path";
import type { JmaTelegram } from "../src/receiver/jma-feed";
import { parseTelegram } from "../src/receiver/jma-xml";
import { AlertRecorder } from "../src/store/alert-recorder";
import { SqliteStatusStore } from "../src/store/sqlite-store";
import { StatusManager } from "../src/store/status-manager";

const telegram = (type: string): JmaTelegram => ({
  id: `https://example.test/${type}.xml`,
  type,
  title: type,
  updatedAt: new Date("2026-08-01T00:00:00Z"),
  url: `https://example.test/${type}.xml`,
  report: parseTelegram(
    fs.readFileSync(
      path.join(__dirname, "fixtures/telegrams", `${type}.xml`),
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
