import * as fs from "node:fs";
import * as path from "node:path";
import { EEWParser } from "../src/core/parser";
import {
  type BskyPort,
  type ConcrntPort,
  type NostrPort,
  type NotifierPort,
  PublishDispatcher,
} from "../src/publisher/dispatcher";
import { SqliteStatusStore } from "../src/store/sqlite-store";
import { StatusManager } from "../src/store/status-manager";
import type { JsonSchema } from "../src/types/eew";

const loadSample = (): JsonSchema =>
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../sampleData/eew_single..json"),
      "utf-8",
    ),
  );

const telegramWithSerial = (serial: string): JsonSchema => ({
  ...loadSample(),
  serialNo: serial,
});

describe("PublishDispatcher", () => {
  let nostr: jest.Mocked<NostrPort>;
  let bsky: jest.Mocked<BskyPort>;
  let concrnt: jest.Mocked<ConcrntPort>;
  let notifier: jest.Mocked<NotifierPort>;
  let status: StatusManager;
  let dispatcher: PublishDispatcher;

  beforeEach(async () => {
    let nostrCount = 0;
    let bskyCount = 0;
    nostr = {
      publishNote: jest
        .fn()
        .mockImplementation(async () => `note-${++nostrCount}`),
      publishRaw: jest.fn().mockResolvedValue("raw-id"),
    };
    bsky = {
      publish: jest.fn().mockImplementation(async () => {
        bskyCount += 1;
        return { cid: `cid-${bskyCount}`, uri: `uri-${bskyCount}` };
      }),
    };
    concrnt = {
      publish: jest.fn().mockResolvedValue({ id: "concrnt-1" }),
    };
    notifier = {
      notify: jest.fn().mockResolvedValue(undefined),
    };
    const store = new SqliteStatusStore(":memory:");
    await store.init();
    status = new StatusManager(store, { mirror: jest.fn() });
    await status.init();
    dispatcher = new PublishDispatcher(
      new EEWParser(),
      nostr,
      bsky,
      concrnt,
      notifier,
      status,
    );
  });

  it("同一イベントの続報は前の投稿へのリプライとして繋がる", async () => {
    await dispatcher.handle(telegramWithSerial("1"));
    await dispatcher.handle(telegramWithSerial("2"));
    await dispatcher.handle(telegramWithSerial("3"));
    await dispatcher.flush();

    expect(nostr.publishNote).toHaveBeenCalledTimes(3);
    expect(nostr.publishNote.mock.calls[0][0].reply).toBeUndefined();
    expect(nostr.publishNote.mock.calls[1][0].reply).toEqual({
      root: "note-1",
      parent: null,
    });
    expect(nostr.publishNote.mock.calls[2][0].reply).toEqual({
      root: "note-1",
      parent: "note-2",
    });

    expect(bsky.publish).toHaveBeenCalledTimes(3);
    expect(bsky.publish.mock.calls[0][1]).toBeUndefined();
    expect(bsky.publish.mock.calls[1][1]).toEqual({
      root: { cid: "cid-1", uri: "uri-1" },
      parent: { cid: "cid-1", uri: "uri-1" },
    });
    expect(bsky.publish.mock.calls[2][1]).toEqual({
      root: { cid: "cid-1", uri: "uri-1" },
      parent: { cid: "cid-2", uri: "uri-2" },
    });

    expect(concrnt.publish).toHaveBeenCalledTimes(3);
    expect(concrnt.publish.mock.calls[0][1]).toBeUndefined();
    expect(concrnt.publish.mock.calls[1][1]).toEqual({ root: "concrnt-1" });

    expect(nostr.publishRaw).toHaveBeenCalledTimes(3);
  });

  it("投稿失敗は1回リトライして成功すればツリーを継続する", async () => {
    bsky.publish
      .mockRejectedValueOnce(new Error("temporary error"))
      .mockResolvedValueOnce({ cid: "cid-r", uri: "uri-r" });

    await dispatcher.handle(telegramWithSerial("1"));
    await dispatcher.handle(telegramWithSerial("2"));
    await dispatcher.flush();

    // 1報目: 失敗 + リトライ成功、2報目: 成功 = 計3回
    expect(bsky.publish).toHaveBeenCalledTimes(3);
    expect(bsky.publish.mock.calls[2][1]).toEqual({
      root: { cid: "cid-r", uri: "uri-r" },
      parent: { cid: "cid-r", uri: "uri-r" },
    });
    // リトライで成功した場合は通知しない
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it("リトライも失敗してスキップした報は Discord に通知される", async () => {
    bsky.publish.mockRejectedValue(new Error("bsky down"));

    await dispatcher.handle(telegramWithSerial("1"));
    await dispatcher.flush();

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    const [level, title, detail] = notifier.notify.mock.calls[0];
    expect(level).toBe("error");
    expect(title).toContain("[bluesky]");
    expect(detail).toContain("eew:20240109012003");
  });

  it("投稿が全滅してもステータスは記録される", async () => {
    nostr.publishNote.mockRejectedValue(new Error("nostr down"));
    bsky.publish.mockRejectedValue(new Error("bsky down"));
    concrnt.publish.mockRejectedValue(new Error("concrnt down"));

    await dispatcher.handle(telegramWithSerial("1"));
    await dispatcher.flush();

    const record = status.get("eew:20240109012003");
    expect(record).toBeDefined();
    expect(record?.category).toBe("eew");
    expect(record?.headline).toContain("石川県能登地方");
    expect(record?.posts).toEqual({});
  });

  it("続報中は active、最終報でステータスが finalized になる", async () => {
    const telegram = loadSample();
    const ongoing = {
      ...telegram,
      serialNo: "1",
      body: { ...telegram.body, isLastInfo: false },
    } as JsonSchema;

    await dispatcher.handle(ongoing);
    expect(status.get("eew:20240109012003")?.status).toBe("active");
    expect(status.get("eew:20240109012003")?.serial).toBe("1");

    await dispatcher.handle({
      ...telegram,
      serialNo: "2",
      reportDateTime: "2024-01-09T01:21:30+09:00",
    });
    const record = status.get("eew:20240109012003");
    expect(record?.status).toBe("finalized");
    expect(record?.serial).toBe("2");
    // 発表時刻は初報のまま、更新時刻だけが進む
    expect(record?.publishedAt).toBe(
      new Date("2024-01-09T01:20:44+09:00").toISOString(),
    );
    expect(record?.updatedAt).toBe(
      new Date("2024-01-09T01:21:30+09:00").toISOString(),
    );
    await dispatcher.flush();
  });

  it("リトライも失敗した報はスキップし、次の報は最後に成功した投稿へ繋ぐ", async () => {
    let count = 0;
    bsky.publish.mockImplementation(async () => {
      count += 1;
      // 1報目は成功、2報目は2回とも失敗、3報目は成功
      if (count === 2 || count === 3) throw new Error("permanent error");
      return { cid: `cid-${count}`, uri: `uri-${count}` };
    });

    await dispatcher.handle(telegramWithSerial("1"));
    await dispatcher.handle(telegramWithSerial("2"));
    await dispatcher.handle(telegramWithSerial("3"));
    await dispatcher.flush();

    // 1報目成功(1回) + 2報目失敗(2回) + 3報目成功(1回) = 4回
    expect(bsky.publish).toHaveBeenCalledTimes(4);
    // 3報目の親は 2報目ではなく 1報目(最後に成功した投稿)
    expect(bsky.publish.mock.calls[3][1]).toEqual({
      root: { cid: "cid-1", uri: "uri-1" },
      parent: { cid: "cid-1", uri: "uri-1" },
    });
  });

  it("1つのSNSの障害が他のSNSの投稿を止めない", async () => {
    bsky.publish.mockRejectedValue(new Error("bsky down"));

    await dispatcher.handle(telegramWithSerial("1"));
    await dispatcher.handle(telegramWithSerial("2"));
    await dispatcher.flush();

    expect(nostr.publishNote).toHaveBeenCalledTimes(2);
    expect(concrnt.publish).toHaveBeenCalledTimes(2);
    expect(nostr.publishNote.mock.calls[1][0].reply).toEqual({
      root: "note-1",
      parent: null,
    });
  });

  it("キャンセル電文や eventId 無しは投稿しない", async () => {
    const telegram = loadSample();
    await dispatcher.handle({
      ...telegram,
      body: { ...telegram.body, earthquake: undefined },
    } as JsonSchema);
    await dispatcher.handle({ ...telegram, eventId: null });
    await dispatcher.flush();

    expect(nostr.publishNote).not.toHaveBeenCalled();
    expect(bsky.publish).not.toHaveBeenCalled();
    expect(concrnt.publish).not.toHaveBeenCalled();
  });
  // 以前は取消が捨てられており、取り消された速報が残ったままだった
  describe("取消報", () => {
    it("投稿済みのスレッドへ取消を伝える", async () => {
      await dispatcher.handle(telegramWithSerial("1"));
      await dispatcher.flush();
      const posted = nostr.publishNote.mock.calls.length;

      await dispatcher.handle({ ...loadSample(), infoType: "取消" });
      await dispatcher.flush();

      expect(nostr.publishNote.mock.calls.length).toBe(posted + 1);
      const last = nostr.publishNote.mock.calls.at(-1)?.[0];
      expect(last?.content).toContain("取り消されました");
      // 元の投稿への返信になる
      expect(last?.reply).toEqual({ root: "note-1", parent: null });
    });

    it("状態を cancelled にする", async () => {
      await dispatcher.handle(telegramWithSerial("1"));
      await dispatcher.flush();
      await dispatcher.handle({ ...loadSample(), infoType: "取消" });
      await dispatcher.flush();

      expect(status.get("eew:20240109012003")?.status).toBe("cancelled");
    });

    // 取り消す対象が流れていないのに「取り消されました」だけ出ると混乱する
    it("投稿していないイベントの取消は投稿しない", async () => {
      await dispatcher.handle({ ...loadSample(), infoType: "取消" });
      await dispatcher.flush();

      expect(nostr.publishNote).not.toHaveBeenCalled();
    });

    it("最終報のあとの取消も投稿する", async () => {
      // フィクスチャは isLastInfo が true なので最終報として記録される
      await dispatcher.handle(telegramWithSerial("1"));
      await dispatcher.flush();
      expect(status.get("eew:20240109012003")?.status).toBe("finalized");

      await dispatcher.handle({ ...loadSample(), infoType: "取消" });
      await dispatcher.flush();

      expect(nostr.publishNote.mock.calls.at(-1)?.[0].content).toContain(
        "取り消されました",
      );
    });
  });
});
