import type { ClassifiedAlert } from "../classify/types.js";
import { SerialQueue } from "../core/serial-queue.js";
import type { AlertPosts } from "../core/status.js";
import { logger } from "../logger.js";
import type { NotifierPort } from "../notifier/notifier.js";
import type { Router } from "../routing/router.js";
import type { StatusManager } from "../store/status-manager.js";
import { type AccountClients, SNS_NAMES, type SnsName } from "./account.js";
import { alertImageUrl, formatAlertPosts, groupForPosting } from "./message.js";

export type { NotifierPort } from "../notifier/notifier.js";

// 1回の投稿で使うスレッドの位置。
// Bluesky は reply の参照に uri と cid (コンテンツハッシュ) の両方を
// 要求するため、識別子とは別に cid も持ち回る。
interface Thread {
  root: string | null;
  parent: string | null;
  rootCid: string | null;
  parentCid: string | null;
}

// 投稿1件の結果。cid は Bluesky 以外では null。
interface Posted {
  root: string;
  parent: string;
  rootCid: string | null;
  parentCid: string | null;
}

const EMPTY_THREAD: Thread = {
  root: null,
  parent: null,
  rootCid: null,
  parentCid: null,
};

// cid の欄に URI が入っていないか。過去の不具合で "at://…" が保存されて
// いることがあり、壊れた参照で繋ぐと返信が失敗し続ける。
const isValidCid = (cid: string | undefined): cid is string =>
  cid !== undefined && cid !== "" && !cid.includes("://");

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
    // 発令エリア画像API (viewer) の base URL。空なら画像を付けない
    private imageBaseUrl = "",
  ) {}

  // 1通の電文から生まれた防災イベントを配信する。
  async deliver(alerts: ClassifiedAlert[]): Promise<void> {
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

      // 前回配信した文面と完全に一致するなら送らない。
      // VPWW53 は県内のどこかで別の警報が動くたびに再発表され、変化して
      // いない警報も「継続」で毎回載ってくるため、そのまま流すと同じ投稿が
      // 何度も並ぶ。文面で比べるので、地震の続報 (震源や地域が加わる) や
      // 解除 (見出しが変わる) は今までどおり流れる。
      const signature = JSON.stringify(posts);
      if (
        group.every(
          (alert) => this.status.get(alert.key)?.lastPostText === signature,
        )
      ) {
        logger.info("前回と同じ文面のため配信しません", {
          keys: group.map((alert) => alert.key).slice(0, 5),
        });
        continue;
      }
      // 投稿の成否を待たずに配信済み扱いにする。失敗時に同じ文面の再発表で
      // 補われることは期待せず、失敗は notifier の通知で気付く方針。
      for (const alert of group) {
        await this.status.update(alert.key, (record) => {
          record.lastPostText = signature;
        });
      }
      // 続報を前の投稿に繋げるのは、地域が1つに定まる場合だけ。
      // 気象警報のように複数地域をまとめた投稿は、
      // どのイベントの続きか一意に決められないため繋げない。
      const threadKey = group.length === 1 ? head.key : null;

      // 発令エリアの地図画像は Nostr だけ URL で添付する (content 中の
      // 画像URLをインライン展開するのは Nostr クライアントの慣習のため。
      // Bluesky の embed は第2段)。URL は同じ group から決定的に導かれる
      // ため、重複判定は上の signature (画像なしの文面) のままでよい
      const imageUrl = alertImageUrl(group, this.imageBaseUrl);
      const nostrPosts =
        imageUrl === null
          ? posts
          : formatAlertPosts(group, undefined, imageUrl);

      for (const accountKey of targets) {
        const account = this.accounts.get(accountKey);
        if (!account) continue;
        for (const sns of SNS_NAMES) {
          this.enqueue(
            account,
            sns,
            sns === "nostr" ? nostrPosts : posts,
            threadKey,
          );
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
      thread = {
        root: thread.root ?? posted.root,
        parent: posted.parent,
        rootCid: thread.rootCid ?? posted.rootCid,
        parentCid: posted.parentCid,
      };
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
  ): Promise<Posted | null> {
    if (sns === "nostr" && account.nostr) {
      const id = await account.nostr.publishNote({
        content,
        time: new Date(),
        reply: thread.root
          ? { root: thread.root, parent: thread.parent }
          : undefined,
      });
      return {
        root: thread.root ?? id,
        parent: id,
        rootCid: null,
        parentCid: null,
      };
    }
    if (sns === "bluesky" && account.bluesky) {
      const ref = await account.bluesky.publish(
        content,
        thread.root && thread.parent && thread.rootCid && thread.parentCid
          ? {
              root: { uri: thread.root, cid: thread.rootCid },
              parent: { uri: thread.parent, cid: thread.parentCid },
            }
          : undefined,
      );
      return {
        root: thread.root ?? ref.uri,
        parent: ref.uri,
        rootCid: thread.rootCid ?? ref.cid,
        parentCid: ref.cid,
      };
    }
    if (sns === "concrnt" && account.concrnt) {
      const result = await account.concrnt.publish(
        content,
        thread.root ? { root: thread.root } : undefined,
      );
      const id = result?.id ?? thread.parent;
      return id
        ? {
            root: thread.root ?? id,
            parent: id,
            rootCid: null,
            parentCid: null,
          }
        : null;
    }
    return null;
  }
}

const toThread = (sns: SnsName, posts: AlertPosts | undefined): Thread => {
  if (!posts) return EMPTY_THREAD;
  if (sns === "nostr" && posts.nostr) {
    return {
      ...EMPTY_THREAD,
      root: posts.nostr.root,
      parent: posts.nostr.parent ?? posts.nostr.root,
    };
  }
  if (sns === "bluesky" && posts.bluesky) {
    const { root, parent } = posts.bluesky;
    // 壊れた参照 (cid に URI が入っている) はスレッドを新規に立て直す
    if (!isValidCid(root.cid) || !isValidCid(parent.cid)) return EMPTY_THREAD;
    return {
      root: root.uri,
      parent: parent.uri,
      rootCid: root.cid,
      parentCid: parent.cid,
    };
  }
  if (sns === "concrnt" && posts.concrnt) {
    return {
      ...EMPTY_THREAD,
      root: posts.concrnt.root,
      parent: posts.concrnt.root,
    };
  }
  return EMPTY_THREAD;
};

const merge = (
  posts: AlertPosts | undefined,
  sns: SnsName,
  posted: Posted,
): AlertPosts => {
  const next: AlertPosts = { ...(posts ?? {}) };
  if (sns === "nostr")
    next.nostr = { root: posted.root, parent: posted.parent };
  // Bluesky は返信時に本物の cid が要るため、投稿結果の cid をそのまま保存する
  if (sns === "bluesky" && posted.rootCid && posted.parentCid)
    next.bluesky = {
      root: { uri: posted.root, cid: posted.rootCid },
      parent: { uri: posted.parent, cid: posted.parentCid },
    };
  if (sns === "concrnt") next.concrnt = { root: posted.root };
  return next;
};
