import {
  prefectureFromAreaCode,
  withPrefecture,
} from "../src/classify/prefecture";

// 気象庁の地域コードは先頭2桁が都道府県コードになっている
describe("prefectureFromAreaCode", () => {
  it.each([
    ["012010", "北海道"], // 上川地方 (一次細分区域)
    ["0421502", "宮城県"], // 大崎市西部 (市町村等)
    ["200000", "長野県"], // 長野県 (府県予報区)
    ["120010", "千葉県"], // 北西部
    ["470000", "沖縄県"],
  ])("%s → %s", (code, name) => {
    expect(prefectureFromAreaCode(code)).toBe(name);
  });

  // 地震の細分区域・津波予報区・火山・河川は別の体系
  it.each(["743", "712", "509", "8202090004", "", "abcdef"])(
    "%s は対象外で null",
    (code) => {
      expect(prefectureFromAreaCode(code)).toBeNull();
    },
  );

  it("未定義の番号は null", () => {
    expect(prefectureFromAreaCode("990000")).toBeNull();
  });
});

describe("withPrefecture", () => {
  it("全国配信のため都道府県名を補う", () => {
    expect(withPrefecture("上川地方", "012010")).toBe("北海道上川地方");
    expect(withPrefecture("金山町", "0620500")).toBe("山形県金山町");
  });

  it("すでに都道府県名で始まる場合は重ねない", () => {
    expect(withPrefecture("長野県", "200000")).toBe("長野県");
    expect(withPrefecture("千葉県北西部", "120010")).toBe("千葉県北西部");
  });

  it("体系が違うコードはそのまま返す", () => {
    expect(withPrefecture("有明・八代海", "712")).toBe("有明・八代海");
    expect(withPrefecture("口永良部島", "509")).toBe("口永良部島");
  });
});
