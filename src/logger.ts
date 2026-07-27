import * as fs from "node:fs";
import * as winston from "winston";

// ログディレクトリの確認と作成
const logDir = "./log";
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Error はプロパティが非列挙のため JSON.stringify では {} になる。
// axios のエラーなど循環参照を含むオブジェクトも渡ってくるため、
// どちらも潰さずに文字列化する。
const safeStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(
    value,
    (_key, val) => {
      if (val instanceof Error) {
        return { name: val.name, message: val.message, stack: val.stack };
      }
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      if (typeof val === "bigint") return val.toString();
      return val;
    },
    2,
  );
  return json ?? String(value);
};

// printf が出す固定項目。これ以外の情報は構造化メタとして展開する。
// winston はメタをこの info に混ぜ込むため、メタのキーにこれらを使うと
// ログ行が壊れる (例: {message: "..."} はメッセージ本文に連結される)。
const RESERVED = new Set(["level", "message", "timestamp", "stack"]);

const readable = winston.format.printf((info) => {
  const message =
    typeof info.message === "object" && info.message !== null
      ? safeStringify(info.message)
      : String(info.message);
  const lines = [`${info.timestamp} [${info.level.toUpperCase()}]: ${message}`];
  if (typeof info.stack === "string") lines.push(info.stack);
  const meta = Object.fromEntries(
    Object.entries(info).filter(([key]) => !RESERVED.has(key)),
  );
  if (Object.keys(meta).length > 0) lines.push(safeStringify(meta));
  return lines.join("\n");
});

export const logFormat = winston.format.combine(
  // Error を渡したときにスタックトレースを保つ
  winston.format.errors({ stack: true }),
  winston.format.timestamp({
    format: "YYYY-MM-DD HH:mm:ss",
  }),
  readable,
);

// シングルトンクラスを定義
class LoggerService {
  private static instance: LoggerService;
  public logger: winston.Logger;

  private constructor() {
    this.logger = winston.createLogger({
      level: "info",
      format: logFormat,
      transports: [
        new winston.transports.Console(),
        new winston.transports.File({
          filename: "./log/out.log",
          // 無制限に追記されないようサイズで打ち切って世代を回す
          maxsize: 10 * 1024 * 1024,
          maxFiles: 5,
          tailable: true,
        }),
      ],
    });
  }

  // シングルトンインスタンスを取得するメソッド
  public static getInstance(): LoggerService {
    if (!LoggerService.instance) {
      LoggerService.instance = new LoggerService();
    }
    return LoggerService.instance;
  }
}

// ロガーを直接エクスポート
export const logger = LoggerService.getInstance().logger;
