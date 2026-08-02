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
      const parsed = parser.parse(telegram);
      expect(parsed.type).toBe("report");
      const r = (parsed as { type: "report"; report: EEWReport }).report;
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
      expect(parser.parse(canceled as JsonSchema).type).toBe("ignore");
    });

    it("eventId が無い電文は cancel を返す", () => {
      const telegram: JsonSchema = loadSample("eew_single..json");
      expect(parser.parse({ ...telegram, eventId: null }).type).toBe("ignore");
    });

    it("連続電文をすべてマッピングできる", () => {
      const telegrams: JsonSchema[] = loadSample("eew_multi.json");
      for (const telegram of telegrams) {
        expect(parser.parse(telegram).type).toBe("report");
      }
    });
  });

  // 以前は「地震要素が無い」と「取消」を同じ扱いにしており、
  // 取消が記録にも配信にも反映されていなかった
  describe("取消報", () => {
    it("infoType が取消なら cancelled を返す", () => {
      const telegram: JsonSchema = loadSample("eew_single..json");
      const parsed = parser.parse({ ...telegram, infoType: "取消" });
      expect(parsed).toEqual({ type: "cancelled", id: "20240109012003" });
    });

    it("isCanceled が立っていれば cancelled を返す", () => {
      const telegram: JsonSchema = loadSample("eew_single..json");
      const parsed = parser.parse({
        ...telegram,
        body: { ...telegram.body, isCanceled: true, earthquake: undefined },
      } as JsonSchema);
      expect(parsed.type).toBe("cancelled");
    });

    it("eventId が無ければ取消と判定しない", () => {
      const telegram: JsonSchema = loadSample("eew_single..json");
      const parsed = parser.parse({
        ...telegram,
        infoType: "取消",
        eventId: null,
      });
      expect(parsed.type).toBe("ignore");
    });

    it("取消の文面を組み立てられる", () => {
      const message = parser.generateCancelMessage();
      expect(message).toContain("【緊急地震速報 取消】");
      expect(message).toContain("取り消されました");
    });
  });

  describe("generateEEWMessage", () => {
    it("最終報のメッセージを生成できる", () => {
      const telegram: JsonSchema = loadSample("eew_single..json");
      const report = (
        parser.parse(telegram) as { type: "report"; report: EEWReport }
      ).report;
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
      const report = (
        parser.parse(telegram) as { type: "report"; report: EEWReport }
      ).report;
      const message = parser.generateEEWMessage({
        ...report,
        isLast: false,
        serial: "2",
      });
      expect(message).toContain("(第2報)");
    });
  });
});
