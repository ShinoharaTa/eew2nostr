import type { ClassifiedAlert } from "../classify/types.js";
import { SerialQueue } from "../core/serial-queue.js";
import type { AlertPosts } from "../core/status.js";
import { logger } from "../logger.js";
import type { NotifierPort } from "../notifier/notifier.js";
import type { Router } from "../routing/router.js";
import type { StatusManager } from "../store/status-manager.js";
import { SNS_NAMES, type AccountClients, type SnsName } from "./account.js";
import { formatAlertPosts, groupForPosting } from "./message.js";

export type { NotifierPort } from "../notifier/notifier.js";

// 1回の投稿で使うスレッドの位置。
interface Thread {
  root: string | null;
  parent: string | null;
}

// 配信層。分類結果をルーティングし、アカウントごとに投稿する。
//
// キューは (アカウント × SNS) 単位で持つ。緊急地震速報の投稿が
// 警報 (推定150件/日) の投稿列に待たされないようにするため。
export class Delivery {
  private queues = new Map<string, SerialQueue>();

  constructor(
    private accounts: Map<string, AccountClients>,
    private router: Router,
    private status: StatusManager,
    private notifier?: NotifierPort,
    // 実際に投稿できた件数を数える。稼働報告に使う。
    private onDelivered?: () => void,
  ) {}

  // 1通の電文から生まれた防災イベントを配信する。
  deliver(alerts: ClassifiedAlert[]): void {
    for (const group of groupForPosting(alerts)) {
      const head = group[0];
      const targets = this.router.route({
        hazard: head.hazard,
        kind: head.kind,
        severity: head.severity,
        state: head.state,
      });
      if (targets.length === 0) continue;

      const posts = formatAlertPosts(group);
      if (posts.length === 0) continue;
      // 続報を前の投稿に繋げるのは、地域が1つに定まる場合だけ。
      // 気象警報のように複数地域をまとめた投稿は、
      // どのイベントの続きか一意に決められないため繋げない。
      const threadKey = group.length === 1 ? head.key : null;

      for (const accountKey of targets) {
        const account = this.accounts.get(accountKey);
        if (!account) continue;
        for (const sns of SNS_NAMES) {
          this.enqueue(account, sns, posts, threadKey);
        }
      }
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.idle()));
  }

  private queue(accountKey: string, sns: SnsName): SerialQueue {
    const id = `${accountKey}:${sns}`;
    const found = this.queues.get(id);
    if (found) return found;
    const created = new SerialQueue();
    this.queues.set(id, created);
    return created;
  }

  private enqueue(
    account: AccountClients,
    sns: SnsName,
    posts: string[],
    threadKey: string | null,
  ): void {
    this.queue(account.key, sns).push(async () => {
      // 鍵が未設定の経路は投稿せずコンソールに出す (テストモード)
      if (account[sns] === null) {
        for (const [index, content] of posts.entries()) {
          logger.info(
            `[未設定のため投稿しません] ${account.label} / ${sns} (${index + 1}/${posts.length})\n${content}`,
          );
        }
        return;
      }
      try {
        await this.publish(account, sns, posts, threadKey);
      } catch (e) {
        logger.error("配信に失敗しました", {
          account: account.key,
          sns,
          err: e,
        });
        await this.notifier?.notify(
          "error",
          `[${account.label} / ${sns}] 投稿に失敗しました`,
          String(e),
        );
      }
    });
  }

  private async publish(
    account: AccountClients,
    sns: SnsName,
    posts: string[],
    threadKey: string | null,
  ): Promise<void> {
    // 続報は前回の投稿へ繋ぐ
    const previous = threadKey
      ? this.status.get(threadKey)?.deliveries?.[account.key]
      : undefined;
    let thread = toThread(sns, previous);

    for (const content of posts) {
      const posted = await this.post(account, sns, content, thread);
      if (posted === null) return;
      this.onDelivered?.();
      // 分割された投稿は必ず前の投稿へ繋ぐ
      thread = { root: thread.root ?? posted.root, parent: posted.parent };
      if (threadKey) {
        await this.status.update(threadKey, (record) => {
          record.deliveries[account.key] = merge(
            record.deliveries[account.key],
            sns,
            posted,
          );
        });
      }
    }
  }

  private async post(
    account: AccountClients,
    sns: SnsName,
    content: string,
    thread: Thread,
  ): Promise<{ root: string; parent: string } | null> {
    if (sns === "nostr" && account.nostr) {
      const id = await account.nostr.publishNote({
        content,
        time: new Date(),
        reply: thread.root
          ? { root: thread.root, parent: thread.parent }
          : undefined,
      });
      return { root: thread.root ?? id, parent: id };
    }
    if (sns === "bluesky" && account.bluesky) {
      const ref = await account.bluesky.publish(
        content,
        thread.root && thread.parent
          ? {
              root: { uri: thread.root, cid: thread.root },
              parent: { uri: thread.parent, cid: thread.parent },
            }
          : undefined,
      );
      return { root: thread.root ?? ref.uri, parent: ref.uri };
    }
    if (sns === "concrnt" && account.concrnt) {
      const result = await account.concrnt.publish(
        content,
        thread.root ? { root: thread.root } : undefined,
      );
      const id = result?.id ?? thread.parent;
      return id ? { root: thread.root ?? id, parent: id } : null;
    }
    return null;
  }
}

const toThread = (sns: SnsName, posts: AlertPosts | undefined): Thread => {
  if (!posts) return { root: null, parent: null };
  if (sns === "nostr" && posts.nostr) {
    return {
      root: posts.nostr.root,
      parent: posts.nostr.parent ?? posts.nostr.root,
    };
  }
  if (sns === "bluesky" && posts.bluesky) {
    return { root: posts.bluesky.root.uri, parent: posts.bluesky.parent.uri };
  }
  if (sns === "concrnt" && posts.concrnt) {
    return { root: posts.concrnt.root, parent: posts.concrnt.root };
  }
  return { root: null, parent: null };
};

const merge = (
  posts: AlertPosts | undefined,
  sns: SnsName,
  posted: { root: string; parent: string },
): AlertPosts => {
  const next: AlertPosts = { ...(posts ?? {}) };
  if (sns === "nostr")
    next.nostr = { root: posted.root, parent: posted.parent };
  if (sns === "bluesky")
    next.bluesky = {
      root: { uri: posted.root, cid: posted.root },
      parent: { uri: posted.parent, cid: posted.parent },
    };
  if (sns === "concrnt") next.concrnt = { root: posted.root };
  return next;
};
