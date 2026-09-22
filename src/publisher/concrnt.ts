import { Client } from "@concrnt/worldlib";

export class ConcrntPublisher {
  private client: Awaited<ReturnType<typeof Client.createFromSubkey>> | null =
    null;
  private timelines: string[] = [];

  constructor(
    private subkey: string,
    private channel?: string,
  ) {}

  async init(): Promise<void> {
    this.client = await Client.createFromSubkey(this.subkey);
    if (this.client.user) this.timelines.push(this.client.user.homeTimeline);
    if (this.channel) this.timelines.push(this.channel);
  }

  // サブキーから解決した CCID。プロフィールを更新する前に、
  // 設定のアカウントと同じものかを確かめるのに使う。
  ccid(): string | null {
    return this.client?.ccid ?? null;
  }

  // setProfile は lib 側で現在値とマージされるため、
  // 渡さなかった項目 (画像の取得に失敗したときなど) は消えない。
  async updateProfile(profile: {
    username?: string;
    description?: string;
    avatar?: string;
    banner?: string;
  }): Promise<void> {
    if (!this.client) throw new Error("ConcrntPublisher is not initialized.");
    await this.client.setProfile(profile);
  }

  async publish(body: string, root?: { root: string }) {
    if (!this.client) throw new Error("ConcrntPublisher is not initialized.");
    if (root) {
      const message = await this.client.getMessage(
        root.root,
        this.client.ccid ?? "",
      );
      await message?.reply(this.timelines, body);
      return null;
    }
    return await this.client.createMarkdownCrnt(body, this.timelines);
  }
}
