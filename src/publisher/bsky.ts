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
      ...(reply ? { reply } : {}),
    });
  }
}
