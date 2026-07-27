import type { AlertStatusRecord } from "../core/status.js";

// NIP-78 Application-specific Data。
// リレーが「同一 pubkey + kind + d タグの最新1件」だけを保持するため、
// 更新のたびに同じ d タグで発行すれば現在の状態がそのまま引ける。
export const STATUS_EVENT_KIND = 30078;

export interface ReplaceablePublisherPort {
  publishReplaceable(params: {
    kind: number;
    d: string;
    tags: string[][];
    content: string;
    createdAt: number;
  }): Promise<string>;
}

export interface StatusMirror {
  mirror(record: AlertStatusRecord): Promise<void>;
}

export class NostrStatusMirror implements StatusMirror {
  private lastCreatedAt = new Map<string, number>();

  constructor(private nostr: ReplaceablePublisherPort) {}

  async mirror(record: AlertStatusRecord): Promise<void> {
    await this.nostr.publishReplaceable({
      kind: STATUS_EVENT_KIND,
      d: record.key,
      // 単一文字タグはリレーでインデックスされるため、
      // 購読側が種別・状態でサーバサイド絞り込みできる
      tags: [
        ["t", record.category],
        ["t", record.status],
      ],
      content: JSON.stringify(record),
      createdAt: this.nextCreatedAt(record.key),
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
