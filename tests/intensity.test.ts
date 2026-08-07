import {
  forecastIntensityLabel,
  forecastIntensityValue,
} from "../src/classify/intensity";

// 緊急地震速報の予想震度は from / to の範囲で来る。
//   over = 程度以上 (上限が決まらない)
//   不明 = 予想震度を決められなかった
// 別物なので混同しない。
describe("forecastIntensityLabel", () => {
  it.each([
    ["4", "4", "震度4"],
    ["5-", "5-", "震度5弱"],
    ["7", "7", "震度7"],
  ])("from=%s to=%s → %s", (from, to, expected) => {
    expect(forecastIntensityLabel(from, to)).toBe(expected);
  });

  // to だけを見ると "震度over" と出てしまう
  it.each([
    ["5-", "over", "震度5弱程度以上"],
    ["7", "over", "震度7程度以上"],
    ["3", "over", "震度3程度以上"],
  ])("from=%s to=over → %s", (from, to, expected) => {
    expect(forecastIntensityLabel(from, to)).toBe(expected);
  });

  it.each([
    ["不明", "不明"],
    ["不明", "over"],
    ["5-", "不明"],
    ["不明", "5-"],
  ])("from=%s to=%s は震度不明", (from, to) => {
    expect(forecastIntensityLabel(from, to)).toBe("震度不明");
  });

  it("上限と下限が違えば範囲で出す", () => {
    expect(forecastIntensityLabel("4", "5-")).toBe("震度4〜5弱");
  });
});

describe("forecastIntensityValue", () => {
  // 上限が決まらないときは下限を代表値にする
  it.each([
    ["5-", "over", "5-"],
    ["7", "over", "7"],
    ["4", "4", "4"],
    ["4", "5-", "5-"],
  ])("from=%s to=%s → %s", (from, to, expected) => {
    expect(forecastIntensityValue(from, to)).toBe(expected);
  });

  // 色だけ付いて表記が「震度不明」になるのを防ぐ
  it.each([
    ["不明", "不明"],
    ["不明", "over"],
    ["5-", "不明"],
  ])("from=%s to=%s は不明", (from, to) => {
    expect(forecastIntensityValue(from, to)).toBe("不明");
  });
});
