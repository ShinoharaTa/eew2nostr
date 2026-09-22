import { logger } from "../logger.js";
import type { NotifierPort } from "../notifier/notifier.js";
import type { AccountClients, SnsName } from "../publisher/account.js";
import type { RoutingConfig } from "../routing/types.js";
import {
  type AssetFetcher,
  type ProfileAssetStore,
  resolveAssetBlob,
} from "./assets.js";
import {
  type ProfileConfig,
  type ResolvedProfiles,
  blueskyLimitErrors,
  inspectKey,
  normalizePubkey,
  resolveProfiles,
} from "./profile-config.js";

export type ProfileSyncMode = "on" | "off" | "dry-run";

// updated: 発行した / skipped: 条件が揃わず見送った /
// failed: 事故防止で弾いた・発行に失敗した /
// test: 鍵が無いのでログだけ / dry-run: 発行しない指定
export type ProfileSyncStatus =
  | "updated"
  | "skipped"
  | "failed"
  | "test"
  | "dry-run";

export interface ProfileSyncResult {
  account: string;
  sns: SnsName;
  status: ProfileSyncStatus;
  detail: string;
}

export interface SyncProfilesOptions {
  config: ProfileConfig;
  routing: RoutingConfig;
  accounts: Map<string, AccountClients>;
  mode: ProfileSyncMode;
  // 画像の再アップロードを避けるためのキャッシュ。無くても動く。
  assets?: ProfileAssetStore | null;
  fetcher?: AssetFetcher;
  notifier?: NotifierPort;
  // 1アカウントだけ対象にする。CLI の --account= から渡す。
  only?: string | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

// 受信開始を妨げないよう、全体をこの時間で打ち切る。
export const PROFILE_SYNC_TIMEOUT_MS = 30_000;

export const parseSyncMode = (value: string | undefined): ProfileSyncMode => {
  const mode = value?.trim();
  if (mode === "off" || mode === "dry-run") return mode;
  if (mode === undefined || mode === "" || mode === "on") return "on";
  logger.warn(`PROFILE_SYNC の値が不正です。on として扱います: ${mode}`);
  return "on";
};

const summarize = (results: ProfileSyncResult[]): string =>
  results
    .map((r) => `${r.account}/${r.sns}: ${r.status} — ${r.detail}`)
    .join("\n");

// アカウント × SNS ごとに独立して同期する。
// 1つの失敗が他を止めないよう、例外は外へ投げない。
export const syncProfiles = async (
  options: SyncProfilesOptions,
): Promise<ProfileSyncResult[]> => {
  const env = options.env ?? process.env;
  const results: ProfileSyncResult[] = [];
  const push = (
    account: string,
    sns: SnsName,
    status: ProfileSyncStatus,
    detail: string,
  ): void => {
    results.push({ account, sns, status, detail });
  };

  const syncNostr = async (
    key: string,
    clients: AccountClients,
    profiles: ResolvedProfiles,
  ): Promise<void> => {
    const nostr = options.routing.accounts[key]?.nostr;
    if (!clients.nostr) {
      logger.info(
        `[test] ${key}/nostr に発行する kind 0: ${JSON.stringify(profiles.nostr)}`,
      );
      push(key, "nostr", "test", "鍵が未設定のため発行しません");
      return;
    }
    if (!nostr?.npub) {
      logger.warn(
        `${key} の routing.json に nostr.npub がないため kind 0 を発行しません`,
      );
      push(key, "nostr", "skipped", "nostr.npub が未設定です");
      return;
    }
    // kind 0 は取り違えて発行すると別アカウントのプロフィールを
    // 上書きして戻せない。発行前に公開鍵を突き合わせる。
    const expected = normalizePubkey(nostr.npub);
    const inspected = inspectKey(nostr.hexEnv, env);
    if (!inspected.pubkey) {
      push(key, "nostr", "skipped", inspected.reason ?? "鍵を読めません");
      return;
    }
    if (inspected.pubkey !== expected) {
      const detail = `${nostr.hexEnv} の鍵は ${key} のものではありません (この鍵の公開鍵は ${inspected.pubkey})`;
      logger.error(`${key}/nostr の kind 0 は発行しません。${detail}`);
      push(key, "nostr", "failed", detail);
      return;
    }
    if (options.mode === "dry-run") {
      push(key, "nostr", "dry-run", "発行しません (公開鍵は一致)");
      return;
    }
    const eventId = await clients.nostr.publishMetadata(profiles.nostr);
    push(key, "nostr", "updated", `kind 0 を発行しました (${eventId})`);
  };

  const syncBluesky = async (
    key: string,
    clients: AccountClients,
    profiles: ResolvedProfiles,
  ): Promise<void> => {
    const profile = profiles.bluesky;
    // 上限超過は putRecord で例外になる。発行前に弾いて他の SNS を守る。
    const limits = blueskyLimitErrors(profile);
    if (limits.length > 0) {
      const detail = limits.join(" / ");
      logger.error(
        `${key}/bluesky のプロフィールは上限を超えています。${detail}`,
      );
      push(key, "bluesky", "failed", detail);
      return;
    }
    if (!clients.bluesky) {
      logger.info(
        `[test] ${key}/bluesky に発行するプロフィール: ${JSON.stringify(profile)}`,
      );
      push(key, "bluesky", "test", "鍵が未設定のため発行しません");
      return;
    }
    // クロージャの中でも null でないことを保てるよう控える
    const bluesky = clients.bluesky;
    const handle = options.routing.accounts[key]?.bluesky?.handle;
    const session = bluesky.handle();
    if (handle && session !== handle) {
      const detail = `ログイン中のハンドル (${session ?? "不明"}) が設定の ${handle} と一致しません`;
      logger.error(`${key}/bluesky のプロフィールは更新しません。${detail}`);
      push(key, "bluesky", "failed", detail);
      return;
    }
    if (options.mode === "dry-run") {
      push(key, "bluesky", "dry-run", "発行しません");
      return;
    }

    // 画像は blob で渡す。取得やアップロードに失敗した項目は
    // 渡さず、既存の値をそのまま残す (サイトが落ちただけで消さない)。
    const notes: string[] = [];
    const blob = async (field: "avatar" | "banner", url?: string) => {
      if (!url) return undefined;
      try {
        const resolved = await resolveAssetBlob({
          account: key,
          field,
          url,
          store: options.assets ?? null,
          uploader: bluesky,
          fetcher: options.fetcher,
        });
        notes.push(
          `${field}: ${resolved.uploaded ? "アップロード" : "変更なし"}`,
        );
        return resolved.blob;
      } catch (e) {
        logger.error(`${key}/bluesky の ${field} を更新できません`, { err: e });
        notes.push(`${field}: 失敗のため既存を維持`);
        return undefined;
      }
    };
    const avatar = await blob("avatar", profile.avatarUrl);
    const banner = await blob("banner", profile.bannerUrl);

    await bluesky.updateProfile({
      displayName: profile.displayName,
      description: profile.description,
      avatar,
      banner,
    });
    push(
      key,
      "bluesky",
      "updated",
      ["プロフィールを更新しました", ...notes].join(" / "),
    );
  };

  const syncConcrnt = async (
    key: string,
    clients: AccountClients,
    profiles: ResolvedProfiles,
  ): Promise<void> => {
    if (!clients.concrnt) {
      logger.info(
        `[test] ${key}/concrnt に発行するプロフィール: ${JSON.stringify(profiles.concrnt)}`,
      );
      push(key, "concrnt", "test", "鍵が未設定のため発行しません");
      return;
    }
    const ccid = options.routing.accounts[key]?.concrnt?.ccid;
    const current = clients.concrnt.ccid();
    if (ccid && current !== ccid) {
      const detail = `接続中の CCID (${current ?? "不明"}) が設定の ${ccid} と一致しません`;
      logger.error(`${key}/concrnt のプロフィールは更新しません。${detail}`);
      push(key, "concrnt", "failed", detail);
      return;
    }
    if (options.mode === "dry-run") {
      push(key, "concrnt", "dry-run", "発行しません");
      return;
    }
    await clients.concrnt.updateProfile(profiles.concrnt);
    push(key, "concrnt", "updated", "プロフィールを更新しました");
  };

  const run = async (): Promise<void> => {
    for (const [key, clients] of options.accounts) {
      if (options.only && options.only !== key) continue;
      if (!options.config.accounts[key]) {
        logger.info(`${key} はプロフィール設定に無いため同期しません`);
        continue;
      }
      let profiles: ResolvedProfiles;
      try {
        profiles = resolveProfiles(options.config, key);
      } catch (e) {
        logger.error(`${key} のプロフィールを解決できません`, { err: e });
        for (const sns of ["nostr", "bluesky", "concrnt"] as const) {
          push(key, sns, "failed", String(e));
        }
        continue;
      }
      for (const [sns, sync] of [
        ["nostr", syncNostr],
        ["bluesky", syncBluesky],
        ["concrnt", syncConcrnt],
      ] as const) {
        try {
          await sync(key, clients, profiles);
        } catch (e) {
          // 1つの SNS の失敗で残りを止めない
          logger.error(`${key}/${sns} のプロフィール同期に失敗しました`, {
            err: e,
          });
          push(key, sns, "failed", String(e));
        }
      }
    }
  };

  const timeoutMs = options.timeoutMs ?? PROFILE_SYNC_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    run(),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        logger.error(
          `プロフィールの同期が ${timeoutMs}ms で終わらないため打ち切ります`,
        );
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  // 通知は変更が起きた時と失敗した時だけ。起動のたびに同じ内容を流さない。
  const failed = results.filter((r) => r.status === "failed");
  const updated = results.filter((r) => r.status === "updated");
  if (options.notifier && (failed.length > 0 || updated.length > 0)) {
    const level = failed.length > 0 ? "error" : "success";
    const title =
      failed.length > 0
        ? "プロフィールの同期に失敗した経路があります"
        : "プロフィールを同期しました";
    await options.notifier
      .notify(level, title, summarize([...failed, ...updated]))
      .catch(() => undefined);
  }
  return results;
};
