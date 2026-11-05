import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HandoffStore } from "./store.ts";
import type { Side } from "./types.ts";

const messageType = "pi-cowork-resume";

// One consumer per side. Peer events and bounded task checkpoints are durable;
// unchanged unfinished work cannot schedule an endless model loop.
export class EventResume {
  private readonly consumer = randomUUID();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: { throughSeq: number; at: number } | undefined;
  private recoveredSeq = 0;
  private observedSeq = 0;
  private waitingForUi = 0;
  private failure: string | undefined;
  private stopped = false;
  private reconcile = true;

  private readonly pi: ExtensionAPI;
  private readonly store: HandoffStore;
  readonly self: Side;
  private readonly ctx: ExtensionContext;

  constructor(pi: ExtensionAPI, store: HandoffStore, self: Side, ctx: ExtensionContext) {
    this.pi = pi;
    this.store = store;
    this.self = self;
    this.ctx = ctx;
  }

  start(): void {
    // A crash can occur between persisting the message and acknowledging its
    // cursor. Recover from the transcript instead of re-sending that batch.
    for (const entry of this.ctx.sessionManager.getEntries()) {
      // Read the old name only to recover delivery cursors from existing transcripts.
      if (entry.type !== "custom_message" || (entry.customType !== messageType && entry.customType !== "pi-handoff-resume")) continue;
      const details = entry.details as { sideId?: string; dbPath?: string; throughSeq?: number } | undefined;
      if (details?.sideId === this.self.id && details.dbPath === this.store.dbPath && Number.isSafeInteger(details.throughSeq)) {
        this.recoveredSeq = Math.max(this.recoveredSeq, details.throughSeq!);
      }
    }
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.store.releaseResume(this.self.id, this.consumer);
  }

  runStarted(): void { this.failure = undefined; }
  uiWaiting(waiting: boolean): void { this.waitingForUi = Math.max(0, this.waitingForUi + (waiting ? 1 : -1)); }

  observeMessage(message: any): void {
    if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") this.failure = String(message.errorMessage || message.stopReason).slice(0, 500);
      return;
    }
    if (message.role !== "custom" || message.customType !== messageType) return;
    const details = message.details;
    if (details?.sideId !== this.self.id || details.dbPath !== this.store.dbPath || details.consumer !== this.consumer) return;
    // Pi emits message_end to extensions before appending the transcript.
    // Treat it as a hint and wait for a persisted entry before acknowledging.
    this.observedSeq = Math.max(this.observedSeq, details.throughSeq);
  }

  settled(aborted: boolean): void {
    if (aborted || this.failure) {
      this.pause(aborted ? "用户中止了运行" : `模型运行失败：${this.failure}`);
      return;
    }
    this.reconcile = true;
    this.tick();
  }

  private pause(reason: string): void {
    this.pending = undefined;
    let recovery = "用 /cowork auto on 恢复。";
    try {
      this.store.setResumeEnabled(this.self.id, false, reason);
    } catch {
      // If storage is unavailable, stop locally as well. A failing interval
      // must not keep rescheduling messages or throw out of the event loop.
      this.stopped = true;
      clearInterval(this.timer);
      this.timer = undefined;
      recovery = "暂停状态无法写入，已停止本进程调度；修复存储后执行 /reload。";
    }
    this.ctx.ui.notify(`CoWork 自动续跑已暂停：${reason}。${recovery}`, "warning");
  }

  tick(): void {
    if (this.stopped) return;
    try {
      if (!this.store.acquireResume(this.self.id, this.self.sessionId, this.consumer)) return;
      if (this.recoveredSeq) {
        this.store.acknowledgeResume(this.self.id, this.consumer, this.recoveredSeq);
        this.recoveredSeq = 0;
      }
      if (this.pending && this.observedSeq >= this.pending.throughSeq) {
        const persisted = this.ctx.sessionManager.getEntries().some((entry) => {
          if (entry.type !== "custom_message" || entry.customType !== messageType) return false;
          const details = entry.details as { consumer?: string; throughSeq?: number } | undefined;
          return details?.consumer === this.consumer && details.throughSeq === this.pending!.throughSeq;
        });
        if (persisted) {
          this.store.acknowledgeResume(this.self.id, this.consumer, this.pending.throughSeq);
          this.pending = undefined;
          this.observedSeq = 0;
        }
      }
      if (this.pending) {
        if (Date.now() - this.pending.at > 30000 && this.ctx.isIdle()) this.pause("续跑消息未被 Pi 接收，事件保留，等待人工恢复");
        return;
      }
      if (!this.ctx.isIdle() || this.ctx.hasPendingMessages() || this.waitingForUi > 0) return;
      if (this.ctx.mode === "tui" && this.ctx.ui.getEditorText().trim()) return;
      let batch = this.store.pendingResume(this.self.id, this.consumer);
      if (!batch && this.reconcile) {
        this.reconcile = false;
        const remaining = this.store.reconcileResume(this.self.id, this.consumer);
        if (remaining.stalled.length) {
          const ids = remaining.stalled.map((id) => `#${id}`).join("、");
          this.ctx.ui.notify(`CoWork 仍未收口：${ids}。本轮未完成、未登记阻塞或待复核；同一版本已自动核对过，不再重复唤起。请核对任务和授权后继续，或明确登记阻塞。`, "warning");
        }
        batch = this.store.pendingResume(this.self.id, this.consumer);
      }
      if (!batch) return;
      if (!batch.events.length) {
        this.store.acknowledgeResume(this.self.id, this.consumer, batch.throughSeq);
        return;
      }
      this.reconcile = false;
      const kinds = new Set(batch.events.map(event => event.kind));
      const guidance = [
        '按现有协作规则用 cowork_list(activeOnly=true) 读完分页，cowork_read 核对更新和依赖；继续既有授权内可执行事项和验收。真实阻塞须登记，不新增授权，不轮询或自行制造续跑。',
        ...(kinds.has('blocked') ? ['blocked：发起方复核责任和独立可做部分，推进内部缺口；缺用户配置、操作或批准须具体报告，不能代他侧解除阻塞。'] : []),
        ...(kinds.has('checkpoint') ? ['checkpoint：必须重读相关任务，即使 state/commit/items 未变；未登记阻塞不保证条件已满足。'] : []),
        ...(kinds.has('dependency') ? ['依赖变化先验证材料和授权，再 cowork_unblock 或更新 cowork_block；不能自动放行。'] : []),
      ].join('\n');
      this.pending = { throughSeq: batch.throughSeq, at: Date.now() };
      this.pi.sendMessage({
        customType: messageType,
        content: `CoWork 本侧需要核对：${batch.events.map((event) => `#${event.taskId} ${event.kind}`).join("、")}。\n${guidance}`,
        display: true,
        details: { sideId: this.self.id, dbPath: this.store.dbPath, consumer: this.consumer, throughSeq: batch.throughSeq },
      }, { triggerTurn: true, deliverAs: "followUp" });
    } catch (error) {
      this.pause(`续跑调度失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
