import dotenv from "dotenv";
import { EEWParser } from "./core/parser.js";
import { AsyncQueue } from "./core/queue.js";
import { logger } from "./logger.js";
import { DiscordNotifier } from "./notifier/discord.js";
import { BskyPublisher } from "./publisher/bsky.js";
import { ConcrntPublisher } from "./publisher/concrnt.js";
import { PublishDispatcher } from "./publisher/dispatcher.js";
import { NostrPublisher } from "./publisher/nostr.js";
import { DmdataReceiver } from "./receiver/dmdata.js";
import { JmaFeedReceiver } from "./receiver/jma-feed.js";
import { NostrStatusMirror } from "./store/relay-mirror.js";
import { SqliteStatusStore } from "./store/sqlite-store.js";
import { StatusManager } from "./store/status-manager.js";
import type { JsonSchema } from "./types/eew";

dotenv.config();
const {
  EEW_TOKEN,
  HEX,
  BSKY_IDENTIFIER,
  BSKY_PASSWORD,
  CONCRNT_SUBKEY,
  CONCRNT_CHANNEL,
  DISCORD_WEBHOOK_URL,
  STATUS_DB_PATH,
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
  const discord = new DiscordNotifier(DISCORD_WEBHOOK_URL ?? "");
  const nostr = new NostrPublisher(HEX ?? "", relays);
  const bsky = new BskyPublisher(BSKY_IDENTIFIER ?? "", BSKY_PASSWORD ?? "");
  const concrnt = new ConcrntPublisher(CONCRNT_SUBKEY ?? "", CONCRNT_CHANNEL);
  await bsky.init();
  await concrnt.init();

  const store = new SqliteStatusStore(STATUS_DB_PATH ?? "./data/status.db");
  await store.init();
  // ミラーは宛先が違うだけなので、接続プールは投稿用と共有する
  const status = new StatusManager(
    store,
    new NostrStatusMirror(nostr, statusRelays),
  );
  await status.init();

  const dispatcher = new PublishDispatcher(
    new EEWParser(),
    nostr,
    bsky,
    concrnt,
    discord,
    status,
  );

  // 取得層と配信層は内部キューで接続する
  const queue = new AsyncQueue<JsonSchema>();
  const consume = async () => {
    while (true) {
      const telegram = await queue.pop();
      try {
        await dispatcher.handle(telegram);
      } catch (e) {
        logger.error("failed to dispatch telegram", { err: e });
      }
    }
  };
  consume();

  // 気象庁フィードの受信。分類と配信 (#20) はまだ入っていないため、
  // 受信できていることをログで確認するに留める。
  const jma = new JmaFeedReceiver(
    { feeds: jmaFeeds },
    {
      onTelegram: (telegram) => {
        logger.info("jma telegram received", {
          type: telegram.type,
          title: telegram.title,
          eventId: telegram.report.head.eventId,
          infoType: telegram.report.head.infoType,
          serial: telegram.report.head.serial,
          headline: telegram.report.head.headline,
        });
      },
      onFailure: (message, err) => {
        logger.error("jma feed unavailable", { err });
        void discord.notify(`🚨 ${message}`);
      },
      onRecovery: (message) => {
        void discord.notify(`✅ ${message}`);
      },
    },
  );

  // リレー接続と DB を明示的に閉じてから終了する
  const shutdown = async (code: number) => {
    jma.stop();
    nostr.dispose();
    await store.close();
    process.exit(code);
  };

  const receiver = new DmdataReceiver(EEW_TOKEN ?? "", {
    onTelegram: (telegram) => queue.push(telegram),
    onDisconnect: async (reason) => {
      await discord.notify(`🚨 ${reason}`);
      await shutdown(0);
    },
  });
  try {
    await receiver.start();
    jma.start();
    await discord.notify("✅ EEW System start");
  } catch (error) {
    logger.error("failed to start EEW System", { err: error });
    await discord.notify(`🚨 EEW System の起動に失敗しました。\n${error}`);
    await shutdown(1);
  }
};

main();
