import dotenv from "dotenv";
import { EEWParser } from "./core/parser.js";
import { AsyncQueue } from "./core/queue.js";
import { logger } from "./logger.js";
import { Notifier } from "./notifier/notifier.js";
import {
  type Counters,
  heartbeatSummary,
  newCounters,
  startupSummary,
} from "./notifier/status-report.js";
import {
  buildAccounts,
  disposeAccounts,
  initAccounts,
} from "./publisher/account.js";
import { Delivery } from "./publisher/delivery.js";
import { EEWPipeline } from "./publisher/eew-pipeline.js";
import { NostrPublisher } from "./publisher/nostr.js";
import { DmdataReceiver } from "./receiver/dmdata.js";
import { SqliteFeedCursorStore } from "./receiver/feed-cursor.js";
import { JmaFeedReceiver, type JmaTelegram } from "./receiver/jma-feed.js";
import {
  DEFAULT_ROUTING_CONFIG_PATH,
  loadRoutingConfig,
} from "./routing/config.js";
import { Router } from "./routing/router.js";
import { AlertRecorder } from "./store/alert-recorder.js";
import { NostrStatusMirror } from "./store/relay-mirror.js";
import { SqliteStatusStore } from "./store/sqlite-store.js";
import { StatusManager } from "./store/status-manager.js";
import type { JsonSchema } from "./types/eew";

dotenv.config();
const {
  EEW_TOKEN,
  HEX,
  DISCORD_WEBHOOK_URL,
  STATUS_DB_PATH,
  ROUTING_CONFIG_PATH,
  HEARTBEAT_HOURS,
} = process.env;

const relays = [
  "wss://relay-jp.shino3.net",
  "wss://yabu.me",
  "wss://r.kojira.io",
  "wss://relay-jp.nostr.wirednet.jp",
];

// ステータスのミラー先。自前リレーのみに保持する。
const statusRelays = ["wss://relay-jp.shino3.net"];

// 緊急地震速報は気象庁の公開フィードに含まれないため dmdata から受け取る。
// それ以外 (津波・火山・気象警報など) はこのフィードから取得する。
const jmaFeeds = [
  // 高頻度（地震火山）: 津波警報・注意報、震度速報、震源・震度情報、火山
  "https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml",
  // 高頻度（随時）: 気象警報・注意報、竜巻注意情報など
  "https://www.data.jma.go.jp/developer/xml/feed/extra.xml",
];

const main = async () => {
  const startedAt = new Date();
  const counters = newCounters();
  const notifier = new Notifier(DISCORD_WEBHOOK_URL ?? "");

  // 何よりも先に起動を知らせる。以降の初期化で止まっても
  // 「起動したことは分かる」状態にするため。
  const first = await notifier.notify("info", "EEW System を起動しています");
  if (!first.delivered) {
    logger.warn(
      "Discord へ通知できていません。以降の通知はコンソールのみに出ます",
      { reason: first.reason },
    );
  }

  // 無印の HEX はステータスミラーと生電文の投稿に使う。
  // SNS への投稿は routing.json のアカウント (HEX_EEW など) が担う。
  const nostr = new NostrPublisher(HEX ?? "", relays);

  const store = new SqliteStatusStore(STATUS_DB_PATH ?? "./data/status.db");
  await store.init();
  // ミラーは宛先が違うだけなので、接続プールは投稿用と共有する
  const status = new StatusManager(
    store,
    new NostrStatusMirror(nostr, statusRelays),
  );
  await status.init();

  // 配信先の定義。鍵が未設定の経路は投稿せず、
  // コンソールに出すテストモードとして動く。
  const routingConfig = loadRoutingConfig(
    ROUTING_CONFIG_PATH ?? DEFAULT_ROUTING_CONFIG_PATH,
  );
  const router = new Router(routingConfig);
  const accounts = buildAccounts(routingConfig, relays);
  await initAccounts(accounts);
  const delivery = new Delivery(accounts, router, status, notifier, () => {
    counters.delivered += 1;
  });

  const recorder = new AlertRecorder(status, router, delivery);

  // 緊急地震速報も気象庁フィードと同じ記録 → 配信の経路に合流させる。
  // 取得層と配信層は内部キューで接続する。
  const pipeline = new EEWPipeline(new EEWParser(), recorder, status, nostr);
  const queue = new AsyncQueue<JsonSchema>();
  const consume = async () => {
    while (true) {
      const telegram = await queue.pop();
      counters.receivedDmdata += 1;
      try {
        await pipeline.handle(telegram);
      } catch (e) {
        counters.failures += 1;
        logger.error("failed to dispatch telegram", { err: e });
      }
    }
  };
  consume();

  const jmaQueue = new AsyncQueue<JmaTelegram>();
  const consumeJma = async () => {
    while (true) {
      const telegram = await jmaQueue.pop();
      counters.receivedJma += 1;
      try {
        counters.recorded += await recorder.record(telegram);
      } catch (e) {
        counters.failures += 1;
        logger.error("failed to record jma telegram", {
          url: telegram.url,
          err: e,
        });
      }
    }
  };
  consumeJma();

  // 再起動をまたいで処理済みを保つ。これが無いと起動のたびに
  // フィード全件を既読化し、停止中の電文を取りこぼす。
  const cursors = new SqliteFeedCursorStore(store.handle());
  const jma = new JmaFeedReceiver(
    { feeds: jmaFeeds, cursors },
    {
      onTelegram: (telegram) => jmaQueue.push(telegram),
      onFailure: (message, err) => {
        logger.error("jma feed unavailable", { err });
        void notifier.notify("error", "気象庁フィードの取得に失敗", message);
      },
      onRecovery: (message) => {
        void notifier.notify("success", "気象庁フィードの取得が復旧", message);
      },
    },
  );

  // リレー接続と DB を明示的に閉じてから終了する
  const shutdown = async (code: number) => {
    jma.stop();
    disposeAccounts(accounts);
    nostr.dispose();
    await store.close();
    process.exit(code);
  };

  const receiver = new DmdataReceiver(EEW_TOKEN ?? "", {
    onTelegram: (telegram) => queue.push(telegram),
    onDisconnect: async (reason) => {
      await notifier.notify("error", "受信が切断されました", reason);
      await shutdown(0);
    },
  });
  try {
    await receiver.start();
    await jma.restore();
    jma.start();

    // 何が設定されていて何が動くのかを一覧で知らせる。
    // 「起動したが動いているか分からない」状態を避けるため。
    const summary = startupSummary({
      dmdata: (EEW_TOKEN ?? "") !== "",
      jmaFeeds,
      statusDbPath: STATUS_DB_PATH ?? "./data/status.db",
      accounts: router.accounts(),
      discordConfigured: notifier.isConfigured(),
    });
    await notifier.notify("success", "EEW System が起動しました", summary);

    startHeartbeat(notifier, counters, startedAt);
  } catch (error) {
    logger.error("failed to start EEW System", { err: error });
    await notifier.notify("error", "起動に失敗しました", String(error));
    await shutdown(1);
  }
};

// 何も起きない時間が続くと、動いているのか止まっているのか分からない。
// 定期的に稼働していることを伝える。
const startHeartbeat = (
  notifier: Notifier,
  counters: Counters,
  startedAt: Date,
): void => {
  const hours = Number(HEARTBEAT_HOURS ?? "6");
  if (!Number.isFinite(hours) || hours <= 0) {
    logger.info("稼働報告は無効です", { HEARTBEAT_HOURS });
    return;
  }
  logger.info("稼働報告を開始します", { intervalHours: hours });
  setInterval(
    () => {
      void notifier.notify(
        "info",
        "稼働中です",
        heartbeatSummary(counters, startedAt),
      );
    },
    hours * 60 * 60_000,
  ).unref();
};

main();
