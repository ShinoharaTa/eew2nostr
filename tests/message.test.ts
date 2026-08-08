import * as fs from "node:fs";
import * as path from "node:path";
import { classify } from "../src/classify";
import type { ClassifiedAlert } from "../src/classify/types";
import {
  MAX_GRAPHEMES,
  formatAlertPosts,
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

// 同じ種別の別系統 (取消・段階違い) を読む
const alertsOf2 = (type: string, file: string): ClassifiedAlert[] =>
  classify(
    type,
    parseTelegram(
      fs.readFileSync(
        path.join(__dirname, "fixtures/telegrams", file),
        "utf-8",
      ),
    ),
  );

const graphemes = (text: string) => [...text].length;

const ALL_TYPES = [
  "VXSE53",
  "VXSE62",
  "VTSE41",
  "VFVO50",
  "VFVO56",
  "VPWW53",
  "VXWW50",
  "VXKO70",
  "VPHW50",
  "VPOA50",
  "VYSE50",
  "VYSE60",
];

describe("投稿文の生成", () => {
  it("地震情報は発生時刻・震源・最大震度を出す", () => {
    const [text] = posts("VXSE53");
    expect(text).toContain("▽ 📳 地震情報（18:41）");
    expect(text).toContain("震源 熊本県天草・芦北地方 / M3.8");
    expect(text).toContain("🟡 震度3");
  });

  // 震度1〜2は件数が多く、全国配信では読み手の判断にほとんど寄与しない
  describe("地震の観測地域", () => {
    const observed = (groups: { intensity: string; names: string[] }[]) => {
      const [alert] = alertsOf("VXSE62");
      return formatAlertPosts([
        { ...alert, detail: { ...alert.detail, observed: groups } },
      ]);
    };

    it("震度1〜2は載せない", () => {
      const [text] = posts("VXSE53");
      expect(text).toContain("震度3");
      expect(text).not.toContain("震度2");
      expect(text).not.toContain("震度1");
    });

    it("収まるなら1投稿にまとめる", () => {
      expect(posts("VXSE62")).toHaveLength(1);
    });

    // 地震ごとに震度の分布が違うため、固定の境界では偏る
    it("震度の分布に応じて分割数が変わる", () => {
      const many = (n: number) =>
        Array.from({ length: n }, (_, i) => `${i}県北部`);

      // 強い震度が多い形 (東日本大震災型)
      const wide = observed([
        { intensity: "7", names: many(1) },
        { intensity: "6+", names: many(8) },
        { intensity: "6-", names: many(6) },
        { intensity: "5+", names: many(20) },
        { intensity: "5-", names: many(30) },
        { intensity: "4", names: many(60) },
        { intensity: "3", names: many(80) },
      ]);
      // 弱い震度が多い形 (能登半島地震型)
      const narrow = observed([
        { intensity: "7", names: many(1) },
        { intensity: "6+", names: many(2) },
        { intensity: "5+", names: many(5) },
        { intensity: "4", names: many(30) },
        { intensity: "3", names: many(60) },
      ]);
      // 小規模な形 (熊本地震型)
      const small = observed([
        { intensity: "7", names: many(1) },
        { intensity: "5-", names: many(7) },
        { intensity: "4", names: many(8) },
      ]);

      expect(wide.length).toBeGreaterThan(1);
      expect(narrow.length).toBeGreaterThan(1);
      expect(small).toHaveLength(1);
      // どの形でも上限を超えない
      for (const posts of [wide, narrow, small]) {
        for (const text of posts) {
          expect(graphemes(text)).toBeLessThanOrEqual(MAX_GRAPHEMES);
        }
      }
    });

    it("分割時は各投稿の見出しに震度の範囲を出す", () => {
      const many = (n: number) =>
        Array.from({ length: n }, (_, i) => `${i}県北部`);
      const result = observed([
        { intensity: "7", names: many(20) },
        { intensity: "4", names: many(30) },
        { intensity: "3", names: many(30) },
      ]);
      expect(result.length).toBeGreaterThan(1);
      for (const text of result) {
        expect(text).toMatch(/地震情報（\d{2}:\d{2}） 震度/);
      }
    });

    it("1投稿で済む場合は範囲の見出しを付けない", () => {
      const result = observed([
        { intensity: "4", names: ["宮城県北部"] },
        { intensity: "3", names: ["福島県中通り"] },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/地震情報（\d{2}:\d{2}）\n\n/);
    });

    // 気象庁の表記に合わせる
    it("震度は5弱・5強の表記で出す", () => {
      const [text] = posts("VXSE62");
      expect(text).toContain("震度6弱");
      expect(text).toContain("震度5強");
      expect(text).not.toContain("震度6-");
      expect(text).not.toContain("震度5+");
    });

    it("分割後も震源と最大震度は各投稿に残る", () => {
      const many = (n: number, s: string) =>
        Array.from({ length: n }, (_, i) => `${i}県${s}`);
      const result = observed([
        { intensity: "7", names: many(20, "北部") },
        { intensity: "4", names: many(30, "東部") },
        { intensity: "3", names: many(30, "西部") },
      ]);
      expect(result.length).toBeGreaterThan(1);
      for (const text of result) {
        expect(text).toContain("震源 熊本県熊本地方");
        // 見出しにその投稿が扱う震度の範囲が出る
        expect(text).toMatch(/地震情報（\d{2}:\d{2}） 震度/);
      }
      // 最も強い震度は先頭の投稿にある
      expect(result[0]).toContain("🟣 震度7");
    });
  });

  // 震源だけではどの地域が揺れたか伝わらない。
  // 電文は都道府県 > 細分区域 > 市町村の階層を持つので細分区域を出す。
  it("震度を観測した地域を震度ごとに出す", () => {
    const [text] = posts("VXSE53");
    expect(text).toContain("🟡 震度3\n\u3000熊本県天草・芦北");
  });

  it("観測地域は震度の強い順に並ぶ", () => {
    const [text] = posts("VXSE62");
    const order = [...text.matchAll(/^. 震度([0-9]弱|[0-9]強|[0-9])$/gmu)].map(
      (m) => m[1],
    );
    expect(order.slice(0, 4)).toEqual(["7", "6弱", "5強", "5弱"]);
  });

  it("震源を地域名に重ねて出さない", () => {
    const [text] = posts("VXSE53");
    expect(text).not.toContain("熊本県天草・芦北地方 熊本県天草・芦北地方");
  });

  // 地域の粒度は電文の種別によって異なるため、何の区分かを持たせる
  it.each([
    ["VXSE53", "震央地名"],
    ["VPWW53", "一次細分区域"],
    ["VPHW50", "一次細分区域"],
    ["VXWW50", "市町村等"],
    ["VTSE41", "津波予報区"],
    ["VFVO50", "火山"],
    ["VXKO70", "河川"],
  ])("%s の地域区分は %s", (type, areaType) => {
    expect(alertsOf(type)[0].areaType).toBe(areaType);
  });

  // 震度速報は Earthquake 要素を持たず発生時刻が無い
  it("発生時刻が無い震度速報は発表時刻を出す", () => {
    const [text] = posts("VXSE51");
    expect(text).toMatch(/地震情報（\d{2}:\d{2}）/);
  });

  it("長周期地震動階級は本文に添える", () => {
    const [text] = posts("VXSE62");
    expect(text).toContain("🟣 震度7");
    expect(text).toContain("（長周期地震動階級 4）");
  });

  it("解除は見出しで分かるようにする", () => {
    const [text] = posts("VTSE41");
    expect(text).toContain("▽ 🌊 津波注意報 解除");
    expect(text).toContain("有明・八代海");
    // 見出しに解除を出すので種別名側には残さない
    expect(text).not.toContain("津波注意報解除");
    // 解除は危険度を示す色を持たない
    expect(text).not.toMatch(/[🟣🔴🟠🟡⚫⚪]/u);
  });

  it("噴火警報はレベルと変化を出す", () => {
    const [text] = posts("VFVO50");
    expect(text).toContain("🌋 噴火警報 発表");
    expect(text).toContain("口永良部島");
    expect(text).toContain("レベル２（火口周辺規制）に引上げ");
  });

  // 噴火速報は噴火警報より先に出る発生の事実の速報。帯で流す
  it("噴火速報は発生時刻と対象市町村を出す", () => {
    const [text] = posts("VFVO56");
    expect(text).toContain("◤◢◤◢◤◢◤◢◤◢◤◢◤◢\n噴火速報");
    expect(text).toContain("🟣 御嶽山");
    expect(text).toContain("11:53頃 噴火が発生");
    expect(text).toContain("長野県王滝村");
    // 「発表」は重ねない
    expect(text).not.toContain("噴火速報 発表");
  });

  it("南海トラフ地震臨時情報は段階つきの見出しで出す", () => {
    const [text] = posts("VYSE50");
    expect(text).toContain(
      "◤◢◤◢◤◢◤◢◤◢◤◢◤◢\n南海トラフ地震臨時情報（巨大地震警戒）",
    );
    expect(text).toContain("🟣 南海トラフ地震の想定震源域");
    expect(text).toContain("防災対応をとってください。");
    expect(text).toContain("#南海トラフ");
  });

  // 調査終了は段階が見出しに入っているので「解除」を重ねない
  it("調査終了に解除を重ねない", () => {
    const groups = groupForPosting(alertsOf2("VYSE50", "VYSE50-end.xml"));
    const [text] = formatAlertPosts(groups[0]);
    expect(text).toContain("▽ 📳 南海トラフ地震臨時情報（調査終了）");
    expect(text).not.toContain("解除");
  });

  it("後発地震注意情報はタグを出し分ける", () => {
    const [text] = posts("VYSE60");
    expect(text).toContain("北海道・三陸沖後発地震注意情報");
    expect(text).toContain("#後発地震");
    expect(text).not.toContain("#南海トラフ");
  });

  it("竜巻注意情報は有効期限を出す", () => {
    const [text] = posts("VPHW50");
    expect(text).toContain("▽ 🌪️ 竜巻注意情報");
    expect(text).toMatch(/\d{2}:\d{2}まで有効/);
  });

  // 全国に配信するため、地域名には都道府県名を含める
  it("一次細分区域に都道府県名を補う", () => {
    const [text] = posts("VPHW50");
    expect(text).toContain("千葉県北西部");
    expect(text).toContain("千葉県南部");
  });

  // 北海道は府県予報区が上川地方・留萌地方などに分かれる
  it("1通に複数の地域が含まれてもそれぞれに補う", () => {
    const text = posts("VPWW53").find((t) => t.includes("濃霧注意報"));
    expect(text).toContain("北海道上川地方、北海道留萌地方");
  });

  it("市町村にも都道府県名を補う", () => {
    const [text] = posts("VXWW50");
    expect(text).toContain("山形県金山町");
  });

  it("すでに都道府県名で始まる地域には重ねない", () => {
    const [text] = posts("VPOA50");
    expect(text).toContain("長野県");
    expect(text).not.toContain("長野県長野県");
  });

  // 電文に構造化されているのは府県のみ。地点と雨量は見出し文にしかないため、
  // 定型文を解析せず気象庁の発表文をそのまま引く。
  describe("記録的短時間大雨情報", () => {
    it("構造化された府県と発表文を出す", () => {
      const [text] = posts("VPOA50");
      expect(text).toContain("長野県");
      expect(text).toContain("記録的短時間大雨");
      expect(text).toContain("１時間に約１００ミリ");
    });

    it("地域の区分は府県予報区になる", () => {
      expect(alertsOf("VPOA50")[0].areaType).toBe("府県予報区");
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
        expect(text).toMatch(/※テスト運用中です。$/);
        expect(text).toMatch(/#\S+\n\n※/);
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
