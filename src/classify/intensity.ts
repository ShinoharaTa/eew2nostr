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

// 1件に収まらない場合の分割点。震度4以上と震度3で分ける。
export const SPLIT_INTENSITY = "4";
