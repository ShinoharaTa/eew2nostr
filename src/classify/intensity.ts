// 震度は "5-" "5+" のような文字列。強弱を比較するための順序を与える。
export const INTENSITY_ORDER = [
  "0",
  "1",
  "2",
  "3",
  "4",
  "5-",
  "5+",
  "6-",
  "6+",
  "7",
];

export const intensityRank = (value: string): number =>
  INTENSITY_ORDER.indexOf(value);

// 投稿に載せる震度の下限。震度1〜2は件数が多く、
// 全国配信では読み手の判断にほとんど寄与しないため落とす。
export const MIN_POSTED_INTENSITY = "3";

// 1件に収まらない場合の投稿数の上限。
// 分割しすぎるとタイムラインを占有するため、超える分は最後にまとめる。
export const MAX_SPLIT_POSTS = 3;

// 電文の震度は "5-" "5+" の形。表示は気象庁の表記に合わせる。
export const intensityLabel = (value: string): string =>
  value.replace(/-$/, "弱").replace(/\+$/, "強");

export const UNKNOWN_INTENSITY = "不明";

// 緊急地震速報の予想震度は from / to の範囲で来る。
//   to = "over"  上限が決まらない。from と組で「震度5弱程度以上」を表す
//   不明          予想震度を決められなかった。over とは別物
// to だけを見ると "over" がそのまま表に出てしまうため、両方を使う。
export const forecastIntensityLabel = (from: string, to: string): string => {
  if (to === "over") {
    return from === UNKNOWN_INTENSITY
      ? "震度不明"
      : `震度${intensityLabel(from)}程度以上`;
  }
  if (to === UNKNOWN_INTENSITY || from === UNKNOWN_INTENSITY) return "震度不明";
  if (from === to) return `震度${intensityLabel(to)}`;
  return `震度${intensityLabel(from)}〜${intensityLabel(to)}`;
};

// 色や呼びかけの判断に使う代表値。上限が決まらないときは下限を採る。
// どちらかが不明なら不明。色だけ付いて表記が「震度不明」になるのを防ぐ。
export const forecastIntensityValue = (from: string, to: string): string => {
  if (from === UNKNOWN_INTENSITY || to === UNKNOWN_INTENSITY)
    return UNKNOWN_INTENSITY;
  return to === "over" ? from : to;
};

// 投稿が含む震度の範囲を表す見出し。
export const intensityRangeLabel = (values: string[]): string => {
  if (values.length === 0) return "";
  const sorted = [...values].sort(
    (a, b) => intensityRank(b) - intensityRank(a),
  );
  const strongest = intensityLabel(sorted[0]);
  const weakest = intensityLabel(sorted[sorted.length - 1]);
  return strongest === weakest
    ? `震度${strongest}`
    : `震度${strongest}〜${weakest}`;
};
