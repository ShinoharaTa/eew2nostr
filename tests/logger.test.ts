import { Writable } from "node:stream";
import * as winston from "winston";
import { logFormat } from "../src/logger";

// logFormat を使うロガーを立て、出力行を配列で受け取る
const createCapturingLogger = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString().trimEnd());
      callback();
    },
  });
  const logger = winston.createLogger({
    level: "info",
    format: logFormat,
    transports: [new winston.transports.Stream({ stream })],
  });
  return { logger, lines };
};

describe("logFormat", () => {
  it("Error のスタックトレースを残す", () => {
    const { logger, lines } = createCapturingLogger();
    logger.error(new Error("これはErrorオブジェクト"));

    expect(lines[0]).toContain("[ERROR]: これはErrorオブジェクト");
    expect(lines[0]).toContain("Error: これはErrorオブジェクト");
    expect(lines[0]).toContain("at ");
  });

  it("メタに入れた Error もスタックトレースごと出す", () => {
    const { logger, lines } = createCapturingLogger();
    logger.error("failed to decompress telegram", {
      err: new Error("gunzip failed"),
    });

    expect(lines[0]).toContain("[ERROR]: failed to decompress telegram");
    expect(lines[0]).toContain("gunzip failed");
    // Error のプロパティは非列挙なので、素の JSON.stringify では {} になる
    expect(lines[0]).toContain('"stack"');
    expect(lines[0]).not.toContain('"err": {}');
  });

  it("メッセージに渡したオブジェクトの中身を出す", () => {
    const { logger, lines } = createCapturingLogger();
    logger.info({ type: "data", head: { test: false } });

    expect(lines[0]).not.toContain("[object Object]");
    expect(lines[0]).toContain('"type": "data"');
    expect(lines[0]).toContain('"test": false');
  });

  it("第2引数の構造化メタを捨てない", () => {
    const { logger, lines } = createCapturingLogger();
    logger.info("telegram received", {
      id: "abc123",
      head: { type: "VXSE45" },
    });

    expect(lines[0]).toContain("[INFO]: telegram received");
    expect(lines[0]).toContain('"id": "abc123"');
    expect(lines[0]).toContain('"type": "VXSE45"');
  });

  it("循環参照を含むオブジェクトでも落ちない", () => {
    const { logger, lines } = createCapturingLogger();
    const circular: Record<string, unknown> = { name: "axios error" };
    circular.self = circular;

    expect(() =>
      logger.error("request failed", { err: circular }),
    ).not.toThrow();
    expect(lines[0]).toContain('"name": "axios error"');
    expect(lines[0]).toContain("[Circular]");
  });

  it("メタが無いときは1行のまま", () => {
    const { logger, lines } = createCapturingLogger();
    logger.info("web socket start");

    expect(lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[INFO\]: web socket start$/,
    );
  });

  // winston はメタを info に混ぜ込むため、message などの予約キーを
  // メタに使うとログ行が壊れる。呼び出し側で避ける必要がある。
  it("メタに予約キー message を使うとログ行が壊れる (呼び出し側で避ける)", () => {
    const { logger, lines } = createCapturingLogger();
    logger.error("Discord notification failed", {
      message: "EEW System start",
    });

    expect(lines[0]).toContain("Discord notification failed EEW System start");
  });
});
