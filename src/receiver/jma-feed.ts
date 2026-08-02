import axios, { type AxiosInstance } from "axios";
import { logger } from "../logger.js";
import type { FeedCursorStore } from "./feed-cursor.js";
import {
  type JmaReport,
  parseFeed,
  parseTelegram,
  telegramTypeFromUrl,
} from "./jma-xml.js";

export interface JmaTelegram {
  // Atom の <id>。気象庁では電文 XML の URL が入るため一意キーになる
  id: string;
  // 電文種別コード (VXSE53 / VTSE41 など)
  type: string | null;
  title: string;
  updatedAt: Date;
  url: string;
  report: JmaReport;
}

export interface JmaFeedEvents {
  onTelegram: (telegram: JmaTelegram) => void;
  // 連続失敗が閾値に達したときに1度だけ呼ばれる
  onFailure: (message: string, err: unknown) => void;
  onRecovery?: (message: string) => void;
}

export interface JmaFeedOptions {
  feeds: string[];
  intervalMs?: number;
  // 何回連続で失敗したら通知するか
  failureThreshold?: number;
  userAgent?: string;
  // 再起動をまたいで処理済みを保つ。省略すると毎回既読化から始まる。
  cursors?: FeedCursorStore;
  // カーソルがこれより古ければ復元しない。長時間の停止では
  // フィードが入れ替わっており、古い電文を流しても意味がないため。
  cursorMaxAgeMs?: number;
  // 1回の追いつきで配信する上限。再起動直後の大量投稿を防ぐ。
  maxCatchUp?: number;
}

interface FeedState {
  etag?: string;
  lastModified?: string;
  // 処理済みの entry id。毎回フィード掲載分に絞り込むため無限に増えない
  seen: Set<string>;
  // 起動直後の1回目は既読化のみ行い、過去の電文を流さない
  primed: boolean;
}

// 気象庁の Atom フィードを定期取得し、新着の電文だけを取り出す取得層。
// 配信側のことは知らない。
export class JmaFeedReceiver {
  private states = new Map<string, FeedState>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = false;
  private consecutiveFailures = 0;
  private notified = false;
  private http: AxiosInstance;
  private readonly intervalMs: number;
  private readonly failureThreshold: number;
  private readonly cursorMaxAgeMs: number;
  private readonly maxCatchUp: number;

  constructor(
    private options: JmaFeedOptions,
    private events: JmaFeedEvents,
  ) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cursorMaxAgeMs = options.cursorMaxAgeMs ?? 60 * 60_000;
    this.maxCatchUp = options.maxCatchUp ?? 100;
    this.http = axios.create({
      timeout: 20_000,
      // 気象庁のサーバに対して識別可能な UA を送る
      headers: { "User-Agent": options.userAgent ?? "eew2nostr (+bot)" },
      // 304 を例外にしない
      validateStatus: (status) =>
        status === 304 || (status >= 200 && status < 300),
      responseType: "text",
      transformResponse: [(data) => data],
    });
    for (const feed of options.feeds) {
      this.states.set(feed, { seen: new Set(), primed: false });
    }
  }

  // 保存しておいたカーソルから再開する。
  // 呼ばずに start() すると、これまでどおり既読化から始まる。
  async restore(): Promise<void> {
    const store = this.options.cursors;
    if (!store) return;
    for (const feed of this.options.feeds) {
      const state = this.states.get(feed);
      const cursor = await store.load(feed);
      if (!state || !cursor) continue;
      const age = Date.now() - new Date(cursor.updatedAt).getTime();
      if (Number.isNaN(age) || age > this.cursorMaxAgeMs) {
        logger.info("カーソルが古いため既読化から始めます", {
          feed,
          updatedAt: cursor.updatedAt,
        });
        continue;
      }
      state.seen = new Set(cursor.seen);
      state.primed = true;
      logger.info("カーソルから再開します", {
        feed,
        seen: cursor.seen.length,
        updatedAt: cursor.updatedAt,
      });
    }
  }

  start(): void {
    this.stopped = false;
    logger.info("jma feed polling start", {
      feeds: this.options.feeds,
      intervalMs: this.intervalMs,
    });
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), this.intervalMs);
  }

  private async tick(): Promise<void> {
    // 前回のポーリングが終わる前に次を始めない
    if (this.polling) return;
    this.polling = true;
    try {
      await this.poll();
      this.onSuccess();
    } catch (e) {
      this.onFailure(e);
    } finally {
      this.polling = false;
      this.schedule();
    }
  }

  private onSuccess(): void {
    if (this.notified && this.events.onRecovery) {
      this.events.onRecovery("気象庁フィードの取得が復旧しました。");
    }
    this.consecutiveFailures = 0;
    this.notified = false;
  }

  private onFailure(e: unknown): void {
    this.consecutiveFailures += 1;
    logger.error("jma feed poll failed", {
      err: e,
      consecutiveFailures: this.consecutiveFailures,
    });
    if (this.consecutiveFailures >= this.failureThreshold && !this.notified) {
      this.notified = true;
      this.events.onFailure(
        `気象庁フィードの取得に${this.consecutiveFailures}回連続で失敗しました。`,
        e,
      );
    }
  }

  // フィードは新しい順に並ぶため、古い順に直して続報の順序を保つ
  private async poll(): Promise<void> {
    for (const feed of this.options.feeds) {
      await this.pollFeed(feed);
    }
  }

  private async pollFeed(feed: string): Promise<void> {
    const state = this.states.get(feed);
    if (!state) return;

    const headers: Record<string, string> = {};
    if (state.etag) headers["If-None-Match"] = state.etag;
    if (state.lastModified) headers["If-Modified-Since"] = state.lastModified;

    const response = await this.http.get<string>(feed, { headers });
    if (response.status === 304) return;

    state.etag = response.headers.etag as string | undefined;
    state.lastModified = response.headers["last-modified"] as
      | string
      | undefined;

    const entries = parseFeed(response.data).filter((entry) => entry.id);
    const feedIds = new Set(entries.map((entry) => entry.id));

    if (!state.primed) {
      // 起動直後は既読化のみ。過去の電文を配信しない
      state.primed = true;
      state.seen = feedIds;
      logger.info("jma feed primed", { feed, entries: entries.length });
      return;
    }

    let fresh = entries.filter((entry) => !state.seen.has(entry.id)).reverse();
    // 停止が長引いた場合に大量投稿が起きないよう、1回の追いつきを制限する
    if (fresh.length > this.maxCatchUp) {
      const skipped = fresh.slice(0, fresh.length - this.maxCatchUp);
      logger.warn("新着が多いため古い分を配信せず既読にします", {
        feed,
        skipped: skipped.length,
        delivered: this.maxCatchUp,
      });
      for (const entry of skipped) state.seen.add(entry.id);
      fresh = fresh.slice(-this.maxCatchUp);
    }
    const processed = new Set(state.seen);
    for (const entry of fresh) {
      try {
        const telegram = await this.http.get<string>(entry.url);
        this.events.onTelegram({
          id: entry.id,
          type: telegramTypeFromUrl(entry.url),
          title: entry.title,
          updatedAt: new Date(entry.updated),
          url: entry.url,
          report: parseTelegram(telegram.data),
        });
        processed.add(entry.id);
      } catch (e) {
        // 取得できなかった電文は既読にせず、次の周期で再試行する
        logger.error("failed to fetch telegram", { url: entry.url, err: e });
      }
    }
    // フィードから消えた分は取り除き、既読集合を有界に保つ
    state.seen = new Set([...processed].filter((id) => feedIds.has(id)));
    await this.options.cursors?.save(feed, [...state.seen]);
  }
}
