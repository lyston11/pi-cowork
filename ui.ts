import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { HandoffTask, TaskSummary } from "./types.ts";

// Task text is data: remove terminal controls before applying our own styles.
const plain = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, " ");

export function taskLines(task: HandoffTask | TaskSummary, expanded: boolean, theme: Theme, width: number): string[] {
  const checked = task.items.filter((item) => item.checked).length;
  const status = task.state === "open"
    ? task.block?.userRequest ? "[! 需要你配合]" : task.block ? task.block.needsReview ? "[!] 依赖更新待复核" : "[⏸] 被阻塞" : "[ ] 待核对/处理"
    : task.state === "completed" ? task.integration ? `[✓] 集成${({ queued: "排队中", running: "执行中", blocked: "受阻", pushed: "已推送待关闭" })[task.integration.state]}` : task.kind === "local" ? "[✓] 待本侧核查/收口" : "[✓] 待发起方验收" : task.state === "cancelled" ? "[×] 已取消" : "[✓] 已验收关闭";
  const fold = expanded ? "▾" : "▸";
  const priorityLabel = ({ urgent: "P0 紧急", high: "P1 高", normal: "P2 普通", low: "P3 低" } as const)[task.priority];
  const responsible = task.block?.userRequest ? "等待用户配合" : task.state === "completed" ? task.integration?.state === "queued" || task.integration?.state === "running" ? "集成队列执行"
    : `${plain(task.creator.name)}${task.integration?.state === "blocked" ? "处理集成阻塞" : task.integration?.state === "pushed" ? "核对集成并关闭" : task.kind === "local" ? "核查并收口" : "验收"}`
    : task.block && !task.block.needsReview ? `${plain(task.block.waitingFor)}提供条件`
    : `${plain(task.assignee.name)}${task.block ? "复核依赖" : "核对并处理"}`;
  const heading = `${fold} [${priorityLabel}] #${task.id} ${status} ${task.kind === "local" ? `${plain(task.creator.name)} · 本侧任务` : `${plain(task.creator.name)} → ${plain(task.assignee.name)}`} · ${plain(task.subject)} · ${checked}/${task.items.length}${task.state === "closed" || task.state === "cancelled" ? "" : ` · 下一步：${responsible}`}`;
  const lines = [heading];
  if (task.cancellation) lines.push(`  取消原因：${plain(task.cancellation.reason)}`);
  if (task.block) {
    if (task.block.userRequest) {
      const request = `  需要你配合：${plain(task.block.userRequest)}`;
      lines.push(expanded ? request : truncateToWidth(request, width));
    }
    const reason = `  阻塞：${plain(task.block.reason)}`;
    lines.push(expanded ? reason : truncateToWidth(reason, width));
    if (task.block.dependencies.length) {
      const dependencies = `  依赖：${task.block.dependencies.map((id) => `#${id}`).join("、")}`;
      lines.push(expanded ? dependencies : truncateToWidth(dependencies, width));
    }
  }
  if (expanded) {
    if ("body" in task) lines.push(...task.body.split("\n").map((line) => `  ${plain(line)}`));
    if ("events" in task) for (const reply of task.events.filter(event => event.kind === "reply")) {
      const author = reply.actor === task.creator.id ? task.creator.name : task.assignee.name;
      lines.push(`  沟通 #${reply.seq} · ${plain(author)}${reply.data.inReplyTo ? ` · 回应 #${reply.data.inReplyTo}` : ""}`);
      lines.push(...String(reply.data.message).split("\n").map(line => `    ${plain(line)}`));
    }
    lines.push(...task.items.map((item, index) => `  [${item.checked ? "✓" : " "}] ${index + 1}. ${plain(item.text)}`));
    if (task.commit) lines.push(`  commit: ${task.commit}`);
    if (task.delivery) {
      lines.push(`  固定交付: ${task.delivery.id}`);
      lines.push(`  范围: ${task.delivery.base.slice(0, 12)}..${task.delivery.tip.slice(0, 12)} · ${task.delivery.commits.length} 个提交`);
      lines.push(`  摘要: ${task.delivery.digest}`);
    }
    if (task.requiresIntegration) lines.push("  集成要求: 审查通过后合入并推送 origin/main，再关闭任务");
    if (task.integration) {
      lines.push(`  集成状态: ${task.integration.state} · ${plain(task.integration.note)}`);
      if (task.integration.reviewMode) lines.push(`  核查类型: ${task.integration.reviewMode === "self" ? "本侧核查（不等于独立审查）" : "跨侧审查"}`);
      if (task.integration.mainCommit) lines.push(`  main commit: ${task.integration.mainCommit}`);
    }
    if (task.summary) lines.push(`  完成说明: ${plain(task.summary)}`);
    if (task.reviewNote) lines.push(`  验收说明: ${plain(task.reviewNote)}`);
    lines.push(...task.refs.map((ref) => `  ref: ${plain(ref)}`));
  } else if (task.commit && task.state === "completed") {
    lines.push(`  commit: ${task.commit}`);
  }
  return lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width))).map((line) => {
    if (task.state === "closed" || task.state === "cancelled") return theme.fg("dim", theme.strikethrough(line));
    return task.state === "completed" ? theme.fg("success", line) : task.block ? theme.fg("warning", line) : line;
  });
}
