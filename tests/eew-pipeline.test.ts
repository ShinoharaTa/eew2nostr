import * as fs from "node:fs";
import * as path from "node:path";
import { eewStatusKey } from "../src/classify/eew";
import { EEWParser } from "../src/core/parser";
import type { AccountClients } from "../src/publisher/account";
import { Delivery } from "../src/publisher/delivery";
import { EEWPipeline } from "../src/publisher/eew-pipeline";
import { Router } from "../src/routing/router";
import type { RoutingConfig } from "../src/routing/types";
import { AlertRecorder } from "../src/store/alert-recorder";
import { SqliteStatusStore } from "../src/store/sqlite-store";
import { StatusManager } from "../src/store/status-manager";
import type { JsonSchema } from "../src/types/eew";

const loadSample = (filename: string): JsonSchema =>
  JSON.parse(
    fs.readFileSync(path.join(__dirname, "../sampleData", filename), "utf-8"),
  );

// 本番の routing.json と同じ形。eew は専用アカウントだけに流れること。
const config: RoutingConfig = {
  accounts: {
    eew: { label: "緊急地震速報", nostr: { hexEnv: "HEX_EEW" } },
    emergency: { label: "速報", nostr: { hexEnv: "HEX_EMERGENCY" } },
    warning: { label: "警報", nostr: { hexEnv: "HEX_WARNING" } },
  },
  routes: [
    { to: "eew", when: { hazard: ["eew"] } },
    {
      to: "emergency",
      when: { minSeverity: "emergency", hazardNot: ["eew"] },
    },
    {
      to: "warning",
      when: { kind: ["forecast"], minSeverity: "warning", hazardNot: ["eew"] },
    },
  ],
};

const account = (key: string) => {
  let count = 0;
  const publishNote = jest.fn().mockImplementation(async () => {
    count += 1;
    return String(count).padStart(64, "0");
  });
  const clients = {
    key,
    label: key,
    nostr: { publishNote } as unknown,
    bluesky: null,
    concrnt: null,
  } as AccountClients;
  return { clients, publishNote };
};

const setup = async () => {
  const store = new SqliteStatusStore(":memory:");
  await store.init();
  const status = new StatusManager(store, { mirror: jest.fn() });
  await status.init();
  const eew = account("eew");
  const emergency = account("emergency");
  const warning = account("warning");
  const delivery = new Delivery(
    new Map([
      ["eew", eew.clients],
      ["emergency", emergency.clients],
      ["warning", warning.clients],
    ]),
    new Router(config, {}),
    status,
  );
  const recorder = new AlertRecorder(status, undefined, delivery);
  const raw = { publishRaw: jest.fn().mockResolvedValue("raw-id") };
  const pipeline = new EEWPipeline(new EEWParser(), recorder, status, raw);
  return { pipeline, delivery, status, eew, emergency, warning, raw };
};

// 予想最大震度6弱の警報に書き換えた電文
const strongTelegram = (): JsonSchema => {
  const telegram = loadSample("eew_single..json");
  telegram.body.isWarning = true;
  if (telegram.body.intensity) {
    telegram.body.intensity.forecastMaxInt = { from: "6-", to: "6-" };
  }
  return telegram;
};

describe("EEWPipeline", () => {
  it("eew アカウントだけに配信される", async () => {
    const { pipeline, delivery, eew, emergency, warning } = await setup();
    // severity は emergency になるが、専用アカウントを持つため
    // emergency / warning のルートには乗らない
    await pipeline.handle(strongTelegram());
    await delivery.flush();

    expect(eew.publishNote).toHaveBeenCalledTimes(1);
    expect(emergency.publishNote).not.toHaveBeenCalled();
    expect(warning.publishNote).not.toHaveBeenCalled();
    expect(eew.publishNote.mock.calls[0][0].content).toContain(
      "緊急地震速報（警報）",
    );
  });

  it("ステータスに記録される", async () => {
    const { pipeline, delivery, status } = await setup();
    await pipeline.handle(loadSample("eew_single..json"));
    await delivery.flush();

    const record = status.get(eewStatusKey("20240109012003"));
    expect(record?.category).toBe("eew");
    // 最終報の電文なので finalized になる
    expect(record?.status).toBe("finalized");
  });

  it("続報は前回の投稿への返信になる", async () => {
    const { pipeline, delivery, eew } = await setup();
    const first = loadSample("eew_single..json");
    first.body.isLastInfo = false;
    first.serialNo = "1";
    await pipeline.handle(first);
    await delivery.flush();

    const second = loadSample("eew_single..json");
    second.serialNo = "2";
    await pipeline.handle(second);
    await delivery.flush();

    expect(eew.publishNote).toHaveBeenCalledTimes(2);
    expect(eew.publishNote.mock.calls[1][0].reply).toEqual({
      root: "1".padStart(64, "0"),
      parent: "1".padStart(64, "0"),
    });
  });

  // 取り消す対象が流れていないのに「取り消されました」だけが出ると混乱を招く
  it("記録が無い取消報は投稿しない", async () => {
    const { pipeline, delivery, status, eew } = await setup();
    const cancel = loadSample("eew_single..json");
    cancel.infoType = "取消";
    await pipeline.handle(cancel);
    await delivery.flush();

    expect(eew.publishNote).not.toHaveBeenCalled();
    expect(status.get(eewStatusKey("20240109012003"))).toBeUndefined();
  });

  it("記録がある取消報はスレッドへ流し、状態を cancelled にする", async () => {
    const { pipeline, delivery, status, eew } = await setup();
    const first = loadSample("eew_single..json");
    first.body.isLastInfo = false;
    await pipeline.handle(first);
    await delivery.flush();

    const cancel = loadSample("eew_single..json");
    cancel.infoType = "取消";
    await pipeline.handle(cancel);
    await delivery.flush();

    expect(eew.publishNote).toHaveBeenCalledTimes(2);
    expect(eew.publishNote.mock.calls[1][0].content).toContain(
      "取り消されました",
    );
    expect(eew.publishNote.mock.calls[1][0].reply).toBeDefined();
    expect(status.get(eewStatusKey("20240109012003"))?.status).toBe(
      "cancelled",
    );
  });

  // 生電文 (kind 7078) は投稿の成否と切り離した側路で流す
  it("生電文を publishRaw に渡す", async () => {
    const { pipeline, delivery, raw } = await setup();
    const telegram = loadSample("eew_single..json");
    await pipeline.handle(telegram);
    await delivery.flush();

    expect(raw.publishRaw).toHaveBeenCalledTimes(1);
    expect(JSON.parse(raw.publishRaw.mock.calls[0][0])).toEqual(telegram);
  });

  it("取消報では生電文を流さない", async () => {
    const { pipeline, delivery, raw } = await setup();
    const first = loadSample("eew_single..json");
    first.body.isLastInfo = false;
    await pipeline.handle(first);
    const cancel = loadSample("eew_single..json");
    cancel.infoType = "取消";
    await pipeline.handle(cancel);
    await delivery.flush();

    expect(raw.publishRaw).toHaveBeenCalledTimes(1);
  });
});
