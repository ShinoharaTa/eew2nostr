import { AtpAgent } from "@atproto/api";
import type { ReplyRef } from "@atproto/api/dist/client/types/app/bsky/feed/post";

export class BskyPublisher {
  private agent = new AtpAgent({
    service: "https://bsky.social",
  });

  constructor(
    private identifier: string,
    private password: string,
  ) {}

  async init(): Promise<void> {
    await this.agent.login({
      identifier: this.identifier,
      password: this.password,
    });
  }

  async publish(
    content: string,
    reply?: ReplyRef,
  ): Promise<{ cid: string; uri: string }> {
    return await this.agent.post({
      text: content,
      // 言語を明示する。宣言が無いとクライアント側の推定に委ねられ、
      // 漢字が主体の防災情報は日本語と判定されないことがある。
      langs: ["ja"],
      ...(reply ? { reply } : {}),
    });
  }
}
