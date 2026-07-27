import axios from "axios";
import { logger } from "../logger.js";

// システム状況・投稿失敗などを Discord Webhook に通知する。
// 通知の失敗は本体の動作を止めない(ログに残すだけ)。
export class DiscordNotifier {
  constructor(private webhookUrl: string) {}

  async notify(message: string): Promise<void> {
    if (!this.webhookUrl) {
      logger.warn(`Discord webhook is not configured. message: ${message}`);
      return;
    }
    try {
      await axios.post(this.webhookUrl, { content: message });
    } catch (e) {
      logger.error("Discord notification failed", {
        err: e,
        notification: message,
      });
    }
  }
}
