import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseFeed,
  parseTelegram,
  telegramTypeFromUrl,
} from "../src/receiver/jma-xml";

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, "fixtures", name), "utf-8");

describe("parseFeed", () => {
  const entries = parseFeed(fixture("feed-eqvol.xml"));

  it("エントリを取り出せる", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.id).toMatch(/^https:\/\//);
      expect(entry.url).toMatch(/\.xml$/);
      expect(entry.title).not.toBe("");
      expect(Number.isNaN(new Date(entry.updated).getTime())).toBe(false);
    }
  });

  it("id は電文XMLのURLで一意になる", () => {
    const ids = new Set(entries.map((entry) => entry.id));
    expect(ids.size).toBe(entries.length);
  });

  it("フィードは新しい順に並んでいる", () => {
    const times = entries.map((entry) => new Date(entry.updated).getTime());
    const sorted = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sorted);
  });

  it("entry が無いフィードでも落ちない", () => {
    const empty = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom"><title>空</title></feed>`;
    expect(parseFeed(empty)).toEqual([]);
  });

  it("entry が1件だけでも配列で返る", () => {
    const single = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>震度速報</title>
          <id>https://example.test/20260728084817_0_VXSE51_010000.xml</id>
          <updated>2026-07-28T08:48:17Z</updated>
          <link type="application/xml" href="https://example.test/20260728084817_0_VXSE51_010000.xml"/>
        </entry>
      </feed>`;
    const parsed = parseFeed(single);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe("震度速報");
  });
});

describe("parseTelegram", () => {
  const report = parseTelegram(fixture("telegram-VXSE53.xml"));

  it("Control と Head を取り出せる", () => {
    expect(report.control.title).toBe("震源・震度に関する情報");
    expect(report.control.status).toBe("通常");
    expect(report.control.publishingOffice).toBe("気象庁");
    expect(report.head.eventId).toBe("20260728174504");
    expect(report.head.infoType).toBe("発表");
    expect(report.head.serial).toBe("1");
    expect(report.head.headline).toContain("地震がありました");
  });

  it("Body は種別ごとの分類器に渡せる形で保持する", () => {
    expect(report.body).toBeDefined();
    expect(Object.keys(report.body).length).toBeGreaterThan(0);
  });

  it("名前空間接頭辞を落として素直な形にする", () => {
    // jmx_eb:Magnitude が Magnitude として引ける
    const earthquake = (report.body as Record<string, Record<string, unknown>>)
      .Earthquake;
    expect(earthquake.Magnitude).toBeDefined();
  });

  it("震度など文字列の値を数値に変換しない", () => {
    const body = report.body as Record<string, Record<string, unknown>>;
    const maxInt = (body.Intensity?.Observation as Record<string, unknown>)
      ?.MaxInt;
    expect(typeof maxInt).toBe("string");
  });

  it("Report 要素が無ければ例外にする", () => {
    expect(() => parseTelegram("<?xml version='1.0'?><Other/>")).toThrow();
  });
});

describe("telegramTypeFromUrl", () => {
  it("URL から電文種別コードを取り出す", () => {
    expect(
      telegramTypeFromUrl(
        "https://www.data.jma.go.jp/developer/xml/data/20260728084817_0_VXSE53_010000.xml",
      ),
    ).toBe("VXSE53");
    expect(telegramTypeFromUrl(".../20260728080036_0_VPWW55_270000.xml")).toBe(
      "VPWW55",
    );
  });

  it("形式が違う URL では null を返す", () => {
    expect(telegramTypeFromUrl("https://example.test/index.html")).toBeNull();
  });
});
