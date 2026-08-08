import { eewAlert, eewCancelAlert, eewStatusKey } from "../classify/eew.js";
import type { EEWParser } from "../core/parser.js";
import { logger } from "../logger.js";
import type { AlertRecorder } from "../store/alert-recorder.js";
import type { StatusManager } from "../store/status-manager.js";
import type { JsonSchema } from "../types/eew";

// 生電文をそのまま流す側路。リプライツリーとは無関係。
export interface RawPublisher {
  publishRaw(content: string, time: Date): Promise<string>;
}

// dmdata から受けた緊急地震速報を、気象庁フィードと同じ
// 記録 → ルーティング → 配信の経路に合流させる。
//
// 以前は専用の PublishDispatcher が無印の環境変数 (HEX など) で直接
// 投稿していたため、routing.json の eew アカウントが使われていなかった。
export class EEWPipeline {
  constructor(
    private parser: EEWParser,
    private recorder: AlertRecorder,
    private status: StatusManager,
    private raw?: RawPublisher,
  ) {}

  async handle(telegram: JsonSchema): Promise<void> {
    const parsed = this.parser.parse(telegram);
    if (parsed.type === "ignore") return;

    if (parsed.type === "cancelled") {
      // 取り消す対象が流れていないのに「取り消されました」だけが
      // 出ると混乱を招くため、記録が無ければ投稿しない。
      if (!this.status.get(eewStatusKey(parsed.id))) {
        logger.info("取消報を受信しましたが対象の記録がありません", {
          key: eewStatusKey(parsed.id),
        });
        return;
      }
      await this.recorder.recordAlerts([eewCancelAlert(parsed.id)]);
      return;
    }

    await this.recorder.recordAlerts([eewAlert(parsed.report)]);

    // 生電文 (kind 7078)。投稿の成否と切り離して流す。
    if (this.raw) {
      void this.raw
        .publishRaw(JSON.stringify(telegram), parsed.report.reportTime)
        .catch((e) => {
          logger.error("生電文の投稿に失敗しました", { err: e });
        });
    }
  }
}
