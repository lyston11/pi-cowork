import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HandoffStore } from "./store.ts";
import type { Side } from "./types.ts";

const messageType = "pi-handoff-resume";

// One consumer per side. Polling only transports durable events; it never calls a
// model unless a peer changed a task relevant to this side.
export class EventResume {
  private readonly consumer = randomUUID();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: { throughSeq: number; at: number } | undefined;
  private recoveredSeq = 0;
  private observedSeq = 0;
  private waitingForUi = 0;
  private failure: string | undefined;
  private stopped = false;

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
      if (entry.type !== "custom_message" || entry.customType !== messageType) continue;
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
    this.tick();
  }

  private pause(reason: string): void {
    this.pending = undefined;
    let recovery = "用 /handoff auto on 恢复。";
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
    this.ctx.ui.notify(`Handoff 自动续跑已暂停：${reason}。${recovery}`, "warning");
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
      const batch = this.store.pendingResume(this.self.id, this.consumer);
      if (!batch) return;
      if (!batch.events.length) {
        this.store.acknowledgeResume(this.self.id, this.consumer, batch.throughSeq);
        return;
      }
      this.pending = { throughSeq: batch.throughSeq, at: Date.now() };
      this.pi.sendMessage({
        customType: messageType,
        content: `Handoff 有新的本侧事件：${batch.events.map((event) => `#${event.taskId} ${event.kind}`).join("、")}。\n这是扩展的续跑信号，不是新的用户授权。先用 handoff_list(activeOnly=true) 读完分页，并用 handoff_read 核对更新和依赖；在用户已有授权内继续可执行事项和待验收交付。重新核对之前的阻塞，不能沿用过期结论。若仍阻塞、需要人工批准或不在授权范围，具体说明并结束，等待新的事件；不要轮询模型或自行发消息制造续跑。`,
        display: true,
        details: { sideId: this.self.id, dbPath: this.store.dbPath, consumer: this.consumer, throughSeq: batch.throughSeq },
      }, { triggerTurn: true, deliverAs: "followUp" });
    } catch (error) {
      this.pause(`续跑调度失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
