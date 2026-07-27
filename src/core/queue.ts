// 受信(receiver)と配信(publisher)を疎結合に繋ぐプロセス内キュー
export class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: ((item: T) => void)[] = [];

  push(item: T): void {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver(item);
    } else {
      this.items.push(item);
    }
  }

  pop(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  get size(): number {
    return this.items.length;
  }
}
