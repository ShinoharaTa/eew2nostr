import * as fs from "node:fs";
import { decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
import { parse } from "yaml";

// プロフィールを出し分ける先。routing.json のアカウント配下のキーと揃える。
export const PROFILE_SNS = ["nostr", "bluesky", "concrnt"] as const;
export type ProfileSns = (typeof PROFILE_SNS)[number];

// プロフィール1つ分の項目。SNS ごとの上書きも同じ形で書く。
export interface ProfileFields {
  name?: string;
  displayName?: string;
  about?: string;
  website?: string;
  picture?: string;
  banner?: string;
  // Nostr の kind 0 にそのまま載せる追加項目 (nip05 / lud16 など)。
  extra?: Record<string, unknown>;
}

export interface AccountProfileConfig extends ProfileFields {
  nostr?: ProfileFields;
  bluesky?: ProfileFields;
  concrnt?: ProfileFields;
}

export interface ProfileConfig {
  // 本文中の {{author}} に入る値。投稿先の SNS ごとに差し替える。
  author?: Partial<Record<ProfileSns, string>>;
  // {{site}} のように本文から参照する変数。
  vars?: Record<string, string>;
  defaults?: ProfileFields;
  accounts: Record<string, AccountProfileConfig>;
}

// kind 0 の content (NIP-01 / NIP-05 / NIP-24)。
// extra の未知のキーもそのまま通せるよう索引シグネチャを持たせる。
export interface NostrProfile {
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  [key: string]: unknown;
}

// 画像は URL のまま持つ。blob への変換は発行側 (Bluesky) が行う。
export interface BlueskyProfile {
  displayName?: string;
  description?: string;
  avatarUrl?: string;
  bannerUrl?: string;
}

export interface ConcrntProfile {
  username?: string;
  description?: string;
  avatar?: string;
  banner?: string;
}

export interface ResolvedProfiles {
  nostr: NostrProfile;
  bluesky: BlueskyProfile;
  concrnt: ConcrntProfile;
}

export const DEFAULT_PROFILE_CONFIG_PATH = "./config/profile.yaml";

// Bluesky の lexicon 上の上限。グラフェム単位で数える。
export const BLUESKY_DISPLAY_NAME_LIMIT = 64;
export const BLUESKY_DESCRIPTION_LIMIT = 256;

const FIELD_KEYS = [
  "name",
  "displayName",
  "about",
  "website",
  "picture",
  "banner",
] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const checkFields = (value: unknown, where: string): void => {
  if (!isObject(value)) {
    throw new Error(`${where} はオブジェクトである必要があります。`);
  }
  for (const key of FIELD_KEYS) {
    const field = value[key];
    if (field !== undefined && typeof field !== "string") {
      throw new Error(`${where} の ${key} は文字列にしてください。`);
    }
  }
  if (value.extra !== undefined && !isObject(value.extra)) {
    throw new Error(`${where} の extra はオブジェクトにしてください。`);
  }
};

// 設定の不備はその場で落とす。防災システムとして、
// 黙って一部のプロフィールが未設定のまま動くより安全。
export const validateProfileConfig = (raw: unknown): ProfileConfig => {
  if (!isObject(raw)) {
    throw new Error("プロフィール設定はオブジェクトである必要があります。");
  }
  if (raw.author !== undefined) {
    if (!isObject(raw.author)) {
      throw new Error("author はオブジェクトである必要があります。");
    }
    for (const [key, value] of Object.entries(raw.author)) {
      if (!(PROFILE_SNS as readonly string[]).includes(key)) {
        throw new Error(`author に未知の SNS があります: ${key}`);
      }
      if (typeof value !== "string") {
        throw new Error(`author.${key} は文字列にしてください。`);
      }
    }
  }
  if (raw.vars !== undefined) {
    if (!isObject(raw.vars)) {
      throw new Error("vars はオブジェクトである必要があります。");
    }
    for (const [key, value] of Object.entries(raw.vars)) {
      if (typeof value !== "string") {
        throw new Error(`vars.${key} は文字列にしてください。`);
      }
    }
  }
  if (raw.defaults !== undefined) checkFields(raw.defaults, "defaults");

  if (!isObject(raw.accounts)) {
    throw new Error("プロフィール設定に accounts がありません。");
  }
  const entries = Object.entries(raw.accounts);
  if (entries.length === 0) {
    throw new Error("プロフィール設定にアカウントが1つも定義されていません。");
  }
  for (const [key, account] of entries) {
    checkFields(account, `accounts.${key}`);
    for (const sns of PROFILE_SNS) {
      const override = (account as Record<string, unknown>)[sns];
      if (override === undefined) continue;
      checkFields(override, `accounts.${key}.${sns}`);
    }
  }
  return raw as unknown as ProfileConfig;
};

const TEMPLATE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

// {{author}} は投稿先ごとに違う値へ、その他は vars の値へ置き換える。
// 未定義の変数は黙って空文字にせず例外にする。タイポのまま
// 「作者: 」だけが並んだプロフィールを発行してしまうのを防ぐ。
const expand = (
  text: string,
  sns: ProfileSns,
  config: ProfileConfig,
  where: string,
): string =>
  text.replace(TEMPLATE, (_match, name: string) => {
    if (name === "author") {
      const value = config.author?.[sns];
      if (value === undefined) {
        throw new Error(
          `${where} の {{author}} に対応する author.${sns} が設定にありません。`,
        );
      }
      return value;
    }
    const value = config.vars?.[name];
    if (value === undefined) {
      throw new Error(`${where} に未定義の変数 {{${name}}} があります。`);
    }
    return value;
  });

// defaults → accounts.<key> → accounts.<key>.<sns> の浅いマージ。
// 深いマージにすると SNS 側から項目を差し替える意図が読めなくなる。
const mergeFields = (layers: (ProfileFields | undefined)[]): ProfileFields => {
  const merged: ProfileFields = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of FIELD_KEYS) {
      const value = layer[key];
      if (value !== undefined) merged[key] = value;
    }
    if (layer.extra !== undefined) merged.extra = layer.extra;
  }
  return merged;
};

const expandFields = (
  fields: ProfileFields,
  sns: ProfileSns,
  config: ProfileConfig,
  where: string,
): ProfileFields => {
  const expanded: ProfileFields = {};
  for (const key of FIELD_KEYS) {
    const value = fields[key];
    if (value !== undefined) {
      expanded[key] = expand(value, sns, config, `${where} の ${key}`);
    }
  }
  if (fields.extra) {
    expanded.extra = Object.fromEntries(
      Object.entries(fields.extra).map(([key, value]) => [
        key,
        typeof value === "string"
          ? expand(value, sns, config, `${where} の extra.${key}`)
          : value,
      ]),
    );
  }
  return expanded;
};

const resolveFields = (
  config: ProfileConfig,
  key: string,
  sns: ProfileSns,
): ProfileFields => {
  const account = config.accounts[key];
  if (!account) {
    throw new Error(`アカウント ${key} はプロフィール設定に存在しません。`);
  }
  const merged = mergeFields([config.defaults, account, account[sns]]);
  return expandFields(merged, sns, config, `accounts.${key}.${sns}`);
};

// 空文字の項目は「書いていない」と同じ扱いにする。
// kind 0 に空の name を載せると、クライアントによっては名前が消える。
const put = <T extends object>(
  target: T,
  key: keyof T & string,
  value: string | undefined,
): void => {
  if (value !== undefined && value !== "") {
    (target as Record<string, unknown>)[key] = value;
  }
};

export const resolveProfiles = (
  config: ProfileConfig,
  key: string,
): ResolvedProfiles => {
  const nostrFields = resolveFields(config, key, "nostr");
  const nostr: NostrProfile = { ...(nostrFields.extra ?? {}) };
  put(nostr, "name", nostrFields.name);
  put(nostr, "display_name", nostrFields.displayName);
  put(nostr, "about", nostrFields.about);
  put(nostr, "website", nostrFields.website);
  put(nostr, "picture", nostrFields.picture);
  put(nostr, "banner", nostrFields.banner);

  const blueskyFields = resolveFields(config, key, "bluesky");
  const bluesky: BlueskyProfile = {};
  put(bluesky, "displayName", blueskyFields.displayName);
  put(bluesky, "description", blueskyFields.about);
  put(bluesky, "avatarUrl", blueskyFields.picture);
  put(bluesky, "bannerUrl", blueskyFields.banner);

  const concrntFields = resolveFields(config, key, "concrnt");
  const concrnt: ConcrntProfile = {};
  put(concrnt, "username", concrntFields.displayName);
  put(concrnt, "description", concrntFields.about);
  put(concrnt, "avatar", concrntFields.picture);
  put(concrnt, "banner", concrntFields.banner);

  return { nostr, bluesky, concrnt };
};

export const loadProfileConfig = (path: string): ProfileConfig => {
  if (!fs.existsSync(path)) {
    throw new Error(`プロフィール設定が見つかりません: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = parse(fs.readFileSync(path, "utf-8"));
  } catch (e) {
    throw new Error(`プロフィール設定の YAML を解析できません: ${path}`, {
      cause: e,
    });
  }
  const config = validateProfileConfig(parsed);
  // 全アカウント分を一度展開し、未定義の変数をこの場で表に出す。
  // 発行の直前まで気付けないと、一部だけ反映された状態になる。
  const placeholders: string[] = [];
  for (const key of Object.keys(config.accounts)) {
    const resolved = resolveProfiles(config, key);
    placeholders.push(...findPlaceholders(key, resolved));
  }
  // 差し替え忘れたまま本番に出ると、壊れた画像URLや CHANGEME を含む紹介文が
  // そのまま実アカウントへ書かれる。kind 0 は replaceable なので元には戻せない。
  if (placeholders.length > 0) {
    throw new Error(
      `プロフィール設定に差し替えていない値が残っています: ${placeholders.join(", ")}`,
    );
  }
  return config;
};

// 差し替えが要る箇所に置く目印。値に含まれていたら発行させない。
const PLACEHOLDER = "CHANGEME";

const findPlaceholders = (
  key: string,
  resolved: ResolvedProfiles,
): string[] => {
  const found: string[] = [];
  for (const [sns, profile] of Object.entries(resolved)) {
    for (const [field, value] of Object.entries(profile)) {
      if (typeof value === "string" && value.includes(PLACEHOLDER)) {
        found.push(`${key}.${sns}.${field}`);
      }
    }
  }
  return found;
};

// 絵文字や結合文字を1文字として数える。Bluesky の上限はグラフェム単位。
const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

export const countGraphemes = (text: string): number =>
  [...segmenter.segment(text)].length;

// 上限を超えた項目の説明を返す。空配列なら発行してよい。
export const blueskyLimitErrors = (profile: BlueskyProfile): string[] => {
  const errors: string[] = [];
  for (const [key, limit] of [
    ["displayName", BLUESKY_DISPLAY_NAME_LIMIT],
    ["description", BLUESKY_DESCRIPTION_LIMIT],
  ] as const) {
    const value = profile[key];
    if (value === undefined) continue;
    const length = countGraphemes(value);
    if (length > limit) {
      errors.push(`${key} が ${limit} グラフェムを超えています (${length})`);
    }
  }
  return errors;
};

const HEX64 = /^[0-9a-f]{64}$/i;

// npub / 16進数のどちらで書かれていても16進数の公開鍵に揃える
export const normalizePubkey = (value: string): string => {
  if (HEX64.test(value)) return value.toLowerCase();
  if (value.startsWith("npub1")) {
    const decoded = decode(value);
    if (decoded.type !== "npub") {
      throw new Error(`npub ではありません: ${value}`);
    }
    return decoded.data.toLowerCase();
  }
  throw new Error(`公開鍵は npub か64桁の16進数で指定してください: ${value}`);
};

export const derivePubkey = (hex: string): string =>
  getPublicKey(new Uint8Array(Buffer.from(hex, "hex"))).toLowerCase();

// 環境変数の秘密鍵から公開鍵を導く。設定を書く際の突き合わせに使う。
// 未設定や形式不正は例外にせず理由を返し、dry-run を鍵なしでも通す。
export const inspectKey = (
  hexEnv: string,
  env: NodeJS.ProcessEnv = process.env,
): { pubkey: string | null; reason: string | null } => {
  const hex = env[hexEnv];
  if (!hex) return { pubkey: null, reason: `${hexEnv} が未設定です` };
  if (!HEX64.test(hex))
    return { pubkey: null, reason: `${hexEnv} が64桁の16進数ではありません` };
  return { pubkey: derivePubkey(hex), reason: null };
};
