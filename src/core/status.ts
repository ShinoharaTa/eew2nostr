import type { ReplyRef } from "@atproto/api/dist/client/types/app/bsky/feed/post";
import type { EEWReport } from "./parser.js";

// 防災情報の種別。気象警報・注意報を扱う際にここへ追加する。
export type AlertCategory = "eew";

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

// 防災イベント1件の状態を表すレコード。種別を跨いで同じ形を使う。
export interface AlertStatusRecord {
  key: string;
  category: AlertCategory;
  status: AlertStatus;
  publishedAt: string;
  updatedAt: string;
  serial: string | null;
  headline: string;
  detail: Record<string, unknown>;
  posts: AlertPosts;
  // 保存のたびに増える版番号。ミラー完了を記録する際の突き合わせに使う。
  revision: number;
}

export const eewStatusKey = (eventId: string): string => `eew:${eventId}`;

const eewHeadline = (report: EEWReport): string =>
  `${report.place} 震度${report.forecast}（M${report.magnitude}）`;

const eewStatus = (report: EEWReport): AlertStatus =>
  report.isLast ? "finalized" : "active";

const eewDetail = (report: EEWReport): Record<string, unknown> => ({
  place: report.place,
  latitude: report.latitude,
  longitude: report.longitude,
  depth: report.depth,
  magnitude: report.magnitude,
  forecast: report.forecast,
  forecastLg: report.forecastLg,
  originTime: report.originTime?.toISOString() ?? null,
});

// 初報を受け取った時点のレコードを組み立てる
export const initialEEWRecord = (report: EEWReport): AlertStatusRecord => ({
  key: eewStatusKey(report.id),
  category: "eew",
  status: eewStatus(report),
  publishedAt: report.reportTime.toISOString(),
  updatedAt: report.reportTime.toISOString(),
  serial: report.serial,
  headline: eewHeadline(report),
  detail: eewDetail(report),
  posts: {},
  revision: 0,
});

// 続報を既存レコードへ反映する。投稿参照 (posts) は触らない。
export const applyEEWReport = (
  record: AlertStatusRecord,
  report: EEWReport,
): void => {
  record.status = eewStatus(report);
  record.updatedAt = report.reportTime.toISOString();
  record.serial = report.serial;
  record.headline = eewHeadline(report);
  record.detail = eewDetail(report);
};
