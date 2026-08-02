import * as fs from "node:fs";
import * as path from "node:path";
import axios from "axios";
import { SqliteFeedCursorStore } from "../src/receiver/feed-cursor";
import { JmaFeedReceiver, type JmaTelegram } from "../src/receiver/jma-feed";
import { SqliteStatusStore } from "../src/store/sqlite-store";

jest.mock("axios");

const telegramXml = fs.readFileSync(
  path.join(__dirname, "fixtures/telegrams/VXSE53.xml"),
  "utf-8",
);

const feedXml = (stamps: string[]) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
${stamps
  .map(
    (stamp) => `<entry>
  <title>震源・震度に関する情報</title>
  <id>https://example.test/${stamp}_0_VXSE53_010000.xml</id>
  <updated>${new Date(Number(stamp)).toISOString()}</updated>
  <link href="https://example.test/${stamp}_0_VXSE53_010000.xml"/>
</entry>`,
  )
  .join("\n")}
</feed>`;

const FEED = "https://example.test/feed.xml";

describe("再起動をまたぐ取りこぼしの防止", () => {
  let get: jest.Mock;
  let store: SqliteStatusStore;
  let cursors: SqliteFeedCursorStore;

  const respond = (body: string) => {
    get.mockImplementation(async (url: string) =>
      url === FEED
        ? { status: 200, data: body, headers: {} }
        : { status: 200, data: telegramXml, headers: {} },
    );
  };

  const newReceiver = (received: JmaTelegram[], withCursor = true) =>
    new JmaFeedReceiver(
      {
        feeds: [FEED],
        intervalMs: 60_000,
        ...(withCursor ? { cursors } : {}),
      },
      {
        onTelegram: (telegram) => received.push(telegram),
        onFailure: jest.fn(),
      },
    );

  const drain = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    get = jest.fn();
    (axios.create as jest.Mock).mockReturnValue({ get });
    store = new SqliteStatusStore(":memory:");
    await store.init();
    cursors = new SqliteFeedCursorStore(store.handle());
  });

  afterEach(async () => {
    jest.useRealTimers();
    await store.close();
  });

  // これが無いと、再起動のたびに全件を既読化して停止中の電文を捨てる
  it("再起動後もカーソルから再開して取りこぼさない", async () => {
    // 1回目の起動: 既読化して1件を配信
    const first: JmaTelegram[] = [];
    const a = newReceiver(first);
    respond(feedXml(["1000"]));
    await a.restore();
    a.start();
    await drain();
    respond(feedXml(["2000", "1000"]));
    jest.advanceTimersByTime(60_000);
    await drain();
    a.stop();
    expect(first).toHaveLength(1);

    // 停止中に新しい電文が発表された
    respond(feedXml(["3000", "2000", "1000"]));

    // 2回目の起動: カーソルから再開する
    const second: JmaTelegram[] = [];
    const b = newReceiver(second);
    await b.restore();
    b.start();
    await drain();
    b.stop();

    expect(second).toHaveLength(1);
    expect(second[0].id).toContain("3000");
  });

  it("カーソルが無ければ既読化から始める", async () => {
    const received: JmaTelegram[] = [];
    const receiver = newReceiver(received, false);
    respond(feedXml(["2000", "1000"]));
    await receiver.restore();
    receiver.start();
    await drain();
    receiver.stop();

    expect(received).toHaveLength(0);
  });

  // 長時間の停止ではフィードが入れ替わっており、古い電文を流しても意味がない
  it("カーソルが古すぎる場合は復元しない", async () => {
    await cursors.save(FEED, ["https://example.test/1000_0_VXSE53_010000.xml"]);
    store
      .handle()
      .prepare("UPDATE feed_cursor SET updated_at = ?")
      .run(new Date(Date.now() - 24 * 60 * 60_000).toISOString());

    const received: JmaTelegram[] = [];
    const receiver = new JmaFeedReceiver(
      { feeds: [FEED], intervalMs: 60_000, cursors, cursorMaxAgeMs: 60_000 },
      { onTelegram: (t) => received.push(t), onFailure: jest.fn() },
    );
    respond(feedXml(["3000", "2000", "1000"]));
    await receiver.restore();
    receiver.start();
    await drain();
    receiver.stop();

    expect(received).toHaveLength(0);
  });

  // 再起動直後に大量投稿が起きないようにする
  it("新着が多すぎる場合は上限まで配信して残りは既読にする", async () => {
    const stamps = Array.from({ length: 30 }, (_, i) => String(10_000 - i));
    await cursors.save(FEED, ["https://example.test/1_0_VXSE53_010000.xml"]);

    const received: JmaTelegram[] = [];
    const receiver = new JmaFeedReceiver(
      { feeds: [FEED], intervalMs: 60_000, cursors, maxCatchUp: 5 },
      { onTelegram: (t) => received.push(t), onFailure: jest.fn() },
    );
    respond(feedXml(stamps));
    await receiver.restore();
    receiver.start();
    await drain();
    receiver.stop();

    expect(received).toHaveLength(5);
    // 新しいものが残る
    expect(received[received.length - 1].id).toContain("10000");
  });
});

describe("SqliteFeedCursorStore", () => {
  let store: SqliteStatusStore;
  let cursors: SqliteFeedCursorStore;

  beforeEach(async () => {
    store = new SqliteStatusStore(":memory:");
    await store.init();
    cursors = new SqliteFeedCursorStore(store.handle());
  });

  afterEach(async () => {
    await store.close();
  });

  it("保存した内容を読み出せる", async () => {
    await cursors.save("feed-a", ["x", "y"]);
    const loaded = await cursors.load("feed-a");
    expect(loaded?.seen).toEqual(["x", "y"]);
    expect(Number.isNaN(new Date(loaded?.updatedAt ?? "").getTime())).toBe(
      false,
    );
  });

  it("同じフィードの保存は上書きになる", async () => {
    await cursors.save("feed-a", ["x"]);
    await cursors.save("feed-a", ["y", "z"]);
    expect((await cursors.load("feed-a"))?.seen).toEqual(["y", "z"]);
  });

  it("未保存のフィードは null", async () => {
    expect(await cursors.load("feed-none")).toBeNull();
  });
});
