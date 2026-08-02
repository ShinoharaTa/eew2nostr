import type { ReplyRef } from "@atproto/api/dist/client/types/app/bsky/feed/post";
import type { AlertKind, HazardType, Severity } from "../classify/types.js";
import type { EEWReport } from "./parser.js";

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
  posts: AlertPosts;
  // 保存のたびに増える版番号。ミラー完了を記録する際の突き合わせに使う。
  revision: number;
}

export const eewStatusKey = (eventId: string): string => `eew:${eventId}`;

const eewHeadline = (report: EEWReport): string =>
  `${report.place} 震度${report.forecast}（M${report.magnitude}）`;

const eewStatus = (report: EEWReport): AlertStatus =>
  report.isLast ? "finalized" : "active";

// 予想震度で緊急度を決める。実測の地震情報と同じ基準に揃える。
const eewSeverity = (report: EEWReport): Severity => {
  if (["6-", "6+", "7"].includes(report.forecast)) return "emergency";
  if (["5-", "5+"].includes(report.forecast)) return "warning";
  return "info";
};

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
  kind: "forecast",
  severity: eewSeverity(report),
  status: eewStatus(report),
  publishedAt: report.reportTime.toISOString(),
  updatedAt: report.reportTime.toISOString(),
  expiresAt: null,
  serial: report.serial,
  headline: eewHeadline(report),
  area: { name: report.place, code: "" },
  areaType: "震央地名",
  detail: eewDetail(report),
  posts: {},
  revision: 0,
});

// 続報を既存レコードへ反映する。投稿参照 (posts) は触らない。
export const applyEEWReport = (
  record: AlertStatusRecord,
  report: EEWReport,
): void => {
  record.severity = eewSeverity(report);
  record.area = { name: report.place, code: "" };
  record.areaType = "震央地名";
  record.status = eewStatus(report);
  record.updatedAt = report.reportTime.toISOString();
  record.serial = report.serial;
  record.headline = eewHeadline(report);
  record.detail = eewDetail(report);
};
