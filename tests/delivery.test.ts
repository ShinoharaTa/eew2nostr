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

    await delivery.deliver(alertsOf("VXSE53")); // 地震 = observed
    await delivery.flush();

    expect(observed.publishNote).toHaveBeenCalledTimes(1);
    expect(warning.publishNote).not.toHaveBeenCalled();
  });

  it("どのルートにも当たらなければ配信しない", async () => {
    const observed = account("observed", true);
    const { delivery } = await newDelivery(
      new Map([["observed", observed.clients]]),
    );

    await delivery.deliver(alertsOf("VPWW53")); // 注意報 = 記録のみ
    await delivery.flush();

    expect(observed.publishNote).not.toHaveBeenCalled();
  });

  // 鍵が未設定なら投稿せずコンソールに出す (テストモード)
  it("鍵が無いアカウントには投稿しない", async () => {
    const observed = account("observed", false);
    const { delivery } = await newDelivery(
      new Map([["observed", observed.clients]]),
    );

    await delivery.deliver(alertsOf("VXSE53"));
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
    await delivery.deliver([
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

    await delivery.deliver([first]);
    await delivery.flush();
    await delivery.deliver(alertsOf("VXSE53")); // 同じ地震の続報
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

    await delivery.deliver(alertsOf("VXWW50")); // 土砂 = 複数地域
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

    await delivery.deliver(alertsOf("VXSE53"));
    await expect(delivery.flush()).resolves.toBeUndefined();
    expect(notifier.notify).toHaveBeenCalled();
  });

  // Bluesky は reply の参照に uri と cid の両方を要求する。
  // cid の欄に URI を入れると Invalid CID string で返信が失敗する。
  describe("Bluesky のスレッド", () => {
    const bskyAccount = (key: string) => {
      let count = 0;
      const publish = jest.fn().mockImplementation(async () => {
        count += 1;
        return {
          uri: `at://did:plc:example/app.bsky.feed.post/${count}`,
          cid: `bafyreicid${count}`,
        };
      });
      const clients = {
        key,
        label: key,
        nostr: null,
        bluesky: { publish } as unknown,
        concrnt: null,
      } as AccountClients;
      return { clients, publish };
    };

    it("分割投稿の返信に本物の cid を使う", async () => {
      const observed = bskyAccount("observed");
      const { delivery } = await newDelivery(
        new Map([["observed", observed.clients]]),
      );
      const [alert] = alertsOf("VXSE62");
      const many = (n: number) =>
        Array.from({ length: n }, (_, i) => `${i}県北部`);
      await delivery.deliver([
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

      expect(observed.publish.mock.calls.length).toBeGreaterThan(1);
      const reply = observed.publish.mock.calls[1][1];
      expect(reply.root).toEqual({
        uri: "at://did:plc:example/app.bsky.feed.post/1",
        cid: "bafyreicid1",
      });
      expect(reply.root.cid).not.toContain("at://");
    });

    it("続報は保存された本物の cid で繋がる", async () => {
      const observed = bskyAccount("observed");
      const { delivery, status } = await newDelivery(
        new Map([["observed", observed.clients]]),
      );
      const alerts = alertsOf("VXSE53");
      // 本番では AlertRecorder が配信前に upsert する
      await status.upsert(
        {
          key: alerts[0].key,
          category: "earthquake",
          kind: "observed",
          severity: "info",
          status: "active",
          publishedAt: alerts[0].reportedAt,
          updatedAt: alerts[0].reportedAt,
          expiresAt: null,
          serial: null,
          headline: alerts[0].headline,
          area: alerts[0].area,
          areaType: alerts[0].areaType,
          detail: {},
          posts: {},
          deliveries: {},
          lastPostText: null,
          revision: 0,
        },
        () => {},
      );
      await delivery.deliver(alerts);
      await delivery.flush();

      // 保存された参照に本物の cid が入っていること
      const stored = status.get(alerts[0].key)?.deliveries?.observed?.bluesky;
      expect(stored?.root.cid).toBe("bafyreicid1");

      // 続報 (文面が変わる) が保存された参照へ繋がること
      await delivery.deliver(
        alerts.map((a) => ({
          ...a,
          detail: { ...a.detail, magnitude: "4.2" },
        })),
      );
      await delivery.flush();

      const reply = observed.publish.mock.calls[1][1];
      expect(reply.root.cid).toBe("bafyreicid1");
    });

    // 過去の不具合で cid の欄に URI が保存されていることがある。
    // 壊れた参照で繋ぐと返信が失敗し続けるため、新規スレッドを立て直す
    it("壊れた保存済み参照は使わず新規スレッドにする", async () => {
      const observed = bskyAccount("observed");
      const { delivery, status } = await newDelivery(
        new Map([["observed", observed.clients]]),
      );
      const alerts = alertsOf("VXSE53");
      const brokenUri = "at://did:plc:example/app.bsky.feed.post/old";
      await status.upsert(
        {
          key: alerts[0].key,
          category: "earthquake",
          kind: "observed",
          severity: "info",
          status: "active",
          publishedAt: alerts[0].reportedAt,
          updatedAt: alerts[0].reportedAt,
          expiresAt: null,
          serial: null,
          headline: alerts[0].headline,
          area: alerts[0].area,
          areaType: alerts[0].areaType,
          detail: {},
          posts: {},
          deliveries: {
            observed: {
              bluesky: {
                root: { uri: brokenUri, cid: brokenUri },
                parent: { uri: brokenUri, cid: brokenUri },
              },
            },
          },
          lastPostText: null,
          revision: 0,
        },
        () => {},
      );

      await delivery.deliver(alerts);
      await delivery.flush();

      // reply を付けずに投稿し直す
      expect(observed.publish).toHaveBeenCalledTimes(1);
      expect(observed.publish.mock.calls[0][1]).toBeUndefined();
      // 保存も本物の cid で上書きされる
      const stored = status.get(alerts[0].key)?.deliveries?.observed?.bluesky;
      expect(stored?.root.cid).toBe("bafyreicid1");
    });
  });

  // VPWW53 は県内のどこかで別の警報が動くたびに再発表され、変化していない
  // 警報も「継続」で毎回載ってくる。同じ文面を繰り返し投稿しない。
  describe("同一文面の抑制", () => {
    // AlertRecorder が upsert するレコードを模す
    const recordOf = (alert: ClassifiedAlert) => ({
      key: alert.key,
      category: alert.hazard,
      kind: alert.kind,
      severity: alert.severity,
      status: alert.state,
      publishedAt: alert.reportedAt,
      updatedAt: alert.reportedAt,
      expiresAt: alert.expiresAt,
      serial: null,
      headline: alert.headline,
      area: alert.area,
      areaType: alert.areaType,
      detail: alert.detail,
      posts: {},
      deliveries: {},
      lastPostText: null,
      revision: 0,
    });

    it("同じ文面の再配信はしない", async () => {
      const warning = account("observed", true);
      const { delivery, status } = await newDelivery(
        new Map([["observed", warning.clients]]),
      );
      const alerts = alertsOf("VXSE53");
      for (const alert of alerts)
        await status.upsert(recordOf(alert), () => {});

      await delivery.deliver(alerts);
      await delivery.flush();
      const first = warning.publishNote.mock.calls.length;
      expect(first).toBeGreaterThan(0);

      // 再発表 (内容は同一) を受けたときと同じ流れ
      for (const alert of alerts)
        await status.upsert(recordOf(alert), () => {});
      await delivery.deliver(alerts);
      await delivery.flush();

      expect(warning.publishNote.mock.calls.length).toBe(first);
    });

    it("文面が変わっていれば配信する", async () => {
      const observed = account("observed", true);
      const { delivery, status } = await newDelivery(
        new Map([["observed", observed.clients]]),
      );
      const alerts = alertsOf("VXSE53");
      for (const alert of alerts)
        await status.upsert(recordOf(alert), () => {});

      await delivery.deliver(alerts);
      await delivery.flush();
      const first = observed.publishNote.mock.calls.length;

      // 続報で内容が更新された場合 (規模の更新など) は文面が変わる
      const updated = alerts.map((alert) => ({
        ...alert,
        detail: { ...alert.detail, magnitude: "4.2" },
      }));
      await delivery.deliver(updated);
      await delivery.flush();

      expect(observed.publishNote.mock.calls.length).toBeGreaterThan(first);
    });

    it("レコードが無ければ抑制せず配信する", async () => {
      const observed = account("observed", true);
      const { delivery } = await newDelivery(
        new Map([["observed", observed.clients]]),
      );

      // upsert していない = ステータスに前回の記録が無い
      await delivery.deliver(alertsOf("VXSE53"));
      await delivery.flush();

      expect(observed.publishNote).toHaveBeenCalled();
    });
  });
});

describe("発令エリアの画像URL", () => {
  it("Nostr にだけ付き、他の SNS には付かない", async () => {
    const publishNote = jest
      .fn()
      .mockImplementation(async () => "a".repeat(64));
    const publishBsky = jest
      .fn()
      .mockImplementation(async () => ({ uri: "at://post/1", cid: "cid1" }));
    const clients = {
      key: "warning",
      label: "warning",
      nostr: { publishNote } as unknown,
      bluesky: { publish: publishBsky } as unknown,
      concrnt: null,
    } as AccountClients;

    const store = new SqliteStatusStore(":memory:");
    await store.init();
    const status = new StatusManager(store, { mirror: jest.fn() });
    await status.init();
    const delivery = new Delivery(
      new Map([["warning", clients]]),
      new Router(config, {}),
      status,
      undefined,
      undefined,
      "https://viewer.example",
    );

    const xml = fs.readFileSync(
      path.join(__dirname, "fixtures/telegrams", "VPWW53-warning.xml"),
      "utf-8",
    );
    await delivery.deliver(classify("VPWW53", parseTelegram(xml)));
    await delivery.flush();

    expect(publishNote).toHaveBeenCalled();
    expect(publishBsky).toHaveBeenCalled();
    for (const [note] of publishNote.mock.calls) {
      expect(note.content).toContain(
        "https://viewer.example/images/alert.webp?pref=",
      );
    }
    for (const [content] of publishBsky.mock.calls) {
      expect(content).not.toContain("/images/alert.webp");
    }
  });
});
