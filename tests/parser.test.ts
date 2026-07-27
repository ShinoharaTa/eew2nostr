import * as fs from "node:fs";
import * as path from "node:path";
import { EEWParser, type EEWReport } from "../src/core/parser";
import type { JsonSchema } from "../src/types/eew";

const loadSample = (filename: string) =>
  JSON.parse(
    fs.readFileSync(path.join(__dirname, "../sampleData", filename), "utf-8"),
  );

describe("EEWParser", () => {
  const parser = new EEWParser();

  describe("objectMapping", () => {
    it("単報の電文をマッピングできる", () => {
      const telegram: JsonSchema = loadSample("eew_single..json");
      const report = parser.objectMapping(telegram);
      expect(report).not.toBe("cancel");
      const r = report as EEWReport;
      expect(r.id).toBe("20240109012003");
      expect(r.serial).toBe("5");
      expect(r.isLast).toBe(true);
      expect(r.place).toBe("石川県能登地方");
      expect(r.magnitude).toBe("3.5");
      expect(r.forecast).toBe("3");
      expect(r.forecastLg).toBe("0");
      expect(r.latitude).toBeCloseTo(37.2);
      expect(r.longitude).toBeCloseTo(136.8);
      expect(r.depth).toBe(10);
    });

    it("earthquake を含まない電文は cancel を返す", () => {
      const telegram: JsonSchema = loadSample("eew_single..json");
      const canceled = {
        ...telegram,
        body: { ...telegram.body, earthquake: undefined },
      };
      expect(parser.objectMapping(canceled as JsonSchema)).toBe("cancel");
    });

    it("eventId が無い電文は cancel を返す", () => {
      const telegram: JsonSchema = loadSample("eew_single..json");
      expect(parser.objectMapping({ ...telegram, eventId: null })).toBe(
        "cancel",
      );
    });

    it("連続電文をすべてマッピングできる", () => {
      const telegrams: JsonSchema[] = loadSample("eew_multi.json");
      for (const telegram of telegrams) {
        const report = parser.objectMapping(telegram);
        expect(report).not.toBe("cancel");
      }
    });
  });

  describe("generateEEWMessage", () => {
    it("最終報のメッセージを生成できる", () => {
      const telegram: JsonSchema = loadSample("eew_single..json");
      const report = parser.objectMapping(telegram) as EEWReport;
      const message = parser.generateEEWMessage(report);
      expect(message).toContain("【緊急地震速報】");
      expect(message).toContain("(最終報)");
      expect(message).toContain("石川県能登地方");
      expect(message).toContain("震度 3（M3.5）");
      expect(message).not.toContain("長周期地震動階級");
      expect(message).toContain("#eew");
    });

    it("続報は第n報として表示される", () => {
      const telegram: JsonSchema = loadSample("eew_single..json");
      const report = parser.objectMapping(telegram) as EEWReport;
      const message = parser.generateEEWMessage({
        ...report,
        isLast: false,
        serial: "2",
      });
      expect(message).toContain("(第2報)");
    });
  });
});
