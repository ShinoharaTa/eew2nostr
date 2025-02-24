import { AtpAgent } from "@atproto/api";
import type { ReplyRef } from "@atproto/api/dist/client/types/app/bsky/feed/post";
import dotenv from "dotenv";

const agent = new AtpAgent({
  service: "https://bsky.social",
});

dotenv.config();
const { BSKY_IDENTIFIER, BSKY_PASSWORD } = process.env;

export const BskyInit = async () => {
  await agent.login({
    identifier: BSKY_IDENTIFIER ?? "",
    password: BSKY_PASSWORD ?? "",
  });
};

type PostItem = {
  text: string;
  reply: ReplyRef | undefined;
};

export const BskyPublish = async (
  content: string,
  reply?: ReplyRef,
): Promise<{ cid: string; uri: string }> => {
  const post: PostItem = {
    text: content,
    reply: undefined,
  };
  if (reply) post.reply = reply;
  const result = await agent.post(post);
  return result;
};
