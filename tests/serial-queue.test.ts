import { SerialQueue } from "../src/core/serial-queue";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("SerialQueue", () => {
  it("ジョブを積んだ順に実行する", async () => {
    const queue = new SerialQueue();
    const order: number[] = [];
    queue.push(async () => {
      order.push(1);
    });
    queue.push(async () => {
      order.push(2);
    });
    queue.push(async () => {
      order.push(3);
    });
    await queue.idle();
    expect(order).toEqual([1, 2, 3]);
  });

  it("前のジョブの完了を待ってから次を実行する", async () => {
    const queue = new SerialQueue();
    const gate = deferred();
    const order: string[] = [];
    queue.push(async () => {
      order.push("1-start");
      await gate.promise;
      order.push("1-end");
    });
    queue.push(async () => {
      order.push("2-start");
    });
    await Promise.resolve();
    expect(order).toEqual(["1-start"]);
    gate.resolve();
    await queue.idle();
    expect(order).toEqual(["1-start", "1-end", "2-start"]);
  });

  it("ジョブが例外を投げてもチェーンは止まらない", async () => {
    const queue = new SerialQueue();
    const order: number[] = [];
    queue.push(async () => {
      throw new Error("boom");
    });
    queue.push(async () => {
      order.push(2);
    });
    await queue.idle();
    expect(order).toEqual([2]);
  });
});
