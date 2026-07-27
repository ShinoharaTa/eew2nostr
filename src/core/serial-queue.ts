// SNSごとの投稿順序を保証する直列キュー。
// 前のジョブの完了を待ってから次のジョブを実行する。
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  push(job: () => Promise<void>): void {
    this.tail = this.tail.then(job).catch(() => {
      // ジョブ内でエラー処理される前提だが、万一の例外でもチェーンは止めない
    });
  }

  // 積まれた全ジョブの完了を待つ(テスト・シャットダウン用)
  idle(): Promise<void> {
    return this.tail;
  }
}
