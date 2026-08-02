import type { ReplyRef } from "@atproto/api/dist/client/types/app/bsky/feed/post";
import type { EEWParser } from "../core/parser.js";
import { SerialQueue } from "../core/serial-queue.js";
import {
  applyEEWReport,
  eewStatusKey,
  initialEEWRecord,
} from "../core/status.js";
import { logger } from "../logger.js";
import type { StatusManager } from "../store/status-manager.js";
import type { JsonSchema } from "../types/eew";

// 各SNSクライアントに求める最小限のインターフェース(テスト時は差し替え可能)
export interface NostrPort {
  publishNote(params: {
    content: string;
    time: Date;
    reply?: { root: string | null; parent: string | null };
  }): Promise<string>;
  publishRaw(content: string, time: Date): Promise<string>;
}

export interface NotifierPort {
  notify(message: string): Promise<void>;
}

export interface BskyPort {
  publish(
    content: string,
    reply?: ReplyRef,
  ): Promise<{ cid: string; uri: string }>;
}

export interface ConcrntPort {
  publish(
    body: string,
    root?: { root: string },
  ): Promise<{ id: string } | null>;
}

// 電文を受け取り、状態を記録したうえでSNSごとの直列キューに投稿ジョブを積む配信層。
// SNS間は並列(キューが独立)、SNS内は直列で順序とリプライツリーを保証する。
// 失敗時は1回だけ即リトライし、それも失敗したらその報はスキップして次へ進む。
export class PublishDispatcher {
  private queues = {
    nostr: new SerialQueue(),
    bsky: new SerialQueue(),
    concrnt: new SerialQueue(),
  };

  constructor(
    private parser: EEWParser,
    private nostr: NostrPort,
    private bsky: BskyPort,
    private concrnt: ConcrntPort,
    private notifier: NotifierPort,
    private status: StatusManager,
  ) {}

  async handle(telegram: JsonSchema): Promise<void> {
    const parsed = this.parser.parse(telegram);
    if (parsed.type === "ignore") return;
    if (parsed.type === "cancelled") {
      await this.handleCancel(parsed.id);
      return;
    }
    const report = parsed.report;
    const key = eewStatusKey(report.id);
    const message = this.parser.generateEEWMessage(report);

    // 投稿を試みる前に状態を確定させる。投稿が全滅しても記録は残る。
    await this.status.upsert(initialEEWRecord(report), (record) =>
      applyEEWReport(record, report),
    );

    this.queues.nostr.push(() =>
      this.withRetry("nostr", key, async () => {
        const reply = this.status.get(key)?.posts.nostr;
        const eventId = await this.nostr.publishNote({
          content: message,
          time: report.reportTime,
          reply: reply ? { ...reply } : undefined,
        });
        await this.status.update(key, (record) => {
          if (record.posts.nostr) record.posts.nostr.parent = eventId;
          else record.posts.nostr = { root: eventId, parent: null };
        });
      }),
    );
    // 生電文の kind 7078 はリプライツリーと無関係なので別ジョブとして積む
    this.queues.nostr.push(() =>
      this.withRetry("nostr(raw)", key, async () => {
        await this.nostr.publishRaw(
          JSON.stringify(telegram),
          report.reportTime,
        );
      }),
    );

    this.queues.bsky.push(() =>
      this.withRetry("bluesky", key, async () => {
        const reply = this.status.get(key)?.posts.bluesky;
        const result = await this.bsky.publish(
          message,
          reply ? { ...reply } : undefined,
        );
        await this.status.update(key, (record) => {
          if (record.posts.bluesky) record.posts.bluesky.parent = result;
          else record.posts.bluesky = { root: result, parent: result };
        });
      }),
    );

    this.queues.concrnt.push(() =>
      this.withRetry("concrnt", key, async () => {
        const root = this.status.get(key)?.posts.concrnt;
        const result = await this.concrnt.publish(message, root);
        if (result) {
          await this.status.update(key, (record) => {
            record.posts.concrnt = { root: result.id };
          });
        }
      }),
    );
  }

  // 取消報。既に投稿したスレッドへ取消を伝える。
  //
  // 投稿済みのスレッドが無い場合は投稿しない。取り消す対象が
  // 流れていないのに「取り消されました」だけが出ると混乱を招くため。
  // 最終報まで出した後の取消でも、取り消された事実のほうが重要なので投稿する。
  private async handleCancel(id: string): Promise<void> {
    const key = eewStatusKey(id);
    const record = this.status.get(key);
    if (!record) {
      logger.info("取消報を受信しましたが対象の記録がありません", { key });
      return;
    }
    await this.status.update(key, (target) => {
      target.status = "cancelled";
      target.headline = "緊急地震速報 取消";
    });

    const message = this.parser.generateCancelMessage();
    if (record.posts.nostr) {
      this.queues.nostr.push(() =>
        this.withRetry("nostr(cancel)", key, async () => {
          const reply = this.status.get(key)?.posts.nostr;
          const eventId = await this.nostr.publishNote({
            content: message,
            time: new Date(),
            reply: reply ? { ...reply } : undefined,
          });
          await this.status.update(key, (target) => {
            if (target.posts.nostr) target.posts.nostr.parent = eventId;
          });
        }),
      );
    }
    if (record.posts.bluesky) {
      this.queues.bsky.push(() =>
        this.withRetry("bluesky(cancel)", key, async () => {
          const reply = this.status.get(key)?.posts.bluesky;
          const result = await this.bsky.publish(
            message,
            reply ? { ...reply } : undefined,
          );
          await this.status.update(key, (target) => {
            if (target.posts.bluesky) target.posts.bluesky.parent = result;
          });
        }),
      );
    }
    if (record.posts.concrnt) {
      this.queues.concrnt.push(() =>
        this.withRetry("concrnt(cancel)", key, async () => {
          await this.concrnt.publish(
            message,
            this.status.get(key)?.posts.concrnt,
          );
        }),
      );
    }
  }

  // 積まれた全ジョブの完了を待つ(テスト・シャットダウン用)
  async flush(): Promise<void> {
    await Promise.all([
      this.queues.nostr.idle(),
      this.queues.bsky.idle(),
      this.queues.concrnt.idle(),
    ]);
    await this.status.flush();
  }

  private async withRetry(
    sns: string,
    key: string,
    job: () => Promise<void>,
  ): Promise<void> {
    try {
      await job();
    } catch (firstError) {
      logger.warn(`[${sns}] post failed, retrying`, { key, err: firstError });
      try {
        await job();
      } catch (retryError) {
        logger.error(`[${sns}] retry failed, skip this report`, {
          key,
          err: retryError,
        });
        await this.notifier.notify(
          `🚨 [${sns}] 投稿に失敗しました (${key})。リトライも失敗したためこの報はスキップします。\n${retryError}`,
        );
      }
    }
  }
}
