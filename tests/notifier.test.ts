import axios from "axios";
import { Notifier } from "../src/notifier/notifier";
import {
  heartbeatSummary,
  newCounters,
  startupSummary,
} from "../src/notifier/status-report";
import type { ResolvedAccount } from "../src/routing/router";

jest.mock("axios");

const account = (
  key: string,
  label: string,
  nostr = false,
  bluesky = false,
  concrnt = false,
): ResolvedAccount => ({ key, label, nostr, bluesky, concrnt });

describe("Notifier", () => {
  beforeEach(() => {
    (axios.post as jest.Mock).mockReset().mockResolvedValue({ status: 204 });
  });

  it("設定されていれば Discord へ送り、届いたことを返す", async () => {
    const result = await new Notifier("https://hook.test").notify(
      "success",
      "起動しました",
    );
    expect(result).toEqual({ delivered: true, reason: null });
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it("本文に見出しと詳細を含める", async () => {
    await new Notifier("https://hook.test").notify("info", "件名", "詳細");
    const body = (axios.post as jest.Mock).mock.calls[0][1];
    expect(body.content).toContain("件名");
    expect(body.content).toContain("詳細");
  });

  // Discord が届かない状況でも、サーバのログだけで状況を追えるようにする
  it("未設定でも例外にせず、理由を返す", async () => {
    const result = await new Notifier("").notify("info", "件名");
    expect(result.delivered).toBe(false);
    expect(result.reason).toContain("未設定");
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("送信に失敗しても例外にせず、理由を返す", async () => {
    (axios.post as jest.Mock).mockRejectedValue(new Error("404"));
    const result = await new Notifier("https://hook.test").notify(
      "error",
      "件名",
    );
    expect(result.delivered).toBe(false);
    expect(result.reason).toContain("404");
  });

  it("設定の有無を判定できる", () => {
    expect(new Notifier("https://hook.test").isConfigured()).toBe(true);
    expect(new Notifier("").isConfigured()).toBe(false);
  });
});

describe("startupSummary", () => {
  const state = {
    dmdata: true,
    jmaFeeds: ["https://example.test/eqvol.xml"],
    statusDbPath: "./data/status.db",
    discordConfigured: true,
    accounts: [
      account("eew", "緊急地震速報", true, false, false),
      account("warning", "警報"),
    ],
  };

  it("何が動くのかを一覧にする", () => {
    const summary = startupSummary(state);
    expect(summary).toContain("緊急地震速報 (dmdata)");
    expect(summary).toContain("eqvol.xml");
    expect(summary).toContain("./data/status.db");
  });

  it("配信できる経路を示す", () => {
    expect(startupSummary(state)).toContain("緊急地震速報 … nostr");
  });

  // 鍵が無い配信先は投稿されないことを明示する
  it("未設定の配信先はコンソール出力と分かるようにする", () => {
    expect(startupSummary(state)).toContain(
      "警報 … 未設定 (投稿せずコンソールに出力)",
    );
  });

  it("dmdata が未設定なら印を変える", () => {
    const summary = startupSummary({ ...state, dmdata: false });
    expect(summary).toContain("— 緊急地震速報 (dmdata)");
  });
});

describe("heartbeatSummary", () => {
  it("稼働時間と件数を出す", () => {
    const counters = { ...newCounters(), receivedJma: 3, recorded: 5 };
    const started = new Date("2026-08-04T00:00:00Z");
    const now = new Date("2026-08-04T02:30:00Z");
    const summary = heartbeatSummary(counters, started, now);
    expect(summary).toContain("2時間30分");
    expect(summary).toContain("気象庁 3件");
    expect(summary).toContain("記録 5件");
  });

  it("1時間未満は分で出す", () => {
    const summary = heartbeatSummary(
      newCounters(),
      new Date("2026-08-04T00:00:00Z"),
      new Date("2026-08-04T00:20:00Z"),
    );
    expect(summary).toContain("20分");
  });
});
