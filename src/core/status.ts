import type { ReplyRef } from "@atproto/api/dist/client/types/app/bsky/feed/post";
import type { AlertKind, HazardType, Severity } from "../classify/types.js";

// 防災情報の種別。分類層と同じ語彙を使う。
export type AlertCategory = HazardType;

// 防災イベントの状態。
// active    : 発表中 (続報が来る可能性がある)
// finalized : 最終報まで出し切った
// resolved  : 解除された (警報・注意報向け)
// cancelled : 取消された
export type AlertStatus = "active" | "finalized" | "resolved" | "cancelled";

// 各SNSの投稿参照。再起動後もリプライツリーを継続するために保持する。
export interface AlertPosts {
  nostr?: { root: string | null; parent: string | null };
  bluesky?: ReplyRef;
  concrnt?: { root: string };
}

// アカウントごとの投稿参照。4系統に配信するため、
// 同じ防災イベントでもアカウント別にスレッドを持つ。
export type AlertDeliveries = Record<string, AlertPosts>;

// 防災イベント1件の状態を表すレコード。種別を跨いで同じ形を使う。
export interface AlertStatusRecord {
  key: string;
  category: AlertCategory;
  // 情報の性質 (予測 / 実測 / 行動指示)。配信先の振り分けに使う。
  kind: AlertKind;
  // 警戒レベル相当で正規化した緊急度。配信先の振り分けに使う。
  severity: Severity;
  status: AlertStatus;
  publishedAt: string;
  updatedAt: string;
  // 有効期限。解除電文が無く時限で失効する情報 (竜巻注意情報など) で入る。
  expiresAt: string | null;
  serial: string | null;
  headline: string;
  // 対象地域。地震は震源、気象警報は一次細分区域。
  area: { name: string; code: string } | null;
  // 地域の区分。県・市区町村・細分区域など、種別によって粒度が異なる。
  areaType: string | null;
  detail: Record<string, unknown>;
  // 旧経路が使っていた投稿参照。過去のレコードとの互換のため残す。
  posts: AlertPosts;
  // 4系統への配信先ごとの投稿参照。
  deliveries: AlertDeliveries;
  // 最後に配信した投稿文の署名。
  // VPWW53 は県内のどこかで別の警報が動くたびに再発表され、変化していない
  // 警報も「継続」で毎回載ってくるため、同じ文面の再配信を抑制する。
  lastPostText?: string | null;
  // 保存のたびに増える版番号。ミラー完了を記録する際の突き合わせに使う。
  revision: number;
}
