import { intensityRank } from "../classify/intensity.js";
import type { AlertState, HazardType, Severity } from "../classify/types.js";

// 投稿の見た目を決める層。軸は2本あり、それぞれ1つの意味だけを持つ。
//
//   装飾 = 取るべき行動の緊急度   帯 → インライン → ▽
//   色   = 震度・警戒レベル       🟣 🔴 🟠 🟡 ⚪ ⚫
//
// 軸を分けているのは、同じ地震で緊急地震速報と地震情報が続けて流れたとき、
// 色が変わると「予想より弱かった」と誤読されるため。色は震度だけを表し、
// 警報かどうかは装飾で示す。

// 言語判定の保険。ひらがなとカタカナを混ぜておくと、
// 漢字が主体の防災情報でも日本語と推定されやすい。
export const FOOTER = "※テスト運用中です。";

// 装飾の段階。
export type Tier =
  | "act" // 命を守る行動が必要
  | "warn" // 警報級
  | "note"; // 注意報級・解除

// 工事帯。上下の三角を交互に並べると斜めの縞になる。
// スクリーンリーダーに読ませないため "／" ではなくコーナー三角を使う。
const BAND = "◤◢".repeat(7);

// 見出し。第1段階だけ帯を独立した行にして、他と明確に差をつける。
export const headline = (tier: Tier, title: string): string => {
  switch (tier) {
    case "act":
      return `${BAND}\n${title}`;
    case "warn":
      return `◤◢◤ ${title} ◢◤◢`;
    case "note":
      return `▽ ${title}`;
  }
};

// 震度の色。緊急地震速報と地震情報で共通。
// 上に行くほど幅が狭くなり、重い側ほど細かく分かれる。
export const intensityColor = (intensity: string): string | null => {
  const rank = intensityRank(intensity);
  if (rank < 0) return null;
  if (intensity === "7") return "🟣";
  if (rank >= intensityRank("6-")) return "🔴";
  if (rank >= intensityRank("4")) return "🟠";
  if (rank >= intensityRank("1")) return "🟡";
  return null;
};

// 震度から装飾の段階を決める。
export const tierForIntensity = (intensity: string): Tier => {
  const rank = intensityRank(intensity);
  if (rank >= intensityRank("6-")) return "act";
  if (rank >= intensityRank("4")) return "warn";
  return "note";
};

// 警戒レベル相当の色。気象庁「気象情報の配色に関する設定指針」
// (令和2年7月改訂) 表1-1・表1-2 に合わせている。
// https://www.jma.go.jp/jma/kishou/info/colorguide/HPColorGuide_202007.pdf
const LEVEL_COLOR: Record<Severity, string> = {
  emergency: "🟣", // レベル4-5相当 (170,0,170 / 200,0,255)
  warning: "🔴", // レベル3相当 (255,40,0)
  advisory: "🟡", // レベル2相当 (242,231,0)
  info: "⚪", // レベル1 (255,255,255)
};

// レベル5相当だけは黒。Severity は emergency に丸められるため名前で見分ける。
const LEVEL5_NAMES = ["特別警報", "氾濫発生"];

export const severityColor = (severity: Severity, name = ""): string =>
  LEVEL5_NAMES.some((word) => name.includes(word))
    ? "⚫" // 12,0,12
    : LEVEL_COLOR[severity];

// 緊急度から装飾の段階を決める。解除は危険度が下がった状態なので
// 元の緊急度に関わらず一番軽い段階に落ちる。
export const tierForSeverity = (
  severity: Severity,
  state: AlertState,
): Tier => {
  if (state === "resolved" || state === "cancelled") return "note";
  if (severity === "emergency") return "act";
  if (severity === "warning") return "warn";
  return "note";
};

// 現象の絵文字。名前に含まれる語で引く。
// 長い語を先に置き、「記録的短時間大雨」が「大雨」に先取りされないようにする。
const HAZARD_EMOJI: [string, string][] = [
  ["記録的短時間大雨", "⛈️"],
  ["緊急地震速報", "📳"],
  ["土砂災害", "⛰️"],
  ["暴風雪", "🌨️"],
  ["津波", "🌊"],
  ["高潮", "🌊"],
  ["噴火", "🌋"],
  ["洪水", "🌀"],
  ["氾濫", "🌀"],
  ["波浪", "〰️"],
  ["竜巻", "🌪️"],
  ["大雨", "🌧️"],
  ["暴風", "💨"],
  ["強風", "💨"],
  ["大雪", "❄️"],
  ["着雪", "❄️"],
  ["なだれ", "🏔️"],
  ["融雪", "💧"],
  ["低温", "🥶"],
  ["乾燥", "🔥"],
  ["濃霧", "🌫️"],
  ["雷", "⚡"],
  ["地震", "📳"],
];

// 名前で引けなかったときの種別ごとの既定値。
const FALLBACK_EMOJI: Record<HazardType, string> = {
  eew: "📳",
  earthquake: "📳",
  tsunami: "🌊",
  volcano: "🌋",
  weather: "🌧️",
  sediment: "⛰️",
  flood: "🌀",
  tornado: "🌪️",
  "heavy-rain": "⛈️",
};

export const hazardEmoji = (name: string, hazard?: HazardType): string => {
  const matched = HAZARD_EMOJI.find(([word]) => name.includes(word));
  if (matched) return matched[1];
  return hazard ? (FALLBACK_EMOJI[hazard] ?? "") : "";
};

// 見出しの語。第1段階は帯と色で緊急度を示すため絵文字を出さない。
// 記号を減らしたほうが帯が強く出る。
export const titleWithEmoji = (
  tier: Tier,
  name: string,
  hazard?: HazardType,
): string => (tier === "act" ? name : `${hazardEmoji(name, hazard)} ${name}`);

// 揺れへの呼びかけ。予測と実測では時制が違う。
// 地震情報は既に揺れた後なので「警戒してください」は使えない。
export const shakingCallToAction = (
  kind: "forecast" | "observed",
  maxIntensity: string,
): string | null => {
  const rank = intensityRank(maxIntensity);
  if (rank >= intensityRank("6-")) {
    return kind === "forecast"
      ? "強い揺れに警戒してください。"
      : "余震に警戒してください。";
  }
  if (rank >= intensityRank("5-")) {
    return kind === "forecast"
      ? "強い揺れに注意してください。"
      : "今後の地震活動に注意してください。";
  }
  return null;
};
