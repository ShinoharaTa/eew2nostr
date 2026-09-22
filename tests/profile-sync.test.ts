import { npubEncode } from "nostr-tools/nip19";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { ProfileAssetRecord } from "../src/profile/assets";
import type { ProfileConfig } from "../src/profile/profile-config";
import { syncProfiles } from "../src/profile/sync";
import type { AccountClients } from "../src/publisher/account";
import type { RoutingConfig } from "../src/routing/types";

const hex = Buffer.from(generateSecretKey()).toString("hex");
const npub = npubEncode(getPublicKey(Buffer.from(hex, "hex") as Uint8Array));
const otherNpub = npubEncode(getPublicKey(generateSecretKey()));
const env = { HEX_EEW: hex };

const config: ProfileConfig = {
  author: {
    nostr: "nostr:npub1author",
    bluesky: "https://bsky.app/profile/author.bsky.social",
    concrnt: "https://concrnt.world/conauthor",
  },
  accounts: {
    eew: {
      name: "salmon_eew",
      displayName: "緊急地震速報",
      about: "地震の速報を流します。\n\n作者: {{author}}",
    },
  },
};

const routing = (
  overrides: {
    npub?: string | undefined;
    handle?: string | undefined;
    ccid?: string | undefined;
  } = {},
): RoutingConfig => ({
  accounts: {
    eew: {
      label: "緊急地震速報",
      nostr: {
        hexEnv: "HEX_EEW",
        ...("npub" in overrides ? { npub: overrides.npub } : { npub }),
      },
      bluesky: {
        identifierEnv: "BSKY_IDENTIFIER_EEW",
        passwordEnv: "BSKY_PASSWORD_EEW",
        ...("handle" in overrides
          ? { handle: overrides.handle }
          : { handle: "eew.bsky.social" }),
      },
      concrnt: {
        subkeyEnv: "CONCRNT_SUBKEY_EEW",
        ...("ccid" in overrides ? { ccid: overrides.ccid } : { ccid: "con1" }),
      },
    },
  },
  routes: [],
});

// 鍵がある経路のクライアントを模したアカウントを組み立てる
const account = (
  present: { nostr?: boolean; bluesky?: boolean; concrnt?: boolean } = {},
) => {
  const publishMetadata = jest.fn().mockResolvedValue("e".repeat(64));
  const updateBsky = jest.fn().mockResolvedValue(undefined);
  const uploadBlob = jest.fn().mockResolvedValue({ blobId: "uploaded" });
  const handle = jest.fn().mockReturnValue("eew.bsky.social");
  const updateConcrnt = jest.fn().mockResolvedValue(undefined);
  const ccid = jest.fn().mockReturnValue("con1");
  const clients = {
    key: "eew",
    label: "緊急地震速報",
    nostr: present.nostr === false ? null : { publishMetadata },
    bluesky:
      present.bluesky === false
        ? null
        : { updateProfile: updateBsky, uploadBlob, handle },
    concrnt:
      present.concrnt === false ? null : { updateProfile: updateConcrnt, ccid },
  } as unknown as AccountClients;
  return {
    clients,
    accounts: new Map([["eew", clients]]),
    publishMetadata,
    updateBsky,
    uploadBlob,
    updateConcrnt,
  };
};

// URL の中身のハッシュと BlobRef を覚えておくキャッシュ
const assetStore = (initial: Record<string, ProfileAssetRecord> = {}) => {
  const saved = new Map(Object.entries(initial));
  return {
    saved,
    async loadProfileAsset(account: string, field: string) {
      return saved.get(`${account}/${field}`) ?? null;
    },
    async saveProfileAsset(
      account: string,
      field: string,
      sha256: string,
      blob: string,
    ) {
      saved.set(`${account}/${field}`, { sha256, blob });
    },
  };
};

const fetcher = (bytes = Uint8Array.from([1, 2, 3]), mime = "image/png") =>
  jest.fn().mockResolvedValue({
    bytes,
    mime,
    // 中身のハッシュ。同じなら再アップロードしない。
    sha256: "sha-1",
  });

const status = (
  results: Awaited<ReturnType<typeof syncProfiles>>,
  sns: string,
): string | undefined => results.find((r) => r.sns === sns)?.status;

describe("syncProfiles", () => {
  it("公開鍵が一致するアカウントへ kind 0 を発行する", async () => {
    const target = account();

    const results = await syncProfiles({
      config,
      routing: routing(),
      accounts: target.accounts,
      mode: "on",
      env,
    });

    expect(target.publishMetadata).toHaveBeenCalledTimes(1);
    expect(target.publishMetadata.mock.calls[0][0]).toEqual({
      name: "salmon_eew",
      display_name: "緊急地震速報",
      about: "地震の速報を流します。\n\n作者: nostr:npub1author",
    });
    expect(status(results, "nostr")).toBe("updated");
  });

  // kind 0 は取り違えて発行すると別アカウントのプロフィールを上書きして戻せない
  it("npub が一致しなければ kind 0 を発行せず、他の SNS は更新する", async () => {
    const target = account();

    const results = await syncProfiles({
      config,
      routing: routing({ npub: otherNpub }),
      accounts: target.accounts,
      mode: "on",
      env,
    });

    expect(target.publishMetadata).not.toHaveBeenCalled();
    expect(status(results, "nostr")).toBe("failed");
    expect(target.updateBsky).toHaveBeenCalledTimes(1);
    expect(target.updateConcrnt).toHaveBeenCalledTimes(1);
  });

  it("npub が未設定なら kind 0 を発行しない", async () => {
    const target = account();

    const results = await syncProfiles({
      config,
      routing: routing({ npub: undefined }),
      accounts: target.accounts,
      mode: "on",
      env,
    });

    expect(target.publishMetadata).not.toHaveBeenCalled();
    expect(status(results, "nostr")).toBe("skipped");
  });

  it("dry-run では何も発行しない", async () => {
    const target = account();

    const results = await syncProfiles({
      config,
      routing: routing(),
      accounts: target.accounts,
      mode: "dry-run",
      env,
    });

    expect(target.publishMetadata).not.toHaveBeenCalled();
    expect(target.updateBsky).not.toHaveBeenCalled();
    expect(target.updateConcrnt).not.toHaveBeenCalled();
    expect(results.map((r) => r.status)).toEqual([
      "dry-run",
      "dry-run",
      "dry-run",
    ]);
  });

  it("鍵が未設定の経路は発行せずログだけ出す", async () => {
    const target = account({ nostr: false, bluesky: false, concrnt: false });

    const results = await syncProfiles({
      config,
      routing: routing(),
      accounts: target.accounts,
      mode: "on",
      env: {},
    });

    expect(results.map((r) => r.status)).toEqual(["test", "test", "test"]);
  });

  // 上限超過は putRecord で例外になる。発行前に弾いて他の SNS を守る。
  it("Bluesky の上限を超えたらその SNS だけスキップする", async () => {
    const long: ProfileConfig = {
      ...config,
      accounts: {
        eew: { displayName: "緊急地震速報", about: "あ".repeat(300) },
      },
    };
    const target = account();

    const results = await syncProfiles({
      config: long,
      routing: routing(),
      accounts: target.accounts,
      mode: "on",
      env,
    });

    expect(target.updateBsky).not.toHaveBeenCalled();
    expect(status(results, "bluesky")).toBe("failed");
    expect(target.publishMetadata).toHaveBeenCalledTimes(1);
    expect(target.updateConcrnt).toHaveBeenCalledTimes(1);
  });

  it("ログイン中のハンドルが設定と違えば更新しない", async () => {
    const target = account();

    const results = await syncProfiles({
      config,
      routing: routing({ handle: "other.bsky.social" }),
      accounts: target.accounts,
      mode: "on",
      env,
    });

    expect(target.updateBsky).not.toHaveBeenCalled();
    expect(status(results, "bluesky")).toBe("failed");
  });

  it("CCID が設定と違えば更新しない", async () => {
    const target = account();

    const results = await syncProfiles({
      config,
      routing: routing({ ccid: "con2" }),
      accounts: target.accounts,
      mode: "on",
      env,
    });

    expect(target.updateConcrnt).not.toHaveBeenCalled();
    expect(status(results, "concrnt")).toBe("failed");
  });

  it("1つの SNS の失敗は他を止めない", async () => {
    const target = account();
    target.publishMetadata.mockRejectedValue(new Error("relay down"));

    const results = await syncProfiles({
      config,
      routing: routing(),
      accounts: target.accounts,
      mode: "on",
      env,
    });

    expect(status(results, "nostr")).toBe("failed");
    expect(target.updateBsky).toHaveBeenCalledTimes(1);
    expect(target.updateConcrnt).toHaveBeenCalledTimes(1);
  });

  it("プロフィール設定に無いアカウントは何もしない", async () => {
    const target = account();

    const results = await syncProfiles({
      config: { accounts: { other: { name: "other" } } },
      routing: routing(),
      accounts: target.accounts,
      mode: "on",
      env,
    });

    expect(results).toEqual([]);
    expect(target.publishMetadata).not.toHaveBeenCalled();
  });

  it("--account 相当の指定で対象を絞れる", async () => {
    const target = account();

    const results = await syncProfiles({
      config,
      routing: routing(),
      accounts: target.accounts,
      mode: "on",
      only: "warning",
      env,
    });

    expect(results).toEqual([]);
  });

  it("変更があれば通知する", async () => {
    const target = account();
    const notifier = { notify: jest.fn().mockResolvedValue({}) };

    await syncProfiles({
      config,
      routing: routing(),
      accounts: target.accounts,
      mode: "on",
      notifier,
      env,
    });

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify.mock.calls[0][0]).toBe("success");
  });

  // 起動のたびに同じ内容を流さない
  it("変更も失敗も無ければ通知しない", async () => {
    const target = account();
    const notifier = { notify: jest.fn().mockResolvedValue({}) };

    await syncProfiles({
      config,
      routing: routing(),
      accounts: target.accounts,
      mode: "dry-run",
      notifier,
      env,
    });

    expect(notifier.notify).not.toHaveBeenCalled();
  });
});

describe("syncProfiles の画像", () => {
  const withPicture: ProfileConfig = {
    ...config,
    accounts: {
      eew: {
        ...config.accounts.eew,
        picture: "https://example.com/icon.png",
      },
    },
  };

  it("Bluesky には blob をアップロードして渡す", async () => {
    const target = account();
    const store = assetStore();

    await syncProfiles({
      config: withPicture,
      routing: routing(),
      accounts: target.accounts,
      mode: "on",
      assets: store,
      fetcher: fetcher(),
      env,
    });

    expect(target.uploadBlob).toHaveBeenCalledTimes(1);
    expect(target.updateBsky.mock.calls[0][0].avatar).toEqual({
      blobId: "uploaded",
    });
    expect(store.saved.get("eew/avatar")?.sha256).toBe("sha-1");
  });

  // blob は replaceable ではない。起動のたびに上げると PDS に積み上がる。
  it("中身のハッシュが同じなら再アップロードしない", async () => {
    const target = account();
    const store = assetStore({
      "eew/avatar": {
        sha256: "sha-1",
        blob: JSON.stringify({ blobId: "cached" }),
      },
    });

    await syncProfiles({
      config: withPicture,
      routing: routing(),
      accounts: target.accounts,
      mode: "on",
      assets: store,
      fetcher: fetcher(),
      env,
    });

    expect(target.uploadBlob).not.toHaveBeenCalled();
    expect(target.updateBsky.mock.calls[0][0].avatar).toEqual({
      blobId: "cached",
    });
  });

  it("中身が変わっていればアップロードし直す", async () => {
    const target = account();
    const store = assetStore({
      "eew/avatar": { sha256: "古い", blob: JSON.stringify({ blobId: "old" }) },
    });

    await syncProfiles({
      config: withPicture,
      routing: routing(),
      accounts: target.accounts,
      mode: "on",
      assets: store,
      fetcher: fetcher(),
      env,
    });

    expect(target.uploadBlob).toHaveBeenCalledTimes(1);
    expect(store.saved.get("eew/avatar")?.sha256).toBe("sha-1");
  });

  // サイトが落ちているだけでアイコンが消えるのは避ける
  it("画像を取得できなくても既存の値を消さない", async () => {
    const target = account();

    const results = await syncProfiles({
      config: withPicture,
      routing: routing(),
      accounts: target.accounts,
      mode: "on",
      assets: assetStore(),
      fetcher: jest.fn().mockRejectedValue(new Error("404")),
      env,
    });

    expect(target.uploadBlob).not.toHaveBeenCalled();
    // avatar を渡さなければ upsertProfile 側で既存の値が残る
    expect(target.updateBsky.mock.calls[0][0].avatar).toBeUndefined();
    expect(status(results, "bluesky")).toBe("updated");
  });

  it("WebP は Bluesky に上げない", async () => {
    const target = account();

    await syncProfiles({
      config: withPicture,
      routing: routing(),
      accounts: target.accounts,
      mode: "on",
      assets: assetStore(),
      fetcher: fetcher(Uint8Array.from([1]), "image/webp"),
      env,
    });

    expect(target.uploadBlob).not.toHaveBeenCalled();
    expect(target.updateBsky.mock.calls[0][0].avatar).toBeUndefined();
  });

  it("1MB を超える画像は Bluesky に上げない", async () => {
    const target = account();

    await syncProfiles({
      config: withPicture,
      routing: routing(),
      accounts: target.accounts,
      mode: "on",
      assets: assetStore(),
      fetcher: fetcher(new Uint8Array(1_000_001)),
      env,
    });

    expect(target.uploadBlob).not.toHaveBeenCalled();
    expect(target.updateBsky.mock.calls[0][0].avatar).toBeUndefined();
  });

  // Nostr と Concrnt は URL をそのまま載せるので取得自体が要らない
  it("Nostr と Concrnt には URL をそのまま渡す", async () => {
    const target = account();
    const fetch = fetcher();

    await syncProfiles({
      config: withPicture,
      routing: routing(),
      accounts: target.accounts,
      mode: "on",
      assets: assetStore(),
      fetcher: fetch,
      env,
    });

    expect(target.publishMetadata.mock.calls[0][0].picture).toBe(
      "https://example.com/icon.png",
    );
    expect(target.updateConcrnt.mock.calls[0][0].avatar).toBe(
      "https://example.com/icon.png",
    );
    // 取得は Bluesky の分だけ
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
