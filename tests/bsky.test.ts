import { AtpAgent } from "@atproto/api";
import { BskyPublisher } from "../src/publisher/bsky";

jest.mock("@atproto/api");

describe("BskyPublisher", () => {
  let post: jest.Mock;
  let login: jest.Mock;
  let upsertProfile: jest.Mock;
  let uploadBlob: jest.Mock;

  beforeEach(() => {
    post = jest.fn().mockResolvedValue({ cid: "cid", uri: "uri" });
    login = jest.fn().mockResolvedValue(undefined);
    upsertProfile = jest.fn().mockResolvedValue(undefined);
    uploadBlob = jest
      .fn()
      .mockResolvedValue({ data: { blob: { blobId: "uploaded" } } });
    (AtpAgent as unknown as jest.Mock).mockImplementation(() => ({
      post,
      login,
      upsertProfile,
      uploadBlob,
      session: { handle: "eew.bsky.social" },
    }));
  });

  // 宣言が無いとクライアント側の言語推定に委ねられ、
  // 漢字が主体の防災情報は日本語と判定されないことがある
  it("投稿に言語を宣言する", async () => {
    await new BskyPublisher("id", "pw").publish("【地震情報】熊本県");

    expect(post.mock.calls[0][0].langs).toEqual(["ja"]);
    expect(post.mock.calls[0][0].text).toBe("【地震情報】熊本県");
  });

  it("リプライでも言語の宣言は残る", async () => {
    const reply = {
      root: { cid: "c", uri: "u" },
      parent: { cid: "c", uri: "u" },
    };
    await new BskyPublisher("id", "pw").publish("本文", reply);

    expect(post.mock.calls[0][0].langs).toEqual(["ja"]);
    expect(post.mock.calls[0][0].reply).toEqual(reply);
  });

  it("リプライが無ければ reply を付けない", async () => {
    await new BskyPublisher("id", "pw").publish("本文");
    expect(post.mock.calls[0][0].reply).toBeUndefined();
  });

  // existing を展開せずに返すとアバターとバナーが消える
  it("プロフィールの更新で既存のアバターとバナーを残す", async () => {
    await new BskyPublisher("id", "pw").updateProfile({
      displayName: "緊急地震速報",
      description: "新しい説明",
    });

    const update = upsertProfile.mock.calls[0][0];
    expect(
      update({
        displayName: "旧",
        description: "旧",
        avatar: { blobId: "avatar" },
        banner: { blobId: "banner" },
        pinnedPost: { uri: "at://x", cid: "cid" },
      }),
    ).toEqual({
      displayName: "緊急地震速報",
      description: "新しい説明",
      avatar: { blobId: "avatar" },
      banner: { blobId: "banner" },
      pinnedPost: { uri: "at://x", cid: "cid" },
    });
  });

  it("画像を渡せば差し替える", async () => {
    await new BskyPublisher("id", "pw").updateProfile({
      // biome-ignore lint/suspicious/noExplicitAny: BlobRef の代わりのダミー
      avatar: { blobId: "new" } as any,
    });

    const update = upsertProfile.mock.calls[0][0];
    expect(update({ avatar: { blobId: "old" } }).avatar).toEqual({
      blobId: "new",
    });
  });

  it("レコードが無いアカウントでも更新できる", async () => {
    await new BskyPublisher("id", "pw").updateProfile({ displayName: "名前" });

    const update = upsertProfile.mock.calls[0][0];
    expect(update(undefined)).toEqual({
      displayName: "名前",
      description: undefined,
      avatar: undefined,
      banner: undefined,
    });
  });

  it("uploadBlob は BlobRef を返す", async () => {
    const blob = await new BskyPublisher("id", "pw").uploadBlob(
      Uint8Array.from([1]),
      "image/png",
    );

    expect(uploadBlob.mock.calls[0][1]).toEqual({ encoding: "image/png" });
    expect(blob).toEqual({ blobId: "uploaded" });
  });

  // 取り違えたアカウントのプロフィールを書き換えないための照合に使う
  it("ログイン中のハンドルを返す", () => {
    expect(new BskyPublisher("id", "pw").handle()).toBe("eew.bsky.social");
  });
});
