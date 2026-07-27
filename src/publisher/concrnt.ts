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
