import { AtpAgent, type BlobRef } from "@atproto/api";
import type { ReplyRef } from "@atproto/api/dist/client/types/app/bsky/feed/post";

// プロフィールに反映する内容。画像は uploadBlob 済みの BlobRef で渡す。
// 省略した項目は既存の値を残す。
export interface BskyProfileUpdate {
  displayName?: string;
  description?: string;
  avatar?: BlobRef;
  banner?: BlobRef;
}

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

  // ログイン中のハンドル。プロフィールを更新する前に、
  // 設定のアカウントと同じものへ繋がっているかを確かめるのに使う。
  handle(): string | null {
    return this.agent.session?.handle ?? null;
  }

  async uploadBlob(bytes: Uint8Array, mime: string): Promise<BlobRef> {
    const uploaded = await this.agent.uploadBlob(bytes, { encoding: mime });
    return uploaded.data.blob;
  }

  // upsertProfile は getRecord → updateFn → swapRecord 付き putRecord を行う。
  // existing を展開せずに新しいオブジェクトを返すと、アバターやバナー、
  // 固定ポストが消える。渡されなかった項目は既存の値のまま残す。
  async updateProfile(profile: BskyProfileUpdate): Promise<void> {
    await this.agent.upsertProfile((existing) => ({
      ...existing,
      displayName: profile.displayName ?? existing?.displayName,
      description: profile.description ?? existing?.description,
      avatar: profile.avatar ?? existing?.avatar,
      banner: profile.banner ?? existing?.banner,
    }));
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
