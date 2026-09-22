import { createHash } from "node:crypto";
import { type BlobRef, jsonStringToLex, stringifyLex } from "@atproto/api";
import { logger } from "../logger.js";

// アップロード済みの画像。sha256 は URL の中身のハッシュ、
// blob は BlobRef を JSON 文字列にしたもの。
export interface ProfileAssetRecord {
  sha256: string;
  blob: string;
}

export interface ProfileAssetStore {
  loadProfileAsset(
    account: string,
    field: string,
  ): Promise<ProfileAssetRecord | null>;
  saveProfileAsset(
    account: string,
    field: string,
    sha256: string,
    blob: string,
  ): Promise<void>;
}

export interface FetchedAsset {
  bytes: Uint8Array;
  mime: string;
  sha256: string;
}

export type AssetFetcher = (url: string) => Promise<FetchedAsset>;

export interface BlobUploader {
  uploadBlob(bytes: Uint8Array, mime: string): Promise<BlobRef>;
}

// Bluesky の lexicon 上の制約 (app.bsky.actor.profile の avatar / banner)。
// 超えたものを putRecord に渡すと検証で例外になるため、取得直後に弾く。
export const BLUESKY_MAX_ASSET_BYTES = 1_000_000;
export const BLUESKY_ACCEPT_MIME = ["image/png", "image/jpeg"];

const EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

// Content-Type が無い配信元もあるため、拡張子からも推定する。
const guessMime = (url: string, header: string | null): string => {
  const fromHeader = header?.split(";")[0].trim().toLowerCase();
  if (fromHeader) return fromHeader;
  const extension = new URL(url).pathname.split(".").pop()?.toLowerCase();
  return (extension && EXTENSION_MIME[extension]) ?? "application/octet-stream";
};

const ASSET_TIMEOUT_MS = 10_000;

export const fetchAsset: AssetFetcher = async (url) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(ASSET_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`画像を取得できません (${response.status}): ${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    bytes,
    mime: guessMime(url, response.headers.get("content-type")),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

export interface ResolvedAsset {
  // putRecord に渡す BlobRef。
  blob: BlobRef;
  // 今回アップロードしたか。false なら保存済みのものを使い回した。
  uploaded: boolean;
  sha256: string;
}

// URL の中身が前回と同じなら uploadBlob を呼ばず、保存済みの BlobRef を使う。
// blob は replaceable ではないので、起動のたびに上げると PDS に積み上がる。
// URL 文字列の比較では足りない。静的サイトは同じ URL のまま中身を差し替える。
export const resolveAssetBlob = async (params: {
  account: string;
  // "avatar" か "banner"。アカウント内で画像を区別する。
  field: string;
  url: string;
  store: ProfileAssetStore | null;
  uploader: BlobUploader;
  fetcher?: AssetFetcher;
}): Promise<ResolvedAsset> => {
  const fetched = await (params.fetcher ?? fetchAsset)(params.url);
  if (!BLUESKY_ACCEPT_MIME.includes(fetched.mime)) {
    throw new Error(
      `Bluesky が受け付けない形式です (${fetched.mime}): ${params.url}`,
    );
  }
  if (fetched.bytes.length > BLUESKY_MAX_ASSET_BYTES) {
    throw new Error(
      `Bluesky の上限 ${BLUESKY_MAX_ASSET_BYTES} バイトを超えています (${fetched.bytes.length}): ${params.url}`,
    );
  }

  const cached = await params.store?.loadProfileAsset(
    params.account,
    params.field,
  );
  if (cached && cached.sha256 === fetched.sha256) {
    try {
      return {
        blob: jsonStringToLex(cached.blob) as BlobRef,
        uploaded: false,
        sha256: fetched.sha256,
      };
    } catch (e) {
      // 保存済みの BlobRef が壊れている場合は上げ直す
      logger.warn("保存済みの BlobRef を復元できません", {
        account: params.account,
        field: params.field,
        err: e,
      });
    }
  }

  const blob = await params.uploader.uploadBlob(fetched.bytes, fetched.mime);
  await params.store?.saveProfileAsset(
    params.account,
    params.field,
    fetched.sha256,
    stringifyLex(blob),
  );
  return { blob, uploaded: true, sha256: fetched.sha256 };
};
