import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HandoffStore, type ResumeEvent } from "./store.ts";
import type { Side } from "./types.ts";

const messageType = "pi-cowork-resume";
const actions: Record<ResumeEvent["kind"], string> = {
  created: "承接方读取任务，继续已授权工作，缺条件登记阻塞。",
  reopen: "承接方重读退回意见，按原授权修正。",
  blocked: "发起方复核阻塞回报、责任和独立可做部分；补内部输入或报告外部条件，不能代他侧解除阻塞。",
  dependency: "重读待复核任务；依赖变化先验证材料和授权（包括新增回应），再解除或更新阻塞，不能自动放行。",
  reply: "读取对侧新增材料或澄清及必要依赖，核对下一步责任；需要实质回应时用 cowork_reply 并引用 inReplyTo，不复述等待，不用回复代替交付或批准。",
  priority: "读取优先级变更并按原授权重新安排任务顺序。",
  complete: "任务负责人读取交付，核对精确提交及完整范围，再集成或验收。本侧任务由自己完成闭环，不为过流程转派实施；本侧核查不等于独立审查。",
  integration: "发起方读取集成结果和检查；已推送则核对并关闭，受阻则处理原因，排队或运行中等待事件。",
  close: "读取验收结果，继续因此可推进的相关待办，不重做已关闭交付。",
  cancel: "任务已正式取消：停止该任务的后续实施，不重开、不继续交付；代码和历史保留。相关依赖重新核对，不能把取消当成产物已交付。",
  checkpoint: "必须重读指定未收口任务，即使摘要未变；核对相关依赖、授权和实际阻塞。userRequestNeedsReview 表示旧用户请求须由 Agent 复核：已有授权内自行继续，内部依赖由责任侧处理；确需用户操作或越过明确授权边界时补全依据，不让用户重复批准。",
};

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
      for (const pending of this.store.pendingUserRequestNotifications(this.self.id)) {
        const task = this.store.claimUserRequestNotification(this.self.id, pending.taskId, pending.blockSeq);
        if (task?.block?.userRequest) {
          const title = task.block.userAction?.kind === 'authorization' ? 'CoWork 需要你决定' : 'CoWork 需要你配合';
          this.ctx.ui.notify(`${title} · #${task.id} ${task.subject}：${task.block.userRequest.replace(/\s+/g, " ").slice(0, 360)}`, "warning");
        }
      }
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
      const groups = new Map<ResumeEvent["kind"], number[]>();
      for (const event of batch.events) {
        const ids = groups.get(event.kind) ?? [];
        ids.push(event.taskId);
        groups.set(event.kind, ids);
      }
      const plan = [...groups].map(([kind, ids]) => `${ids.map(id => `#${id}`).join('、')} ${kind}：${actions[kind]}`).join('\n');
      const guidance = '前后用 cowork_list(activeOnly=true) 摘要查完分页；先 cowork_read 上列事件对象和必要依赖，其余只读新增、变化或仍可执行项。未变等待项不重读全文；未知基线补查。不扩权、不轮询、不自行制造续跑。';
      this.pending = { throughSeq: batch.throughSeq, at: Date.now() };
      this.pi.sendMessage({
        customType: messageType,
        content: `CoWork 事件定向续跑：\n${plan}\n${guidance}`,
        display: true,
        details: { sideId: this.self.id, dbPath: this.store.dbPath, consumer: this.consumer, throughSeq: batch.throughSeq,
          scope: "targeted", events: batch.events.map(({ taskId, kind }) => ({ taskId, kind })) },
      }, { triggerTurn: true, deliverAs: "followUp" });
    } catch (error) {
      this.pause(`续跑调度失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
