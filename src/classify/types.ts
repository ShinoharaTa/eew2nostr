// 防災情報の種別。取得元 (dmdata / 気象庁フィード) に依らず横断で使う。
export type HazardType =
  | "eew" // 緊急地震速報
  | "earthquake" // 震度速報・震源震度情報など実測の地震情報
  | "tsunami"
  | "volcano"
  | "weather" // 気象警報・注意報
  | "sediment" // 土砂災害警戒情報
  | "flood" // 指定河川洪水予報
  | "tornado" // 竜巻注意情報
  | "heavy-rain"; // 記録的短時間大雨情報

// 情報の性質。予測と実測は同じ災害種別の中に混在するため、
// 種別とは別の軸として持つ。
export type AlertKind =
  | "forecast" // 予測・警戒 (これから危険が及ぶ)
  | "observed" // 実測 (実際に観測された)
  | "action"; // 行動指示 (避難指示など)

// 警戒レベル相当で正規化した緊急度。
export type Severity =
  | "emergency" // 人命に直結・即時行動 (レベル5相当)
  | "warning" // 避難行動 (レベル4相当)
  | "advisory" // 注意 (レベル2-3相当)
  | "info"; // 参考情報

export type AlertState = "active" | "resolved" | "finalized" | "cancelled";

export interface AlertArea {
  name: string;
  code: string;
}

// 電文1通から複数件生まれる。気象警報は (地域 × 警報種別) の数だけ出る。
export interface ClassifiedAlert {
  // ステータスのキー。同じ事象の更新は同じキーになる。
  key: string;
  hazard: HazardType;
  kind: AlertKind;
  severity: Severity;
  state: AlertState;
  headline: string;
  // 電文の発表時刻 (ISO)
  reportedAt: string;
  // 有効期限。解除電文が無く時限で失効する情報 (竜巻注意情報など) で入る。
  expiresAt: string | null;
  area: AlertArea | null;
  detail: Record<string, unknown>;
}
