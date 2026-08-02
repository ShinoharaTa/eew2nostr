import { parseHeavyRainHeadline } from "../src/classify/classifiers";

// 気象庁の定型文から地点と雨量を取り出す。電文に構造化された値が無いため。
describe("parseHeavyRainHeadline", () => {
  it("レーダー解析値 (約) を取り出す", () => {
    expect(
      parseHeavyRainHeadline(
        "１９時１０分、長野県伊那で記録的短時間大雨。\n伊那付近で１時間に約１００ミリ。",
        "長野県",
      ),
    ).toEqual({
      place: "伊那",
      observedAt: "19時10分",
      millimeters: 100,
      estimated: true,
    });
  });

  it("観測値 (約なし・小数) を取り出す", () => {
    const parsed = parseHeavyRainHeadline(
      "２時３０分、富山県入善町で記録的短時間大雨。\n入善町付近で１時間に１２０．５ミリ。",
      "富山県",
    );
    expect(parsed.millimeters).toBe(120.5);
    expect(parsed.estimated).toBe(false);
    expect(parsed.place).toBe("入善町");
  });

  it("分を伴わない時刻も扱える", () => {
    const parsed = parseHeavyRainHeadline(
      "０時、新潟県糸魚川市で記録的短時間大雨。\n糸魚川市付近で１時間に約１００ミリ。",
      "新潟県",
    );
    expect(parsed.observedAt).toBe("0時");
    expect(parsed.place).toBe("糸魚川市");
  });

  // 府県名が前置されるため重複を落とす
  it("地点名から府県名を落とす", () => {
    expect(
      parseHeavyRainHeadline("１時、長野県伊那で記録的短時間大雨。", "長野県")
        .place,
    ).toBe("伊那");
  });

  it("形式が違えば null を返す", () => {
    expect(parseHeavyRainHeadline("想定外の文面です", "長野県")).toEqual({
      place: null,
      observedAt: null,
      millimeters: null,
      estimated: false,
    });
  });
});
