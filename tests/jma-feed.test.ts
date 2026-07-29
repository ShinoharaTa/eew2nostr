import * as fs from "node:fs";
import * as path from "node:path";
import axios from "axios";
import { JmaFeedReceiver, type JmaTelegram } from "../src/receiver/jma-feed";

jest.mock("axios");

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, "fixtures", name), "utf-8");

const telegramXml = fixture("telegram-VXSE53.xml");

const feedXml = (
  entries: { code: string; stamp: string }[],
) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>高頻度（地震火山）</title>
${entries
  .map(
    (entry) => `  <entry>
    <title>震源・震度に関する情報</title>
    <id>https://example.test/${entry.stamp}_0_${entry.code}_010000.xml</id>
    <updated>${new Date(Number(entry.stamp)).toISOString()}</updated>
    <link type="application/xml" href="https://example.test/${entry.stamp}_0_${entry.code}_010000.xml"/>
  </entry>`,
  )
  .join("\n")}
</feed>`;

const FEED = "https://example.test/feed.xml";

describe("JmaFeedReceiver", () => {
  let get: jest.Mock;
  let received: JmaTelegram[];
  let onFailure: jest.Mock;
  let onRecovery: jest.Mock;

  // フィード応答を差し替えつつ、電文 URL には固定の XML を返す
  const respondWith = (feedBody: string, status = 200) => {
    get.mockImplementation(async (url: string) => {
      if (url === FEED) {
        return { status, data: feedBody, headers: { etag: '"v1"' } };
      }
      return { status: 200, data: telegramXml, headers: {} };
    });
  };

  const newReceiver = (failureThreshold = 2) =>
    new JmaFeedReceiver(
      { feeds: [FEED], intervalMs: 60_000, failureThreshold },
      {
        onTelegram: (telegram) => received.push(telegram),
        onFailure,
        onRecovery,
      },
    );

  // start() は初回ポーリングを非同期に走らせるため、完了を待つ
  const drain = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };

  beforeEach(() => {
    jest.useFakeTimers();
    received = [];
    onFailure = jest.fn();
    onRecovery = jest.fn();
    get = jest.fn();
    (axios.create as jest.Mock).mockReturnValue({ get });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("起動直後は既読化のみで過去の電文を配信しない", async () => {
    respondWith(feedXml([{ code: "VXSE53", stamp: "1000" }]));
    const receiver = newReceiver();
    receiver.start();
    await drain();
    receiver.stop();

    expect(received).toHaveLength(0);
  });

  it("2回目以降は新着の電文だけを配信する", async () => {
    respondWith(feedXml([{ code: "VXSE53", stamp: "1000" }]));
    const receiver = newReceiver();
    receiver.start();
    await drain();

    // 新しいエントリが1件増えた
    respondWith(
      feedXml([
        { code: "VTSE41", stamp: "2000" },
        { code: "VXSE53", stamp: "1000" },
      ]),
    );
    jest.advanceTimersByTime(60_000);
    await drain();
    receiver.stop();

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("VTSE41");
    expect(received[0].report.head.eventId).toBe("20260728174504");
  });

  it("同じ電文を二度配信しない", async () => {
    respondWith(feedXml([{ code: "VXSE53", stamp: "1000" }]));
    const receiver = newReceiver();
    receiver.start();
    await drain();

    const updated = feedXml([
      { code: "VTSE41", stamp: "2000" },
      { code: "VXSE53", stamp: "1000" },
    ]);
    respondWith(updated);
    jest.advanceTimersByTime(60_000);
    await drain();
    // 内容が変わらないまま次の周期
    jest.advanceTimersByTime(60_000);
    await drain();
    receiver.stop();

    expect(received).toHaveLength(1);
  });

  it("新着が複数あるときは古い順に配信する", async () => {
    respondWith(feedXml([{ code: "VXSE53", stamp: "1000" }]));
    const receiver = newReceiver();
    receiver.start();
    await drain();

    // フィードは新しい順に並ぶ
    respondWith(
      feedXml([
        { code: "VXSE51", stamp: "3000" },
        { code: "VTSE41", stamp: "2000" },
        { code: "VXSE53", stamp: "1000" },
      ]),
    );
    jest.advanceTimersByTime(60_000);
    await drain();
    receiver.stop();

    expect(received.map((telegram) => telegram.type)).toEqual([
      "VTSE41",
      "VXSE51",
    ]);
  });

  it("304 が返ったときは何もしない", async () => {
    respondWith(feedXml([{ code: "VXSE53", stamp: "1000" }]));
    const receiver = newReceiver();
    receiver.start();
    await drain();

    respondWith("", 304);
    jest.advanceTimersByTime(60_000);
    await drain();
    receiver.stop();

    expect(received).toHaveLength(0);
  });

  it("2回目以降は条件付きリクエストを送る", async () => {
    respondWith(feedXml([{ code: "VXSE53", stamp: "1000" }]));
    const receiver = newReceiver();
    receiver.start();
    await drain();
    jest.advanceTimersByTime(60_000);
    await drain();
    receiver.stop();

    const secondCall = get.mock.calls.filter((call) => call[0] === FEED)[1];
    expect(secondCall[1].headers["If-None-Match"]).toBe('"v1"');
  });

  it("電文の取得に失敗した分は次の周期で再試行する", async () => {
    respondWith(feedXml([{ code: "VXSE53", stamp: "1000" }]));
    const receiver = newReceiver();
    receiver.start();
    await drain();

    const updated = feedXml([
      { code: "VTSE41", stamp: "2000" },
      { code: "VXSE53", stamp: "1000" },
    ]);
    // 電文の取得だけ失敗させる
    get.mockImplementation(async (url: string) => {
      if (url === FEED) return { status: 200, data: updated, headers: {} };
      throw new Error("telegram fetch failed");
    });
    jest.advanceTimersByTime(60_000);
    await drain();
    expect(received).toHaveLength(0);

    // 次の周期では取得できる
    respondWith(updated);
    jest.advanceTimersByTime(60_000);
    await drain();
    receiver.stop();

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("VTSE41");
  });

  it("連続失敗が閾値に達すると1度だけ通知し、復旧を知らせる", async () => {
    get.mockRejectedValue(new Error("network down"));
    const receiver = newReceiver(2);
    receiver.start();
    await drain();
    jest.advanceTimersByTime(60_000);
    await drain();
    expect(onFailure).toHaveBeenCalledTimes(1);

    // 失敗が続いても通知は増やさない
    jest.advanceTimersByTime(60_000);
    await drain();
    expect(onFailure).toHaveBeenCalledTimes(1);

    respondWith(feedXml([{ code: "VXSE53", stamp: "1000" }]));
    jest.advanceTimersByTime(60_000);
    await drain();
    receiver.stop();

    expect(onRecovery).toHaveBeenCalledTimes(1);
  });

  it("stop 後はポーリングしない", async () => {
    respondWith(feedXml([{ code: "VXSE53", stamp: "1000" }]));
    const receiver = newReceiver();
    receiver.start();
    await drain();
    const callsBefore = get.mock.calls.length;

    receiver.stop();
    jest.advanceTimersByTime(180_000);
    await drain();

    expect(get.mock.calls.length).toBe(callsBefore);
  });
});
