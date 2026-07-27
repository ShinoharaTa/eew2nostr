import { gunzip } from "node:zlib";
import axios from "axios";
import WebSocket from "ws";
import { logger } from "../logger.js";
import type { JsonSchema } from "../types/eew";

export interface ReceiverEvents {
  onTelegram: (telegram: JsonSchema) => void;
  onDisconnect: (reason: string) => void;
}

// dmdata の WebSocket から電文を受信し、展開してコールバックに渡す取得層。
// 配信層のことは知らない。
export class DmdataReceiver {
  constructor(
    private token: string,
    private events: ReceiverEvents,
  ) {}

  async start(): Promise<void> {
    const params = {
      classifications: ["eew.forecast"],
      test: "including",
      formatMode: "json",
      types: ["VXSE45", "VXSE42"],
    };
    const response = await axios.post(
      "https://api.dmdata.jp/v2/socket",
      params,
      {
        headers: {
          Authorization: `Basic ${this.token}`,
        },
      },
    );
    this.connect(response.data.websocket.url);
  }

  private connect(url: string): void {
    logger.info("web socket start");
    const websocket = new WebSocket(url, ["dmdata.v2"]);

    websocket.on("message", async (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping") {
        websocket.send(JSON.stringify({ type: "pong", pingId: msg.pingId }));
      }
      if (msg.type === "data") {
        if (msg.head.test) {
          logger.info("test ok.");
          return;
        }
        logger.info(msg);
        try {
          const telegram = await this.decompress(msg.body);
          this.events.onTelegram(telegram);
        } catch (e) {
          logger.error(e);
        }
      }
      if (msg.type === "start") {
        logger.info("ws start", msg);
      }
      if (msg.type === "error") {
        logger.info(msg);
        this.events.onDisconnect(`EEW System on error.\n${msg.error}`);
      }
    });
    websocket.on("close", () => {
      logger.info("WebSocket connection closed");
      this.events.onDisconnect("EEW System Connection Closed");
    });
    websocket.on("error", (ev) => {
      logger.info(ev);
      this.events.onDisconnect(`EEW System on error.\n${ev.message}`);
    });
  }

  private decompress(data: string): Promise<JsonSchema> {
    return new Promise((resolve, reject) => {
      const buffer = Buffer.from(data, "base64");
      gunzip(buffer, (err, decompressed) => {
        if (err) {
          logger.error(err);
          reject(err);
          return;
        }
        const decompressedString = decompressed.toString();
        try {
          resolve(JSON.parse(decompressedString));
        } catch (error) {
          logger.error(error);
          logger.error(decompressedString);
          reject(new Error("parse error."));
        }
      });
    });
  }
}
