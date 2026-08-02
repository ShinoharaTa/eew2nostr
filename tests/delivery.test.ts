import * as fs from "node:fs";
import * as path from "node:path";
import { classify } from "../src/classify";
import type { ClassifiedAlert } from "../src/classify/types";
import type { AccountClients } from "../src/publisher/account";
import { Delivery } from "../src/publisher/delivery";
import { parseTelegram } from "../src/receiver/jma-xml";
import { Router } from "../src/routing/router";
import type { RoutingConfig } from "../src/routing/types";
import { SqliteStatusStore } from "../src/store/sqlite-store";
import { StatusManager } from "../src/store/status-manager";

const alertsOf = (type: string): ClassifiedAlert[] =>
  classify(
    type,
    parseTelegram(
      fs.readFileSync(
        path.join(__dirname, "fixtures/telegrams", `${type}.xml`),
        "utf-8",
      ),
    ),
  );

const config: RoutingConfig = {
  accounts: {
    observed: { label: "観測情報", nostr: { hexEnv: "HEX_OBSERVED" } },
    warning: { label: "警報", nostr: { hexEnv: "HEX_WARNING" } },
  },
  routes: [
    { to: "observed", when: { kind: ["observed"] } },
    { to: "warning", when: { kind: ["forecast"], minSeverity: "warning" } },
  ],
};

// 鍵がある経路のクライアントだけを持つアカウントを組み立てる
const account = (key: string, withNostr: boolean) => {
  const publishNote = jest.fn().mockImplementation(async () => "a".repeat(64));
  const clients = {
    key,
    label: key,
    nostr: withNostr ? ({ publishNote } as unknown) : null,
    bluesky: null,
    concrnt: null,
  } as AccountClients;
  return { clients, publishNote };
};

const newDelivery = async (
  accounts: Map<string, AccountClients>,
  notifier = { notify: jest.fn() },
) => {
  const store = new SqliteStatusStore(":memory:");
  await store.init();
  const status = new StatusManager(store, { mirror: jest.fn() });
  await status.init();
  const delivery = new Delivery(
    accounts,
    new Router(config, {}),
    status,
    notifier,
  );
  return { delivery, status, notifier };
};

describe("Delivery", () => {
  it("ルーティングに従って配信先を選ぶ", async () => {
    const observed = account("observed", true);
    const warning = account("warning", true);
    const { delivery } = await newDelivery(
      new Map([
        ["observed", observed.clients],
        ["warning", warning.clients],
      ]),
    );

    delivery.deliver(alertsOf("VXSE53")); // 地震 = observed
    await delivery.flush();

    expect(observed.publishNote).toHaveBeenCalledTimes(1);
    expect(warning.publishNote).not.toHaveBeenCalled();
  });

  it("どのルートにも当たらなければ配信しない", async () => {
    const observed = account("observed", true);
    const { delivery } = await newDelivery(
      new Map([["observed", observed.clients]]),
    );

    delivery.deliver(alertsOf("VPWW53")); // 注意報 = 記録のみ
    await delivery.flush();

    expect(observed.publishNote).not.toHaveBeenCalled();
  });

  // 鍵が未設定なら投稿せずコンソールに出す (テストモード)
  it("鍵が無いアカウントには投稿しない", async () => {
    const observed = account("observed", false);
    const { delivery } = await newDelivery(
      new Map([["observed", observed.clients]]),
    );

    delivery.deliver(alertsOf("VXSE53"));
    await delivery.flush();

    expect(observed.publishNote).not.toHaveBeenCalled();
  });

  it("分割された投稿はスレッドで繋ぐ", async () => {
    const observed = account("observed", true);
    let count = 0;
    observed.publishNote.mockImplementation(async () => {
      count += 1;
      return String(count).padStart(64, "0");
    });
    const { delivery } = await newDelivery(
      new Map([["observed", observed.clients]]),
    );

    const [alert] = alertsOf("VXSE62");
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `${i}県北部`);
    delivery.deliver([
      {
        ...alert,
        detail: {
          ...alert.detail,
          observed: [
            { intensity: "7", names: many(20) },
            { intensity: "4", names: many(30) },
            { intensity: "3", names: many(30) },
          ],
        },
      },
    ]);
    await delivery.flush();

    expect(observed.publishNote.mock.calls.length).toBeGreaterThan(1);
    // 2件目以降は1件目への返信になる
    expect(observed.publishNote.mock.calls[0][0].reply).toBeUndefined();
    expect(observed.publishNote.mock.calls[1][0].reply).toEqual({
      root: "1".padStart(64, "0"),
      parent: "1".padStart(64, "0"),
    });
  });

  // 同じ地震の続報は前の投稿へ繋ぐ
  it("続報は前回の投稿への返信になる", async () => {
    const observed = account("observed", true);
    let count = 0;
    observed.publishNote.mockImplementation(async () => {
      count += 1;
      return String(count).padStart(64, "0");
    });
    const { delivery, status } = await newDelivery(
      new Map([["observed", observed.clients]]),
    );

    const [first] = alertsOf("VXSE51"); // 震度速報
    await status.upsert(
      {
        key: first.key,
        category: "earthquake",
        kind: "observed",
        severity: "info",
        status: "active",
        publishedAt: first.reportedAt,
        updatedAt: first.reportedAt,
        expiresAt: null,
        serial: null,
        headline: first.headline,
        area: first.area,
        areaType: first.areaType,
        detail: {},
        posts: {},
        deliveries: {},
        revision: 0,
      },
      () => {},
    );

    delivery.deliver([first]);
    await delivery.flush();
    delivery.deliver(alertsOf("VXSE53")); // 同じ地震の続報
    await delivery.flush();

    expect(observed.publishNote).toHaveBeenCalledTimes(2);
    expect(observed.publishNote.mock.calls[1][0].reply).toEqual({
      root: "1".padStart(64, "0"),
      parent: "1".padStart(64, "0"),
    });
  });

  // 複数地域をまとめた投稿は、どのイベントの続きか一意に決められない
  it("複数地域をまとめた投稿は続報として繋がない", async () => {
    const warning = account("warning", true);
    const { delivery, status } = await newDelivery(
      new Map([["warning", warning.clients]]),
    );

    delivery.deliver(alertsOf("VXWW50")); // 土砂 = 複数地域
    await delivery.flush();

    for (const call of warning.publishNote.mock.calls) {
      expect(call[0].reply).toBeUndefined();
    }
    // スレッド情報も残さない
    for (const record of Object.values(status.get("sediment:0620500") ?? {})) {
      expect(record).not.toHaveProperty("warning");
    }
  });

  it("投稿に失敗しても他の配信を止めない", async () => {
    const observed = account("observed", true);
    observed.publishNote.mockRejectedValue(new Error("relay down"));
    const notifier = { notify: jest.fn() };
    const { delivery } = await newDelivery(
      new Map([["observed", observed.clients]]),
      notifier,
    );

    delivery.deliver(alertsOf("VXSE53"));
    await expect(delivery.flush()).resolves.toBeUndefined();
    expect(notifier.notify).toHaveBeenCalled();
  });
});
