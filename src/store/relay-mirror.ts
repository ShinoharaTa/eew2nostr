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

// 緊急度は状態 (l タグ) とは別のタグ名に載せる。
// 同じ l タグに入れると購読側のフィルタが OR になり、
// 「発表中かつ人命に関わるもの」を絞り込めなくなるため。
export const SEVERITY_TAG = "s";

// content の公開スキーマ識別子。別プロジェクトが参照する際の契約。
// フィールドの追加は後方互換とみなし版を上げない。
// 削除・意味変更をする場合は末尾の版番号を上げる。
export const STATUS_SCHEMA = "jp.shino3.bosai.status/1";

// 外部公開する形。内部レコードから配信管理用のフィールド
// (posts / deliveries / lastPostText / revision) を落とす。
// 内部実装の変更が外部への契約に漏れないよう、明示的に詰め替える。
export interface PublicStatus {
  schema: string;
  key: string;
  hazard: string;
  kind: string;
  severity: string;
  status: string;
  headline: string;
  publishedAt: string;
  updatedAt: string;
  expiresAt: string | null;
  area: { name: string; code: string; type: string | null } | null;
  // 種別ごとの構造化データ。中身は docs/status-events.md に定義する。
  detail: Record<string, unknown>;
}

export const toPublicStatus = (record: AlertStatusRecord): PublicStatus => ({
  schema: STATUS_SCHEMA,
  key: record.key,
  hazard: record.category,
  kind: record.kind,
  severity: record.severity,
  status: record.status,
  headline: record.headline,
  publishedAt: record.publishedAt,
  updatedAt: record.updatedAt,
  expiresAt: record.expiresAt,
  area: record.area ? { ...record.area, type: record.areaType ?? null } : null,
  detail: record.detail,
});

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
        [SEVERITY_TAG, record.severity],
      ],
      content: JSON.stringify(toPublicStatus(record)),
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
