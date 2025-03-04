import * as fs from "node:fs";
import * as winston from "winston";

// ログディレクトリの確認と作成
const logDir = "./log";
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// シングルトンクラスを定義
class LoggerService {
  private static instance: LoggerService;
  public logger: winston.Logger;

  private constructor() {
    // ご指定の通りにロガーを設定
    this.logger = winston.createLogger({
      level: "info", // ログレベルの設定
      format: winston.format.combine(
        winston.format.timestamp({
          format: "YYYY-MM-DD HH:mm:ss",
        }),
        winston.format.printf(
          (info) =>
            `${info.timestamp} [${info.level.toUpperCase()}]: ${info.message}`,
        ),
      ),
      transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: "./log/out.log" }),
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
