import { generateSecretKey } from "nostr-tools/pure";
import { NostrPublisher, type RelayPoolPort } from "../src/publisher/nostr";

const hex = Buffer.from(generateSecretKey()).toString("hex");
const relays = ["wss://a.example", "wss://b.example", "wss://c.example"];

const deferred = () => {
  let resolve!: (value: string) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("NostrPublisher", () => {
  let pool: jest.Mocked<RelayPoolPort>;

  beforeEach(() => {
    pool = {
      publish: jest
        .fn()
        .mockImplementation((targets: string[]) =>
          targets.map(() => Promise.resolve("ok")),
        ),
      close: jest.fn(),
    };
  });

  it("複数回発行しても接続プールは作り直されない", async () => {
    const publisher = new NostrPublisher(hex, relays, pool);
    await publisher.publishNote({ content: "1", time: new Date() });
    await publisher.publishNote({ content: "2", time: new Date() });
    await publisher.publishRaw("{}", new Date());

    // 同じプールが使い回されている
    expect(pool.publish).toHaveBeenCalledTimes(3);
    for (const call of pool.publish.mock.calls) {
      expect(call[0]).toEqual(relays);
    }
  });

  it("最初の1リレーが受理した時点で返る", async () => {
    const first = deferred();
    const slow = deferred();
    pool.publish.mockReturnValue([first.promise, slow.promise, slow.promise]);
    const publisher = new NostrPublisher(hex, relays, pool);

    let settled = false;
    const publishing = publisher
      .publishNote({ content: "hello", time: new Date() })
      .then((id) => {
        settled = true;
        return id;
      });

    await Promise.resolve();
    expect(settled).toBe(false);

    first.resolve("ok");
    const eventId = await publishing;
    // 遅いリレーの完了を待たずに返っている
    expect(settled).toBe(true);
    expect(eventId).toHaveLength(64);
    slow.resolve("ok");
  });

  it("一部のリレーが失敗しても成功として返る", async () => {
    pool.publish.mockReturnValue([
      Promise.reject(new Error("relay down")),
      Promise.resolve("ok"),
      Promise.reject(new Error("relay down")),
    ]);
    const publisher = new NostrPublisher(hex, relays, pool);

    await expect(
      publisher.publishNote({ content: "hello", time: new Date() }),
    ).resolves.toHaveLength(64);
  });

  it("全リレーが失敗した場合は例外になる", async () => {
    pool.publish.mockReturnValue([
      Promise.reject(new Error("relay down")),
      Promise.reject(new Error("relay down")),
      Promise.reject(new Error("relay down")),
    ]);
    const publisher = new NostrPublisher(hex, relays, pool);

    await expect(
      publisher.publishNote({ content: "hello", time: new Date() }),
    ).rejects.toThrow();
  });

  it("relays を指定するとその宛先だけに発行する", async () => {
    const statusRelays = ["wss://own.example"];
    const publisher = new NostrPublisher(hex, relays, pool);
    await publisher.publishReplaceable({
      kind: 30830,
      d: "eew:1",
      tags: [["t", "eew"]],
      content: "{}",
      createdAt: 1,
      relays: statusRelays,
    });

    expect(pool.publish.mock.calls[0][0]).toEqual(statusRelays);
  });

  it("kind 0 は d タグを持たない replaceable event として発行する", async () => {
    const publisher = new NostrPublisher(hex, relays, pool);
    await publisher.publishMetadata({
      name: "eew_shino3",
      display_name: "緊急地震速報",
    });

    const event = pool.publish.mock.calls[0][1];
    expect(event.kind).toBe(0);
    // kind 0 は pubkey + kind で置換されるため d タグは付けない
    expect(event.tags).toEqual([]);
    expect(JSON.parse(event.content)).toEqual({
      name: "eew_shino3",
      display_name: "緊急地震速報",
    });
  });

  it("kind 0 の宛先リレーを指定できる", async () => {
    const publisher = new NostrPublisher(hex, relays, pool);
    await publisher.publishMetadata({ name: "x" }, ["wss://own.example"]);

    expect(pool.publish.mock.calls[0][0]).toEqual(["wss://own.example"]);
  });

  it("dispose は使った宛先をすべて閉じる", async () => {
    const publisher = new NostrPublisher(hex, relays, pool);
    await publisher.publishNote({ content: "hello", time: new Date() });
    await publisher.publishReplaceable({
      kind: 30830,
      d: "eew:1",
      tags: [],
      content: "{}",
      createdAt: 1,
      relays: ["wss://own.example"],
    });
    publisher.dispose();

    expect(pool.close).toHaveBeenCalledTimes(1);
    expect(pool.close.mock.calls[0][0].sort()).toEqual(
      [...relays, "wss://own.example"].sort(),
    );
  });
});
