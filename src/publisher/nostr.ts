import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { type EventTemplate, finalizeEvent } from "nostr-tools/pure";
import WebSocket from "ws";

useWebSocketImplementation(WebSocket);

export class NostrPublisher {
  private seckey: Uint8Array;

  constructor(
    hex: string,
    private relays: string[],
  ) {
    this.seckey = new Uint8Array(Buffer.from(hex, "hex"));
  }

  async publishNote(params: {
    content: string;
    time: Date;
    reply?: { root: string | null; parent: string | null };
  }): Promise<string> {
    const ev: EventTemplate = {
      kind: 1,
      content: params.content,
      tags: [],
      created_at: Math.floor(params.time.getTime() / 1000),
    };
    if (params.reply) {
      if (params.reply.root) ev.tags.push(["e", params.reply.root, "", "root"]);
      if (params.reply.parent)
        ev.tags.push(["e", params.reply.parent, "", "reply"]);
    }
    return await this.send(ev);
  }

  async publishReplaceable(params: {
    kind: number;
    d: string;
    tags: string[][];
    content: string;
    createdAt: number;
  }): Promise<string> {
    const ev: EventTemplate = {
      kind: params.kind,
      content: params.content,
      tags: [["d", params.d], ...params.tags],
      created_at: params.createdAt,
    };
    return await this.send(ev);
  }

  async publishRaw(content: string, time: Date): Promise<string> {
    const ev: EventTemplate = {
      kind: 7078,
      content: content,
      tags: [["d", "eew_alert_system_by_shino3"]],
      created_at: Math.floor(time.getTime() / 1000),
    };
    return await this.send(ev);
  }

  private async send(ev: EventTemplate): Promise<string> {
    const post = finalizeEvent(ev, this.seckey);
    const pool = new SimplePool();
    await Promise.any(pool.publish(this.relays, post));
    return post.id;
  }
}
