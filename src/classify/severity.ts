import type { Severity } from "./types.js";

// 警報名から緊急度を判定する。
// 気象警報は VPWW53 を採用しており名前に警戒レベルが入らないため、
// 「特別警報 / 警報 / 注意報」の語尾で判定する。
// R06 形式の「レベル４土砂災害危険警報」のようにレベルが付く名前も
// 将来扱えるよう、レベル表記があればそちらを優先する。
export const severityFromName = (name: string): Severity => {
  const level = levelFromName(name);
  if (level !== null) {
    if (level >= 5) return "emergency";
    if (level === 4) return "warning";
    if (level >= 2) return "advisory";
    return "info";
  }
  if (name.includes("特別警報")) return "emergency";
  if (name.includes("警報")) return "warning";
  if (name.includes("注意報")) return "advisory";
  return "info";
};

// 「レベル４土砂災害危険警報」「レベル２（火口周辺規制）」から数値を取り出す
const FULLWIDTH_DIGITS = "０１２３４５６７８９";
export const levelFromName = (name: string): number | null => {
  const matched = name.match(/レベル([0-9０-９])/);
  if (!matched) return null;
  const ch = matched[1];
  const index = FULLWIDTH_DIGITS.indexOf(ch);
  return index >= 0 ? index : Number(ch);
};

// 噴火警戒レベルは 5 段階。4 以上で避難、3 で入山規制。
export const severityFromVolcanoLevel = (level: number | null): Severity => {
  if (level === null) return "info";
  if (level >= 4) return "emergency";
  if (level === 3) return "warning";
  if (level === 2) return "advisory";
  return "info";
};

// 津波は注意報でも避難行動を要するため、警報以上を emergency に寄せる
export const severityFromTsunamiKind = (name: string): Severity => {
  if (name.includes("解除")) return "info";
  if (name.includes("大津波")) return "emergency";
  if (name.includes("津波警報")) return "emergency";
  if (name.includes("津波注意報")) return "warning";
  return "info";
};
