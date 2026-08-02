import dotenv from "dotenv";
import { npubEncode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
import { logger } from "../logger.js";
import { DiscordNotifier } from "../notifier/discord.js";
import { NostrPublisher } from "../publisher/nostr.js";
import { collectTestNotes } from "./cleanup.js";
import {
  type TestPostArgs,
  availableTypes,
  parseArgs,
  postsForTelegram,
} from "./plan.js";

dotenv.config();

// 過去のテスト投稿を集めて NIP-09 の削除イベントを流す。
// テスト投稿がタイムラインに残り続けるのを防ぐ。
const cleanup = async (
  args: TestPostArgs,
  hex: string | undefined,
  pubkey: string | null,
): Promise<void> => {
  if (!pubkey) throw new Error("鍵が無いため削除対象を特定できません。");
  const notes = await collectTestNotes(pubkey, args.relays);
  logger.info("削除対象のテスト投稿", {
    count: notes.length,
    relays: args.relays,
  });
  for (const note of notes) {
    logger.info(`  ${note.id.slice(0, 16)}… ${note.content.split("\n")[0]}`);
  }
  if (notes.length === 0) return;
  if (args.dryRun || !hex) {
    logger.info("[dry-run] 削除イベントは発行しません");
    return;
  }

  const publisher = new NostrPublisher(hex, args.relays);
  try {
    const eventId = await publisher.publishDeletion(
      notes.map((note) => note.id),
      notes.map((note) => note.kind),
      "テスト投稿の削除",
    );
    logger.info("削除イベントを発行しました", {
      eventId,
      deleted: notes.length,
    });
  } finally {
    publisher.dispose();
  }
  const discord = new DiscordNotifier(process.env.DISCORD_WEBHOOK_URL ?? "");
  await discord.notify(`🧹 テスト投稿 ${notes.length}件の削除を要求しました`);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const types = args.types.length > 0 ? args.types : availableTypes();

  const hex = process.env[args.hexEnv];
  if (!args.dryRun) {
    if (!hex) {
      throw new Error(
        `テスト用の秘密鍵が環境変数 ${args.hexEnv} に設定されていません。`,
      );
    }
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      throw new Error(`${args.hexEnv} の値が64桁の16進数ではありません。`);
    }
  }

  const pubkey = hex
    ? getPublicKey(new Uint8Array(Buffer.from(hex, "hex")))
    : null;
  if (pubkey) {
    logger.info("投稿するアカウント", { npub: npubEncode(pubkey), pubkey });
  }

  if (args.cleanup) {
    await cleanup(args, hex, pubkey);
    return;
  }

  logger.info("テスト投稿を開始します", {
    types,
    relays: args.relays,
    dryRun: args.dryRun,
  });

  const publisher = hex ? new NostrPublisher(hex, args.relays) : null;
  const discord = new DiscordNotifier(process.env.DISCORD_WEBHOOK_URL ?? "");
  const results: { type: string; posts: number; eventIds: string[] }[] = [];

  try {
    for (const type of types) {
      for (const posts of postsForTelegram(type)) {
        const eventIds: string[] = [];
        // 分割された投稿はスレッドで繋ぐ
        let root: string | null = null;
        let parent: string | null = null;
        for (const [index, content] of posts.entries()) {
          logger.info(
            `--- ${type} [${index + 1}/${posts.length}] ---\n${content}`,
          );
          if (args.dryRun || publisher === null) continue;
          const eventId = await publisher.publishNote({
            content,
            time: new Date(),
            reply: root ? { root, parent } : undefined,
          });
          eventIds.push(eventId);
          if (root === null) root = eventId;
          else parent = eventId;
        }
        results.push({ type, posts: posts.length, eventIds });
      }
    }
  } finally {
    publisher?.dispose();
  }

  const total = results.reduce((sum, r) => sum + r.posts, 0);
  const published = results.reduce((sum, r) => sum + r.eventIds.length, 0);
  logger.info("テスト投稿が完了しました", {
    telegrams: types.length,
    posts: total,
    published,
    dryRun: args.dryRun,
  });
  if (!args.dryRun && published > 0) {
    await discord.notify(
      `🧪 テスト投稿を実施しました\n電文 ${types.length}件 → 投稿 ${published}件\n宛先: ${args.relays.join(", ")}`,
    );
  }
};

main().catch((error) => {
  logger.error("テスト投稿に失敗しました", { err: error });
  process.exit(1);
});
