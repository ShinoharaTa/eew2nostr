import {
  hazardEmoji,
  headline,
  intensityColor,
  severityColor,
  shakingCallToAction,
  tierForIntensity,
  tierForSeverity,
  titleWithEmoji,
} from "../src/publisher/style";

describe("headline", () => {
  it("命を守る段階は帯を独立した行に置く", () => {
    expect(headline("act", "緊急地震速報（警報）第4報")).toBe(
      "◤◢◤◢◤◢◤◢◤◢◤◢◤◢\n緊急地震速報（警報）第4報",
    );
  });

  it("警報級はインラインの帯で挟む", () => {
    expect(headline("warn", "🌧️ 大雨警報 発表")).toBe("◤◢◤ 🌧️ 大雨警報 発表 ◢◤◢");
  });

  it("注意報級は1行", () => {
    expect(headline("note", "⚡ 雷注意報 発表")).toBe("▽ ⚡ 雷注意報 発表");
  });

  // 読み上げ対策でスラッシュを使わないことを固定する
  it("スラッシュを含まない", () => {
    for (const tier of ["act", "warn", "note"] as const) {
      expect(headline(tier, "地震情報")).not.toMatch(/[／/]/);
    }
  });
});

describe("intensityColor", () => {
  it.each([
    ["7", "🟣"],
    ["6+", "🔴"],
    ["6-", "🔴"],
    ["5+", "🟠"],
    ["5-", "🟠"],
    ["4", "🟠"],
    ["3", "🟡"],
    ["2", "🟡"],
    ["1", "🟡"],
  ])("震度%s → %s", (intensity, color) => {
    expect(intensityColor(intensity)).toBe(color);
  });

  it.each(["0", "不明", "over", ""])("%s は色を持たない", (value) => {
    expect(intensityColor(value)).toBeNull();
  });
});

describe("tierForIntensity", () => {
  it.each([
    ["7", "act"],
    ["6+", "act"],
    ["6-", "act"],
    ["5+", "warn"],
    ["5-", "warn"],
    ["4", "warn"],
    ["3", "note"],
    ["1", "note"],
  ])("震度%s → %s", (intensity, tier) => {
    expect(tierForIntensity(intensity)).toBe(tier);
  });
});

describe("severityColor", () => {
  it.each([
    ["emergency", "🟣"],
    ["warning", "🔴"],
    ["advisory", "🟡"],
    ["info", "⚪"],
  ] as const)("%s → %s", (severity, color) => {
    expect(severityColor(severity)).toBe(color);
  });

  // 表1-1 のレベル5相当は黒。Severity は emergency に丸められるため名前で見分ける
  it.each(["大雨特別警報", "氾濫発生情報"])("%s は黒", (name) => {
    expect(severityColor("emergency", name)).toBe("⚫");
  });
});

describe("tierForSeverity", () => {
  it("emergency は帯", () => {
    expect(tierForSeverity("emergency", "active")).toBe("act");
  });

  it("warning はインライン", () => {
    expect(tierForSeverity("warning", "active")).toBe("warn");
  });

  it.each(["advisory", "info"] as const)("%s は1行", (severity) => {
    expect(tierForSeverity(severity, "active")).toBe("note");
  });

  // 解除は危険度が下がった状態なので、元の緊急度に関わらず一番軽くなる
  it.each(["resolved", "cancelled"] as const)("%s は1行に落ちる", (state) => {
    expect(tierForSeverity("emergency", state)).toBe("note");
  });
});

describe("hazardEmoji", () => {
  it.each([
    ["津波警報", "🌊"],
    ["大津波警報", "🌊"],
    ["噴火警報", "🌋"],
    ["土砂災害警戒情報", "⛰️"],
    ["指定河川洪水予報", "🌀"],
    ["雷注意報", "⚡"],
    ["竜巻注意情報", "🌪️"],
    ["大雨警報", "🌧️"],
    ["暴風警報", "💨"],
    ["大雪警報", "❄️"],
    ["地震情報", "📳"],
  ])("%s → %s", (name, emoji) => {
    expect(hazardEmoji(name)).toBe(emoji);
  });

  // 「記録的短時間大雨情報」が「大雨」に先取りされないこと
  it("記録的短時間大雨情報は雷雨の絵文字", () => {
    expect(hazardEmoji("記録的短時間大雨情報")).toBe("⛈️");
  });

  // 「暴風雪警報」が「暴風」に先取りされないこと
  it("暴風雪警報は雪の絵文字", () => {
    expect(hazardEmoji("暴風雪警報")).toBe("🌨️");
  });

  it("名前で引けなければ種別の既定値を使う", () => {
    expect(hazardEmoji("不明な情報", "tsunami")).toBe("🌊");
    expect(hazardEmoji("不明な情報")).toBe("");
  });
});

describe("titleWithEmoji", () => {
  // 帯と色に絞ったほうが強く出るため、第1段階では絵文字を出さない
  it("命を守る段階は絵文字を付けない", () => {
    expect(titleWithEmoji("act", "大津波警報 発表")).toBe("大津波警報 発表");
  });

  it.each(["warn", "note"] as const)("%s は絵文字を付ける", (tier) => {
    expect(titleWithEmoji(tier, "雷注意報 発表")).toBe("⚡ 雷注意報 発表");
  });
});

describe("shakingCallToAction", () => {
  // 地震情報は既に揺れた後なので「警戒してください」は時制が合わない
  it.each([
    ["forecast", "7", "強い揺れに警戒してください。"],
    ["forecast", "6-", "強い揺れに警戒してください。"],
    ["forecast", "5-", "強い揺れに注意してください。"],
    ["observed", "7", "余震に警戒してください。"],
    ["observed", "5+", "今後の地震活動に注意してください。"],
  ] as const)("%s / 震度%s", (kind, intensity, expected) => {
    expect(shakingCallToAction(kind, intensity)).toBe(expected);
  });

  it.each(["4", "3", "1", "不明"])("震度%s には呼びかけない", (intensity) => {
    expect(shakingCallToAction("forecast", intensity)).toBeNull();
    expect(shakingCallToAction("observed", intensity)).toBeNull();
  });
});
