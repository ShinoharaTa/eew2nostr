import type { ResolvedAccount } from "../routing/router.js";

export interface SystemState {
  // dmdata の資格情報が設定されているか
  dmdata: boolean;
  jmaFeeds: string[];
  statusDbPath: string;
  accounts: ResolvedAccount[];
  discordConfigured: boolean;
}

const mark = (ok: boolean): string => (ok ? "✅" : "—");

// 配信できる経路を「nostr / bluesky」のように並べる。
// 何も設定されていなければ、投稿せずコンソールに出すことを明示する。
const routes = (account: ResolvedAccount): string => {
  const enabled = [
    account.nostr ? "nostr" : null,
    account.bluesky ? "bluesky" : null,
    account.concrnt ? "concrnt" : null,
  ].filter((name): name is string => name !== null);
  return enabled.length > 0
    ? enabled.join(" / ")
    : "未設定 (投稿せずコンソールに出力)";
};

// 起動時に何が設定されていて何が動くのかを一覧にする。
// 「起動したが動いているか分からない」状態を避けるため、
// 起動直後にこの内容を通知とコンソールの両方へ出す。
export const startupSummary = (state: SystemState): string => {
  const lines: string[] = [];
  lines.push(`${mark(state.dmdata)} 緊急地震速報 (dmdata)`);
  lines.push(`✅ 気象庁フィード ${state.jmaFeeds.length}件を1分間隔で取得`);
  for (const feed of state.jmaFeeds) {
    lines.push(`　　・${feed.split("/").pop()}`);
  }
  lines.push(`✅ ステータス保存先 ${state.statusDbPath}`);
  lines.push("");
  lines.push("配信先");
  for (const account of state.accounts) {
    lines.push(
      `　${mark(hasAny(account))} ${account.label} … ${routes(account)}`,
    );
  }
  return lines.join("\n");
};

const hasAny = (account: ResolvedAccount): boolean =>
  account.nostr || account.bluesky || account.concrnt;

export interface Counters {
  receivedDmdata: number;
  receivedJma: number;
  recorded: number;
  delivered: number;
  failures: number;
}

export const newCounters = (): Counters => ({
  receivedDmdata: 0,
  receivedJma: 0,
  recorded: 0,
  delivered: 0,
  failures: 0,
});

const duration = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}日${hours % 24}時間`;
  if (hours > 0) return `${hours}時間${minutes % 60}分`;
  return `${minutes}分`;
};

// 稼働していることを定期的に伝える。
// 何も起きない時間が続くと、動いているのか止まっているのか分からないため。
export const heartbeatSummary = (
  counters: Counters,
  startedAt: Date,
  now: Date = new Date(),
): string =>
  [
    `稼働時間 ${duration(now.getTime() - startedAt.getTime())}`,
    `受信 緊急地震速報 ${counters.receivedDmdata}件 / 気象庁 ${counters.receivedJma}件`,
    `記録 ${counters.recorded}件 / 配信 ${counters.delivered}件 / 失敗 ${counters.failures}件`,
  ].join("\n");
