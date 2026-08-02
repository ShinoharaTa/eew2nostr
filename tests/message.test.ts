import * as fs from "node:fs";
import * as path from "node:path";
import { classify } from "../src/classify";
import type { ClassifiedAlert } from "../src/classify/types";
import {
  MAX_GRAPHEMES,
  formatAlerts,
  groupForPosting,
} from "../src/publisher/message";
import { parseTelegram } from "../src/receiver/jma-xml";

const alertsOf = (type: string): ClassifiedAlert[] =>
  classify(
    type,
    parseTelegram(
      fs.readFileSync(
        path.join(__dirname, "fixtures/telegrams", `${type}.xml`),
        "utf-8",
      ),
    ),
  );

const posts = (type: string): string[] =>
  groupForPosting(alertsOf(type)).map((group) => formatAlerts(group));

const graphemes = (text: string) => [...text].length;

const ALL_TYPES = [
  "VXSE53",
  "VXSE62",
  "VTSE41",
  "VFVO50",
  "VPWW53",
  "VXWW50",
  "VXKO70",
  "VPHW50",
  "VPOA50",
];

describe("投稿文の生成", () => {
  it("地震情報は発生時刻・震源・最大震度を出す", () => {
    const [text] = posts("VXSE53");
    expect(text).toContain("【地震情報】18:41");
    expect(text).toContain("熊本県天草・芦北地方");
    expect(text).toContain("最大震度 3（M3.8）");
  });

  // 震源だけではどの地域が揺れたか伝わらない。
  // 電文は都道府県 > 細分区域 > 市町村の階層を持つので細分区域を出す。
  it("震度を観測した地域を震度ごとに出す", () => {
    const [text] = posts("VXSE53");
    expect(text).toContain("震度3 熊本県天草・芦北");
    expect(text).toContain("震度2 熊本県熊本");
  });

  it("観測地域は震度の強い順に並ぶ", () => {
    const [text] = posts("VXSE62");
    const order = [...text.matchAll(/震度([0-9+-]+) /g)].map((m) => m[1]);
    expect(order.slice(0, 4)).toEqual(["7", "6-", "5+", "5-"]);
  });

  it("震源を地域名に重ねて出さない", () => {
    const [text] = posts("VXSE53");
    expect(text).not.toContain("熊本県天草・芦北地方 熊本県天草・芦北地方");
  });

  it("長周期地震動階級は本文に添える", () => {
    const [text] = posts("VXSE62");
    expect(text).toContain("最大震度 7");
    expect(text).toContain("長周期地震動階級 4");
  });

  it("解除は見出しで分かるようにする", () => {
    const [text] = posts("VTSE41");
    expect(text).toContain("【津波注意報 解除】");
    expect(text).toContain("有明・八代海");
    // 見出しに解除を出すので種別名側には残さない
    expect(text).not.toContain("津波注意報解除】");
  });

  it("噴火警報はレベルと変化を出す", () => {
    const [text] = posts("VFVO50");
    expect(text).toContain("【噴火警報】");
    expect(text).toContain("口永良部島");
    expect(text).toContain("レベル２（火口周辺規制）に引上げ");
  });

  it("竜巻注意情報は有効期限を出す", () => {
    const [text] = posts("VPHW50");
    expect(text).toContain("【竜巻注意情報】");
    expect(text).toMatch(/\d{2}:\d{2}まで有効/);
  });

  // 一次細分区域名は単独では通じないものがあるため府県名を補う
  it("府県予報区が1つなら地域名に府県名を補う", () => {
    const [text] = posts("VPHW50");
    expect(text).toContain("千葉県北西部");
    expect(text).toContain("千葉県南部");
  });

  // 北海道のように1通に複数の府県予報区が含まれる場合は補完しない
  it("府県予報区が複数ある電文では府県名を補わない", () => {
    const text = posts("VPWW53").find((t) => t.includes("濃霧注意報"));
    expect(text).toContain("上川地方、留萌地方");
    expect(text).not.toContain("上川地方留萌地方");
  });

  // 電文には府県しか構造化されておらず、地点と雨量は定型の見出し文にしかない
  describe("記録的短時間大雨情報", () => {
    it("見出し文から地点と雨量を取り出して構造化する", () => {
      const [text] = posts("VPOA50");
      expect(text).toContain("長野県 伊那");
      expect(text).toContain("19時10分 1時間あたり 約100mm");
      // 気象庁の定型文をそのまま載せない
      expect(text).not.toContain("記録的短時間大雨。");
      expect(text).not.toContain("猛烈な雨が降っており");
    });

    it("解析できない見出しは原文に戻す", () => {
      const [alert] = alertsOf("VPOA50");
      const text = formatAlerts([
        {
          ...alert,
          detail: {
            ...alert.detail,
            place: null,
            observedAt: null,
            millimeters: null,
            text: "想定外の形式の見出しです",
          },
        },
      ]);
      expect(text).toContain("想定外の形式の見出しです");
    });
  });

  describe("投稿単位のまとめ", () => {
    it("同じ種別・状態の地域は1件の投稿にまとまる", () => {
      const groups = groupForPosting(alertsOf("VPWW53"));
      const fog = groups.find((g) => g[0].detail.kind === "濃霧注意報");
      expect(fog?.length).toBeGreaterThan(1);
      expect(formatAlerts(fog as ClassifiedAlert[])).toContain("、");
    });

    it("種別が違えば別の投稿になる", () => {
      const kinds = groupForPosting(alertsOf("VPWW53")).map(
        (g) => g[0].detail.kind,
      );
      expect(new Set(kinds).size).toBe(kinds.length);
    });
  });

  describe("文字数", () => {
    it.each(ALL_TYPES)("%s の投稿は Bluesky の上限に収まる", (type) => {
      for (const text of posts(type)) {
        expect(graphemes(text)).toBeLessThanOrEqual(MAX_GRAPHEMES);
      }
    });

    // 地域が多い場合は列挙をやめて件数にする
    it("地域が多すぎる場合は件数に置き換える", () => {
      const [alert] = alertsOf("VPWW53");
      const many = Array.from({ length: 60 }, (_, i) => ({
        ...alert,
        area: { name: `テスト地域${i}`, code: String(i) },
      }));
      const text = formatAlerts(many);
      expect(graphemes(text)).toBeLessThanOrEqual(MAX_GRAPHEMES);
      expect(text).toMatch(/ほか\d+地域|^\d+地域$/m);
    });
  });

  describe("共通", () => {
    it.each(ALL_TYPES)("%s の投稿に注記とタグが入る", (type) => {
      for (const text of posts(type)) {
        expect(text).toContain("※テスト運用中です");
        expect(text).toMatch(/#\S+$/);
      }
    });

    // 言語判定の保険としてひらがなとカタカナを混ぜておく
    it("注記にひらがなとカタカナが含まれる", () => {
      const [text] = posts("VXSE53");
      const note = text.split("\n").find((l) => l.startsWith("※")) ?? "";
      expect(note).toMatch(/[ぁ-ゟ]/);
      expect(note).toMatch(/[゠-ヿ]/);
    });

    it("イベントが無ければ空文字を返す", () => {
      expect(formatAlerts([])).toBe("");
    });
  });
});
