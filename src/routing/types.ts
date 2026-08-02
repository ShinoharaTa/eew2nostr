import type { AlertKind, HazardType, Severity } from "../classify/types.js";

// 各SNSの接続情報。値そのものではなく環境変数名を持つ。
// 鍵を用意する前でも分類とルーティングだけ先に定義できるようにする。
export interface NostrAccountConfig {
  hexEnv: string;
  relays?: string[];
}

export interface BlueskyAccountConfig {
  identifierEnv: string;
  passwordEnv: string;
}

export interface ConcrntAccountConfig {
  subkeyEnv: string;
  channelEnv?: string;
}

export interface AccountConfig {
  label?: string;
  nostr?: NostrAccountConfig;
  bluesky?: BlueskyAccountConfig;
  concrnt?: ConcrntAccountConfig;
}

// ルートの条件。
// 異なるキー同士は AND、同一キー内の配列は OR で評価する
// (Nostr のフィルタと同じ意味論)。空オブジェクトは全件にマッチする。
export interface RouteCondition {
  hazard?: HazardType[];
  // 情報の性質。予測系だけ / 実測だけ を分けるのに使う。
  kind?: AlertKind[];
  // この緊急度以上にマッチする。severity は順序を持つため閾値で書ける。
  minSeverity?: Severity;
  // 状態での絞り込み。省略時はすべての状態にマッチする。
  state?: string[];
}

export interface Route {
  to: string;
  when?: RouteCondition;
}

export interface RoutingConfig {
  accounts: Record<string, AccountConfig>;
  routes: Route[];
}

// 緊急度の高低。閾値の比較に使う。
export const SEVERITY_ORDER: Severity[] = [
  "info",
  "advisory",
  "warning",
  "emergency",
];

export const severityRank = (severity: Severity): number =>
  SEVERITY_ORDER.indexOf(severity);
