import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import {
  type EventTemplate,
  type VerifiedEvent,
  finalizeEvent,
} from "nostr-tools/pure";
import WebSocket from "ws";
import { logger } from "../logger.js";

useWebSocketImplementation(WebSocket);

// SimplePool が満たすインターフェース(テスト時は差し替え可能)
// NIP-32 の自己ラベル。kind 1 に言語を宣言する。
// 宣言が無いとクライアント側の推定に委ねられ、漢字が主体の
// 防災情報は日本語と判定されないことがある。
const LANGUAGE_NAMESPACE = "ISO-639-1";
const LANGUAGE = "ja";

export interface RelayPoolPort {
  publish(relays: string[], event: VerifiedEvent): Promise<string>[];
  close(relays: string[]): void;
}

// Nostr への発行。
// SimplePool は1つだけ持って使い回す。プールは接続を保持し close() まで
// 開いたままなので、発行ごとに作ると接続が解放されず溜まり続ける。
// 切断された接続は ensureRelay() が次回発行時に張り直すため手当ては不要。
export class NostrPublisher {
  private seckey: Uint8Array;
  // dispose() で閉じるため、実際に使った宛先を控えておく
  private usedRelays = new Set<string>();

  constructor(
    hex: string,
    private defaultRelays: string[],
    private pool: RelayPoolPort = new SimplePool(),
  ) {
    this.seckey = new Uint8Array(Buffer.from(hex, "hex"));
  }

  async publishNote(params: {
    content: string;
    time: Date;
    reply?: { root: string | null; parent: string | null };
  }): Promise<string> {
    const ev: EventTemplate = {
      kind: 1,
      content: params.content,
      tags: [
        ["L", LANGUAGE_NAMESPACE],
        ["l", LANGUAGE, LANGUAGE_NAMESPACE],
      ],
      created_at: Math.floor(params.time.getTime() / 1000),
    };
    if (params.reply) {
      if (params.reply.root) ev.tags.push(["e", params.reply.root, "", "root"]);
      if (params.reply.parent)
        ev.tags.push(["e", params.reply.parent, "", "reply"]);
    }
    return await this.send(ev);
  }

  // relays を渡すと宛先を差し替えられる。プールは共有したまま、
  // ステータスのミラーだけ自前リレーへ送るといった使い分けができる。
  async publishReplaceable(params: {
    kind: number;
    d: string;
    tags: string[][];
    content: string;
    createdAt: number;
    relays?: string[];
  }): Promise<string> {
    const ev: EventTemplate = {
      kind: params.kind,
      content: params.content,
      tags: [["d", params.d], ...params.tags],
      created_at: params.createdAt,
    };
    return await this.send(ev, params.relays);
  }

  // NIP-09 の削除イベント。対象の event id を e タグで、
  // 対象の kind を k タグで示す。リレーは削除を保証しないが、
  // 対応するリレーとクライアントでは非表示になる。
  async publishDeletion(
    eventIds: string[],
    kinds: number[],
    reason = "",
    relays?: string[],
  ): Promise<string> {
    const ev: EventTemplate = {
      kind: 5,
      content: reason,
      tags: [
        ...eventIds.map((id) => ["e", id]),
        ...[...new Set(kinds)].map((kind) => ["k", String(kind)]),
      ],
      created_at: Math.floor(Date.now() / 1000),
    };
    return await this.send(ev, relays);
  }

  async publishRaw(content: string, time: Date): Promise<string> {
    const ev: EventTemplate = {
      kind: 7078,
      content: content,
      tags: [["d", "eew_alert_system_by_shino3"]],
      created_at: Math.floor(time.getTime() / 1000),
    };
    return await this.send(ev);
  }

  dispose(): void {
    this.pool.close([...this.usedRelays]);
  }

  // 最初の1リレーが受理した時点で返して速報性を保つ。
  // 残りのリレーの成否は裏で集計し、どこに載らなかったかをログに残す。
  private async send(ev: EventTemplate, relays?: string[]): Promise<string> {
    const targets = relays ?? this.defaultRelays;
    for (const relay of targets) this.usedRelays.add(relay);
    const post = finalizeEvent(ev, this.seckey);
    const results = this.pool.publish(targets, post);
    this.reportFailures(post.id, targets, results);
    await Promise.any(results);
    return post.id;
  }

  private reportFailures(
    eventId: string,
    targets: string[],
    results: Promise<string>[],
  ): void {
    void Promise.allSettled(results).then((settled) => {
      const failed = settled
        .map((result, index) => ({ result, relay: targets[index] }))
        .filter(({ result }) => result.status === "rejected");
      if (failed.length === 0) return;
      const detail = failed
        .map(
          ({ relay, result }) =>
            `${relay}: ${(result as PromiseRejectedResult).reason}`,
        )
        .join(", ");
      logger.warn(
        `event ${eventId} was not accepted by ${failed.length}/${targets.length} relays (${detail})`,
      );
    });
  }
}
