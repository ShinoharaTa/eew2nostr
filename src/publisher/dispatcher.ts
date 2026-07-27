import type { ReplyRef } from "@atproto/api/dist/client/types/app/bsky/feed/post";
import type { EEWParser } from "../core/parser.js";
import { SerialQueue } from "../core/serial-queue.js";
import { logger } from "../logger.js";
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

interface PostObject {
  nostr?: { root: string | null; parent: string | null };
  bluesky?: ReplyRef;
  concrnt?: { root: string };
}

// 電文を受け取り、SNSごとの直列キューに投稿ジョブを積む配信層。
// SNS間は並列(キューが独立)、SNS内は直列で順序とリプライツリーを保証する。
// 失敗時は1回だけ即リトライし、それも失敗したらその報はスキップして次へ進む。
export class PublishDispatcher {
  private posts = new Map<string, PostObject>();
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
  ) {}

  handle(telegram: JsonSchema): void {
    const report = this.parser.objectMapping(telegram);
    if (report === "cancel") return;
    if (!report.id) return;
    const id = report.id;
    const message = this.parser.generateEEWMessage(report);

    this.queues.nostr.push(() =>
      this.withRetry("nostr", id, async () => {
        const postInfo = this.getPost(id);
        const eventId = await this.nostr.publishNote({
          content: message,
          time: report.reportTime,
          reply: postInfo.nostr ? { ...postInfo.nostr } : undefined,
        });
        if (postInfo.nostr) postInfo.nostr.parent = eventId;
        else postInfo.nostr = { root: eventId, parent: null };
      }),
    );
    // 生電文の kind 7078 はリプライツリーと無関係なので別ジョブとして積む
    this.queues.nostr.push(() =>
      this.withRetry("nostr(raw)", id, async () => {
        await this.nostr.publishRaw(
          JSON.stringify(telegram),
          report.reportTime,
        );
      }),
    );

    this.queues.bsky.push(() =>
      this.withRetry("bluesky", id, async () => {
        const postInfo = this.getPost(id);
        const result = await this.bsky.publish(
          message,
          postInfo.bluesky ? { ...postInfo.bluesky } : undefined,
        );
        if (postInfo.bluesky) postInfo.bluesky.parent = result;
        else postInfo.bluesky = { root: result, parent: result };
      }),
    );

    this.queues.concrnt.push(() =>
      this.withRetry("concrnt", id, async () => {
        const postInfo = this.getPost(id);
        const result = await this.concrnt.publish(message, postInfo.concrnt);
        if (result) postInfo.concrnt = { root: result.id };
      }),
    );
  }

  // 積まれた全ジョブの完了を待つ(テスト・シャットダウン用)
  async flush(): Promise<void> {
    await Promise.all([
      this.queues.nostr.idle(),
      this.queues.bsky.idle(),
      this.queues.concrnt.idle(),
    ]);
  }

  private getPost(id: string): PostObject {
    const existing = this.posts.get(id);
    if (existing) return existing;
    const created: PostObject = {};
    this.posts.set(id, created);
    return created;
  }

  private async withRetry(
    sns: string,
    id: string,
    job: () => Promise<void>,
  ): Promise<void> {
    try {
      await job();
    } catch (firstError) {
      logger.error(`[${sns}] post failed (eventId=${id}), retrying`);
      logger.error(firstError);
      try {
        await job();
      } catch (retryError) {
        logger.error(`[${sns}] retry failed (eventId=${id}), skip this report`);
        logger.error(retryError);
        await this.notifier.notify(
          `🚨 [${sns}] 投稿に失敗しました (eventId=${id})。リトライも失敗したためこの報はスキップします。\n${retryError}`,
        );
      }
    }
  }
}
