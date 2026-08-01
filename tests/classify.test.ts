import * as fs from "node:fs";
import * as path from "node:path";
import { classify, isSupported, supportedTypes } from "../src/classify";
import type { ClassifiedAlert } from "../src/classify/types";
import { parseTelegram } from "../src/receiver/jma-xml";

// 実際に気象庁から取得した電文をそのまま固定し、分類結果を回帰させる
const load = (type: string) =>
  parseTelegram(
    fs.readFileSync(
      path.join(__dirname, "fixtures/telegrams", `${type}.xml`),
      "utf-8",
    ),
  );

const run = (type: string): ClassifiedAlert[] => classify(type, load(type));
const byKey = (alerts: ClassifiedAlert[], key: string) =>
  alerts.find((a) => a.key === key);

describe("classify", () => {
  it("対象外の電文は0件を返す", () => {
    expect(classify("VPFJ50", load("VXSE51"))).toEqual([]);
    expect(classify(null, load("VXSE51"))).toEqual([]);
  });

  // 同一内容の二重配信・誤判定の元になる種別を対象から外していること
  it.each(["VPWW54", "VPWW55", "VPWW56", "VFVO52"])(
    "%s は対象外にしている",
    (type) => {
      expect(isSupported(type)).toBe(false);
    },
  );

  it("採用する電文種別が揃っている", () => {
    expect(supportedTypes()).toEqual(
      expect.arrayContaining([
        "VPWW53",
        "VXSE51",
        "VTSE41",
        "VFVO50",
        "VXWW50",
        "VPHW50",
        "VPOA50",
        "VXKO70",
      ]),
    );
  });

  describe("気象警報・注意報 (VPWW53)", () => {
    const alerts = run("VPWW53");

    it("一次細分区域 × 警報種別ごとに1件生まれる", () => {
      expect(alerts.length).toBeGreaterThan(0);
      for (const a of alerts) {
        expect(a.hazard).toBe("weather");
        expect(a.key).toMatch(/^weather:\d+:\d+$/);
        expect(a.area).not.toBeNull();
      }
    });

    it("地域と警報種別からキーを組み立てる", () => {
      const a = byKey(alerts, "weather:012010:10");
      expect(a?.headline).toBe("上川地方に大雨注意報");
      expect(a?.severity).toBe("advisory");
      expect(a?.detail.attention).toBe("土砂災害注意");
    });

    // 「その地域に警報・注意報はなし」を示す項目は記録しない
    it("警報・注意報なしの項目は除外する", () => {
      for (const a of alerts) {
        expect(a.detail.kind).not.toBe("なし");
        expect(String(a.detail.status)).not.toContain("はなし");
      }
    });

    it("市町村など他の階層を重複して拾わない", () => {
      expect(new Set(alerts.map((a) => a.key)).size).toBe(alerts.length);
    });
  });

  describe("地震 (VXSE51 / VXSE53)", () => {
    it("同じ地震の続報は同じキーになる", () => {
      const first = run("VXSE51")[0];
      const second = run("VXSE53")[0];
      expect(first.key).toBe(second.key);
      expect(first.key).toMatch(/^earthquake:\d+$/);
    });

    it("実測震度から緊急度を決める", () => {
      const a = run("VXSE53")[0];
      expect(a.hazard).toBe("earthquake");
      expect(a.detail.maxInt).toBe("3");
      expect(a.severity).toBe("info");
    });

    it("震源とマグニチュードを保持する", () => {
      const a = run("VXSE53")[0];
      expect(a.area?.name).toBe("熊本県天草・芦北地方");
      expect(a.detail.magnitude).toBe("3.8");
    });
  });

  describe("長周期地震動 (VXSE62)", () => {
    const alerts = run("VXSE62");

    // 震度は MaxInt、長周期地震動階級は MaxLgInt と別フィールドで届く
    it("震度と長周期地震動階級を両方保持する", () => {
      expect(alerts).toHaveLength(1);
      expect(alerts[0].detail.maxInt).toBe("7");
      expect(alerts[0].detail.maxLgInt).toBe("4");
    });

    it("震度と階級のうち高い方で緊急度を決める", () => {
      expect(alerts[0].severity).toBe("emergency");
    });

    it("同じ地震なので震度速報と同じキーになる", () => {
      expect(alerts[0].key).toMatch(/^earthquake:\d+$/);
    });
  });

  describe("津波 (VTSE41)", () => {
    const alerts = run("VTSE41");

    it("津波予報区ごとに1件、解除を state に反映する", () => {
      const a = alerts[0];
      expect(a.hazard).toBe("tsunami");
      expect(a.key).toBe("tsunami:712");
      expect(a.state).toBe("resolved");
      expect(a.headline).toBe("有明・八代海に津波注意報解除");
      expect(a.detail.lastKind).toBe("津波注意報");
    });
  });

  describe("火山 (VFVO50)", () => {
    const alerts = run("VFVO50");

    it("噴火警戒レベルから緊急度を決める", () => {
      const a = byKey(alerts, "volcano:509");
      expect(a?.hazard).toBe("volcano");
      expect(a?.detail.level).toBe(2);
      expect(a?.severity).toBe("advisory");
      expect(a?.state).toBe("active");
      expect(a?.detail.condition).toBe("引上げ");
    });

    it("対象火山以外のブロックは拾わない", () => {
      for (const a of alerts) expect(a.key).toMatch(/^volcano:\d+$/);
    });
  });

  describe("土砂災害警戒情報 (VXWW50)", () => {
    it("全解除の電文では解除だけが残る", () => {
      const alerts = run("VXWW50");
      // Kind.Name が「なし」の項目は除外されるため、残るのは解除のみ
      for (const a of alerts) {
        expect(a.hazard).toBe("sediment");
        expect(a.key).toMatch(/^sediment:\d+$/);
      }
    });
  });

  describe("竜巻注意情報 (VPHW50)", () => {
    const alerts = run("VPHW50");

    it("一次細分区域ごとに advisory として記録する", () => {
      expect(alerts.length).toBeGreaterThan(0);
      for (const a of alerts) {
        expect(a.hazard).toBe("tornado");
        expect(a.severity).toBe("advisory");
        expect(a.key).toMatch(/^tornado:\d+$/);
      }
    });

    // 解除電文が無いため、失効は有効期限で判断する必要がある
    it("有効期限を保持する", () => {
      expect(alerts[0].expiresAt).not.toBeNull();
      expect(
        Number.isNaN(new Date(alerts[0].expiresAt as string).getTime()),
      ).toBe(false);
    });
  });

  describe("記録的短時間大雨情報 (VPOA50)", () => {
    it("warning として記録する", () => {
      const a = run("VPOA50")[0];
      expect(a.hazard).toBe("heavy-rain");
      expect(a.severity).toBe("warning");
      expect(a.headline).toContain("記録的短時間大雨");
      expect(a.area?.name).toBe("長野県");
    });
  });

  describe("指定河川洪水予報 (VXKO70)", () => {
    const alerts = run("VXKO70");

    it("河川ごとに1件、解除を state に反映する", () => {
      expect(alerts.length).toBeGreaterThan(0);
      for (const a of alerts) {
        expect(a.hazard).toBe("flood");
        expect(a.key).toMatch(/^flood:\d+$/);
        expect(a.state).toBe("resolved");
      }
    });

    it("河川名を保持する", () => {
      expect(alerts[0].detail.river).toBe("太平川");
    });
  });

  describe("共通", () => {
    it("すべての結果が必須項目を持つ", () => {
      for (const type of [
        "VPWW53",
        "VXSE53",
        "VTSE41",
        "VFVO50",
        "VPHW50",
        "VPOA50",
        "VXKO70",
      ]) {
        for (const a of run(type)) {
          expect(a.key).toBeTruthy();
          expect(a.headline).toBeTruthy();
          expect(a.reportedAt).toBeTruthy();
          expect(["active", "resolved", "finalized", "cancelled"]).toContain(
            a.state,
          );
          expect(["emergency", "warning", "advisory", "info"]).toContain(
            a.severity,
          );
        }
      }
    });
  });
});
