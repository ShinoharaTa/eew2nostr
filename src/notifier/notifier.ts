import axios from "axios";
import { logger } from "../logger.js";

export type NotifyLevel = "info" | "success" | "warn" | "error";

const ICON: Record<NotifyLevel, string> = {
  info: "ℹ️",
  success: "✅",
  warn: "⚠️",
  error: "🚨",
};

export interface NotifyResult {
  // Discord へ実際に届いたか
  delivered: boolean;
  // 届かなかった理由。届いた場合は null。
  reason: string | null;
}

export interface NotifierPort {
  notify(
    level: NotifyLevel,
    title: string,
    detail?: string,
  ): Promise<NotifyResult>;
}

// システムの状況を通知する。
//
// 通知内容は Discord の設定有無や送信の成否によらず、必ずコンソールへ出す。
// Discord が届いていない状況でも、サーバのログだけで何が起きたか追えるようにするため。
// 送信の成否もログに残すので、「Discord に届いているか分からない」状態にならない。
export class Notifier implements NotifierPort {
  private failing = false;

  constructor(private webhookUrl: string) {}

  isConfigured(): boolean {
    return this.webhookUrl !== "";
  }

  async notify(
    level: NotifyLevel,
    title: string,
    detail?: string,
  ): Promise<NotifyResult> {
    this.log(level, title, detail);

    if (!this.isConfigured()) {
      const reason = "DISCORD_WEBHOOK_URL が未設定のため送信していません";
      logger.warn(`[通知] ${reason}`);
      return { delivered: false, reason };
    }

    const content = detail
      ? `${ICON[level]} **${title}**\n${detail}`
      : `${ICON[level]} **${title}**`;
    try {
      await axios.post(this.webhookUrl, { content }, { timeout: 10_000 });
      if (this.failing) {
        this.failing = false;
        logger.info("[通知] Discord への送信が復旧しました");
      }
      logger.info("[通知] Discord へ送信しました", { title });
      return { delivered: true, reason: null };
    } catch (e) {
      this.failing = true;
      logger.error("[通知] Discord への送信に失敗しました", { err: e, title });
      return { delivered: false, reason: String(e) };
    }
  }

  private log(level: NotifyLevel, title: string, detail?: string): void {
    const message = detail ? `[通知] ${title}\n${detail}` : `[通知] ${title}`;
    if (level === "error") logger.error(message);
    else if (level === "warn") logger.warn(message);
    else logger.info(message);
  }
}
