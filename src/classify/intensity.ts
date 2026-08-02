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
