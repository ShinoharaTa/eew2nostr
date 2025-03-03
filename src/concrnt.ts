import { Client } from "@concrnt/worldlib";
import dotenv from "dotenv";

dotenv.config();
const { CONCRNT_CHANNEL, CONCRNT_SUBKEY } = process.env;

// const  = "tar69vv26r5s4wk0r067v20bvyw@ariake.concrnt.net";

const client = await Client.createFromSubkey(CONCRNT_SUBKEY ?? "");
const timelines: string[] = [];
const homeTimeline = () => {
  if (client.user) timelines.push(client.user.homeTimeline);
  if (CONCRNT_CHANNEL) timelines.push(CONCRNT_CHANNEL);
};
homeTimeline();

export const ConcrntPublish = async (body: string, root?: { root: string }) => {
  if (root) {
    const message = await client.getMessage(root.root, client.ccid ?? "");
    message?.reply(timelines, body);
    return null;
  }
  return await client.createMarkdownCrnt(body, timelines);
};
