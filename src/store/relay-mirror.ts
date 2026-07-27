import type { AlertStatusRecord } from "../core/status.js";

// 防災情報のステータス専用に使う addressable kind。
// リレーは「同一 pubkey + kind + d タグ値の最新1件」だけを保持するため、
// 更新のたびに同じ d タグで発行すれば現在の状態がそのまま引ける。
// 置換は d タグ値ごとなので、防災イベントごとのレコードは互いに共存する。
//
// NIP-78 (kind 30078) は「相互運用性を求めないアプリの個人データ」が対象で、
// 他クライアントに読ませる公開データには合わないため専用 kind を使う。
export const STATUS_EVENT_KIND = 30830;

// NIP-32 のラベル名前空間。状態を種別 (t タグ) と別のタグ名で持たせる。
// NIP-01 では同じタグ内の値は OR、異なる属性同士は AND で評価されるため、
// 種別と状態を同じ t タグに入れると「発表中の緊急地震速報だけ」が表現できない。
export const STATUS_LABEL_NAMESPACE = "jp.shino3.bosai.status";

export interface ReplaceablePublisherPort {
  publishReplaceable(params: {
    kind: number;
    d: string;
    tags: string[][];
    content: string;
    createdAt: number;
    relays?: string[];
  }): Promise<string>;
}

export interface StatusMirror {
  mirror(record: AlertStatusRecord): Promise<void>;
}

export class NostrStatusMirror implements StatusMirror {
  private lastCreatedAt = new Map<string, number>();

  // relays を渡すとミラー先を投稿先と分けられる
  constructor(
    private nostr: ReplaceablePublisherPort,
    private relays?: string[],
  ) {}

  async mirror(record: AlertStatusRecord): Promise<void> {
    await this.nostr.publishReplaceable({
      kind: STATUS_EVENT_KIND,
      d: record.key,
      // 単一文字タグはリレーでインデックスされるため、購読側は
      // {"#t":["eew"], "#l":["active"]} のように AND で絞り込める
      tags: [
        ["t", record.category],
        ["L", STATUS_LABEL_NAMESPACE],
        ["l", record.status, STATUS_LABEL_NAMESPACE],
      ],
      content: JSON.stringify(record),
      createdAt: this.nextCreatedAt(record.key),
      relays: this.relays,
    });
  }

  // replaceable event は created_at が同値だとリレーが event id の小さい方を残すため、
  // キーごとに厳密に単調増加させて同一秒内の更新が失われないようにする
  private nextCreatedAt(key: string): number {
    const now = Math.floor(Date.now() / 1000);
    const previous = this.lastCreatedAt.get(key);
    const createdAt =
      previous === undefined ? now : Math.max(now, previous + 1);
    this.lastCreatedAt.set(key, createdAt);
    return createdAt;
  }
}
