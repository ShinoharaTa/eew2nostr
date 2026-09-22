import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { npubEncode } from "nostr-tools/nip19";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  type ProfileConfig,
  blueskyLimitErrors,
  countGraphemes,
  derivePubkey,
  inspectKey,
  loadProfileConfig,
  normalizePubkey,
  resolveProfiles,
  validateProfileConfig,
} from "../src/profile/profile-config";

const config: ProfileConfig = {
  author: {
    nostr: "nostr:npub1author",
    bluesky: "https://bsky.app/profile/author.bsky.social",
    concrnt: "https://concrnt.world/conauthor",
  },
  vars: { site: "https://example.com" },
  defaults: { website: "{{site}}", about: "共通の説明" },
  accounts: {
    eew: {
      name: "salmon_eew",
      displayName: "緊急地震速報",
      about: "地震の速報を流します。\n\n作者: {{author}}",
      picture: "https://example.com/icon-1024.png",
      banner: "https://example.com/cover.png",
      bluesky: { picture: "https://example.com/icon-400.png" },
      nostr: { extra: { nip05: "eew@example.com" } },
    },
  },
};

const write = (yaml: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eew-profile-"));
  const file = path.join(dir, "profile.yaml");
  fs.writeFileSync(file, yaml);
  return file;
};

describe("resolveProfiles", () => {
  // 作者リンクは SNS ごとに形が違うため、同じ本文から出し分ける
  it("{{author}} は投稿先ごとに違う値へ展開される", () => {
    const profiles = resolveProfiles(config, "eew");

    expect(profiles.nostr.about).toContain("作者: nostr:npub1author");
    expect(profiles.bluesky.description).toContain(
      "作者: https://bsky.app/profile/author.bsky.social",
    );
    expect(profiles.concrnt.description).toContain(
      "作者: https://concrnt.world/conauthor",
    );
  });

  it("vars の変数はそのまま展開される", () => {
    expect(resolveProfiles(config, "eew").nostr.website).toBe(
      "https://example.com",
    );
  });

  // defaults → accounts.<key> → accounts.<key>.<sns> の順に上書きする
  it("解決順は defaults → アカウント → SNS", () => {
    const profiles = resolveProfiles(config, "eew");

    // defaults の about はアカウントの about に上書きされている
    expect(profiles.nostr.about).toContain("地震の速報を流します。");
    // アカウントの picture は SNS 側の指定で上書きされる
    expect(profiles.nostr.picture).toBe("https://example.com/icon-1024.png");
    expect(profiles.bluesky.avatarUrl).toBe("https://example.com/icon-400.png");
    // SNS 側で触っていない項目はアカウントの値が残る
    expect(profiles.bluesky.bannerUrl).toBe("https://example.com/cover.png");
  });

  it("SNS ごとの項目名に移し替える", () => {
    const profiles = resolveProfiles(config, "eew");

    expect(profiles.nostr.name).toBe("salmon_eew");
    expect(profiles.nostr.display_name).toBe("緊急地震速報");
    expect(profiles.bluesky.displayName).toBe("緊急地震速報");
    expect(profiles.concrnt.username).toBe("緊急地震速報");
  });

  // nostr.extra は kind 0 の content にそのまま載せる
  it("nostr の extra は kind 0 に展開される", () => {
    const profiles = resolveProfiles(config, "eew");

    expect(profiles.nostr.nip05).toBe("eew@example.com");
    // 他の SNS には持ち込まない
    expect(profiles.concrnt).not.toHaveProperty("nip05");
  });

  it("未定義の変数はエラーになる", () => {
    const broken: ProfileConfig = {
      ...config,
      accounts: { eew: { about: "作者: {{auther}}" } },
    };

    expect(() => resolveProfiles(broken, "eew")).toThrow(/auther/);
  });

  it("author にその SNS の値が無ければエラーになる", () => {
    const broken: ProfileConfig = {
      author: { nostr: "nostr:npub1author" },
      accounts: { eew: { about: "作者: {{author}}" } },
    };

    expect(() => resolveProfiles(broken, "eew")).toThrow(/author.bluesky/);
  });
});

describe("loadProfileConfig", () => {
  it("YAML を読んで解決できる", () => {
    const file = write(`
author:
  nostr: "nostr:npub1author"
  bluesky: "https://bsky.app/profile/author.bsky.social"
  concrnt: "https://concrnt.world/conauthor"
accounts:
  eew:
    displayName: 緊急地震速報
    about: |-
      1行目

      作者: {{author}}
`);

    const loaded = loadProfileConfig(file);
    expect(resolveProfiles(loaded, "eew").nostr.about).toBe(
      "1行目\n\n作者: nostr:npub1author",
    );
  });

  // タイポのまま「作者: 」だけが並んだプロフィールを発行しないよう、
  // 発行前ではなく読み込み時に落とす
  it("未定義の変数は読み込み時にエラーになる", () => {
    const file = write(`
vars:
  site: "https://example.com"
accounts:
  eew:
    about: "{{sitee}}"
`);

    expect(() => loadProfileConfig(file)).toThrow(/sitee/);
  });

  it("ファイルが無ければエラーになる", () => {
    expect(() => loadProfileConfig("/nonexistent/profile.yaml")).toThrow(
      /見つかりません/,
    );
  });

  it("リポジトリの config/profile.yaml は読み込める", () => {
    const loaded = loadProfileConfig(
      path.join(__dirname, "../config/profile.yaml"),
    );
    // Bluesky の上限に収まっていること
    for (const key of Object.keys(loaded.accounts)) {
      expect(blueskyLimitErrors(resolveProfiles(loaded, key).bluesky)).toEqual(
        [],
      );
    }
  });
});

describe("validateProfileConfig", () => {
  it("accounts が無ければエラーになる", () => {
    expect(() => validateProfileConfig({})).toThrow(/accounts/);
  });

  it("アカウントが空ならエラーになる", () => {
    expect(() => validateProfileConfig({ accounts: {} })).toThrow(
      /1つも定義されていません/,
    );
  });

  it("文字列でない項目はエラーになる", () => {
    expect(() =>
      validateProfileConfig({ accounts: { eew: { about: 1 } } }),
    ).toThrow(/about/);
  });

  it("未知の SNS の author はエラーになる", () => {
    expect(() =>
      validateProfileConfig({ author: { mixi: "x" }, accounts: { eew: {} } }),
    ).toThrow(/mixi/);
  });
});

describe("blueskyLimitErrors", () => {
  // 絵文字や結合文字は複数コードポイントでも1グラフェム
  it("グラフェム単位で数える", () => {
    expect(countGraphemes("👨‍👩‍👧‍👦")).toBe(1);
    expect(countGraphemes("あいう")).toBe(3);
  });

  it("上限内なら空配列を返す", () => {
    expect(
      blueskyLimitErrors({ displayName: "あ", description: "い" }),
    ).toEqual([]);
  });

  it("上限を超えた項目を返す", () => {
    const errors = blueskyLimitErrors({
      displayName: "あ".repeat(65),
      description: "い".repeat(257),
    });

    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("displayName");
    expect(errors[1]).toContain("description");
  });
});

describe("公開鍵の突き合わせ", () => {
  const hex = Buffer.from(generateSecretKey()).toString("hex");
  const pubkey = getPublicKey(Buffer.from(hex, "hex") as Uint8Array);

  it("16進数の公開鍵はそのまま揃える", () => {
    expect(normalizePubkey(pubkey.toUpperCase())).toBe(pubkey);
  });

  it("npub は16進数に直す", () => {
    // nostr-tools の npubEncode と往復できる
    expect(normalizePubkey(npubEncode(pubkey))).toBe(pubkey);
  });

  it("公開鍵として読めない値はエラーになる", () => {
    expect(() => normalizePubkey("salmon_eew")).toThrow(/公開鍵/);
  });

  it("秘密鍵から公開鍵を導ける", () => {
    expect(derivePubkey(hex)).toBe(pubkey);
  });

  // 鍵が無くても dry-run を通すため、例外ではなく理由を返す
  it("鍵が未設定なら理由を返す", () => {
    expect(inspectKey("HEX_NONE", {})).toEqual({
      pubkey: null,
      reason: "HEX_NONE が未設定です",
    });
  });

  it("鍵の形式が不正なら理由を返す", () => {
    expect(inspectKey("HEX_EEW", { HEX_EEW: "zz" }).reason).toContain(
      "64桁の16進数ではありません",
    );
  });

  it("鍵があれば公開鍵を返す", () => {
    expect(inspectKey("HEX_EEW", { HEX_EEW: hex })).toEqual({
      pubkey,
      reason: null,
    });
  });
});

// 差し替え忘れた値をそのまま実アカウントへ書くと、kind 0 は replaceable なので
// 元に戻せない。発行前ではなく設定の読み込みで止める。
describe("差し替え忘れの検出", () => {
  const write = (body: string): string => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "profile-guard-")),
      "profile.yaml",
    );
    fs.writeFileSync(file, body, "utf-8");
    return file;
  };

  it("CHANGEME が残っていると読み込みで落ちる", () => {
    const file = write(`
vars:
  assets: "https://CHANGEME.example.com/a"
accounts:
  eew:
    displayName: 緊急地震速報
    about: "本文"
    picture: "{{assets}}/icon.png"
`);
    expect(() => loadProfileConfig(file)).toThrow(/差し替えていない値/);
  });

  it("どのアカウントのどの項目かを示す", () => {
    const file = write(`
accounts:
  eew:
    displayName: 緊急地震速報
    about: "作者 CHANGEME"
`);
    expect(() => loadProfileConfig(file)).toThrow(/eew\.nostr\.about/);
  });

  it("差し替え済みなら通る", () => {
    const file = write(`
vars:
  assets: "https://example.test/a"
accounts:
  eew:
    displayName: 緊急地震速報
    about: "本文"
    picture: "{{assets}}/icon.png"
`);
    expect(() => loadProfileConfig(file)).not.toThrow();
  });
});
