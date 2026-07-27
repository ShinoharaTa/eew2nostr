import type { ReplyRef } from "@atproto/api/dist/client/types/app/bsky/feed/post";
import type { EEWParser } from "../core/parser.js";
import type { JsonSchema } from "../types/eew";
import type { BskyPublisher } from "./bsky.js";
import type { ConcrntPublisher } from "./concrnt.js";
import type { NostrPublisher } from "./nostr.js";

interface PostObject {
  nostr?: { root: string | null; parent: string | null };
  bluesky?: ReplyRef;
  concrnt?: { root: string };
}

// 電文を受け取り、各SNSへ並列に投稿してリプライツリーを管理する配信層。
// 取得層のことは知らない。
export class PublishDispatcher {
  private posts = new Map<string, PostObject>();

  constructor(
    private parser: EEWParser,
    private nostr: NostrPublisher,
    private bsky: BskyPublisher,
    private concrnt: ConcrntPublisher,
  ) {}

  async handle(telegram: JsonSchema): Promise<void> {
    const report = this.parser.objectMapping(telegram);
    if (report === "cancel") return;
    if (!report.id) return;
    const message = this.parser.generateEEWMessage(report);
    const postInfo = this.posts.get(report.id) ?? {};
    const [nostrResult, bskyResult, concrntResult] = await Promise.all([
      (async () => {
        const nostrEventId = await this.nostr.publishNote({
          content: message,
          time: report.reportTime,
          reply: postInfo.nostr,
        });
        await this.nostr.publishRaw(
          JSON.stringify(telegram),
          report.reportTime,
        );
        return nostrEventId;
      })(),
      this.bsky.publish(message, postInfo.bluesky),
      this.concrnt.publish(message, postInfo.concrnt),
    ]);
    if (postInfo.nostr) postInfo.nostr.parent = nostrResult;
    else postInfo.nostr = { root: nostrResult, parent: null };
    if (postInfo.bluesky) postInfo.bluesky.parent = bskyResult;
    else postInfo.bluesky = { root: bskyResult, parent: bskyResult };
    if (concrntResult) postInfo.concrnt = { root: concrntResult.id };
    this.posts.set(report.id, postInfo);
  }
}
