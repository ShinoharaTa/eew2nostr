import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import WebSocket from "ws";

useWebSocketImplementation(WebSocket);

// テスト投稿だけを見分ける目印。本文に必ず入る。
export const TEST_MARKER = "※テスト運用中です。";

// 自分が出したテスト投稿を集める。
// 同じ鍵で他の用途の投稿がある場合に巻き込まないよう、
// 目印を含む kind 1 だけを対象にする。
export const collectTestNotes = async (
  pubkey: string,
  relays: string[],
  marker: string = TEST_MARKER,
): Promise<Event[]> => {
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(relays, {
      kinds: [1],
      authors: [pubkey],
      limit: 500,
    });
    return events.filter((event) => event.content.includes(marker));
  } finally {
    pool.close(relays);
  }
};
