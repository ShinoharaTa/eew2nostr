import { AtpAgent } from "@atproto/api";
import { BskyPublisher } from "../src/publisher/bsky";

jest.mock("@atproto/api");

describe("BskyPublisher", () => {
  let post: jest.Mock;
  let login: jest.Mock;

  beforeEach(() => {
    post = jest.fn().mockResolvedValue({ cid: "cid", uri: "uri" });
    login = jest.fn().mockResolvedValue(undefined);
    (AtpAgent as unknown as jest.Mock).mockImplementation(() => ({
      post,
      login,
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
});
