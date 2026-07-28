import dotenv from "dotenv";
import { logger } from "../logger.js";
import { NostrPublisher } from "../publisher/nostr.js";
import {
  inspectKey,
  loadProfileConfig,
  normalizePubkey,
  parseArgs,
  resolveSecretKey,
} from "./profile-config.js";

dotenv.config();

const DEFAULT_RELAYS = [
  "wss://relay-jp.shino3.net",
  "wss://yabu.me",
  "wss://r.kojira.io",
  "wss://relay-jp.nostr.wirednet.jp",
];

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const config = loadProfileConfig(args.configPath);

  // --account は npub でも16進数でも指定できるよう、公開鍵に揃えて比較する
  const wanted = args.account ? normalizePubkey(args.account) : null;
  const targets = Object.entries(config.accounts).filter(
    ([key]) => wanted === null || normalizePubkey(key) === wanted,
  );
  if (targets.length === 0) {
    throw new Error(`アカウント ${args.account} は設定に存在しません。`);
  }

  // 発行前に全アカウントの秘密鍵を解決し、途中で失敗して
  // 一部だけ反映された状態にならないようにする
  const resolved = targets.map(([key, account]) => ({
    key,
    account,
    hex: args.dryRun ? "" : resolveSecretKey(key, account.hexEnv, process.env),
  }));

  for (const { key, account, hex } of resolved) {
    const relays = account.relays ?? DEFAULT_RELAYS;
    const name = account.label ? `${account.label} (${key})` : key;
    if (args.dryRun) {
      // 設定のキーと環境変数の鍵が対応しているかを、発行せずに確認できるようにする
      const inspected = inspectKey(account.hexEnv, process.env);
      logger.info(`[dry-run] ${name} の kind 0 は発行しません`, {
        hexEnv: account.hexEnv,
        configuredPubkey: normalizePubkey(key),
        actualPubkey: inspected.pubkey,
        keyStatus: inspected.reason
          ? inspected.reason
          : inspected.pubkey === normalizePubkey(key)
            ? "一致"
            : "不一致: 設定のキーを actualPubkey に差し替えてください",
        relays,
        profile: account.profile,
      });
      continue;
    }
    const publisher = new NostrPublisher(hex, relays);
    try {
      const eventId = await publisher.publishMetadata(account.profile);
      logger.info(`${name} の kind 0 を発行しました`, { eventId, relays });
    } finally {
      publisher.dispose();
    }
  }
};

main().catch((error) => {
  logger.error("プロフィールの発行に失敗しました", { err: error });
  process.exit(1);
});
