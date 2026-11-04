import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { HandoffTask, TaskSummary } from "./types.ts";

// Task text is data: remove terminal controls before applying our own styles.
const plain = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, " ");

export function taskLines(task: HandoffTask | TaskSummary, expanded: boolean, theme: Theme, width: number): string[] {
  const checked = task.items.filter((item) => item.checked).length;
  const status = task.state === "open"
    ? task.block ? task.block.needsReview ? "[!] 依赖更新待复核" : "[⏸] 被阻塞" : "[ ] 待核对/处理"
    : task.state === "completed" ? "[✓] 待发起方验收" : "[✓] 已验收关闭";
  const fold = expanded ? "▾" : "▸";
  const responsible = task.state === "completed" ? `${plain(task.creator.name)}验收`
    : task.block && !task.block.needsReview ? `${plain(task.block.waitingFor)}提供条件`
    : `${plain(task.assignee.name)}${task.block ? "复核依赖" : "核对并处理"}`;
  const heading = `${fold} #${task.id} ${status} ${plain(task.creator.name)} → ${plain(task.assignee.name)} · ${plain(task.subject)} · ${checked}/${task.items.length}${task.state === "closed" ? "" : ` · 下一步：${responsible}`}`;
  const lines = [heading];
  if (task.block) {
    const reason = `  阻塞：${plain(task.block.reason)}`;
    lines.push(expanded ? reason : truncateToWidth(reason, width));
    if (task.block.dependencies.length) {
      const dependencies = `  依赖：${task.block.dependencies.map((id) => `#${id}`).join("、")}`;
      lines.push(expanded ? dependencies : truncateToWidth(dependencies, width));
    }
  }
  if (expanded) {
    if ("body" in task) lines.push(...task.body.split("\n").map((line) => `  ${plain(line)}`));
    lines.push(...task.items.map((item, index) => `  [${item.checked ? "✓" : " "}] ${index + 1}. ${plain(item.text)}`));
    if (task.commit) lines.push(`  commit: ${task.commit}`);
    if (task.summary) lines.push(`  完成说明: ${plain(task.summary)}`);
    if (task.reviewNote) lines.push(`  验收说明: ${plain(task.reviewNote)}`);
    lines.push(...task.refs.map((ref) => `  ref: ${plain(ref)}`));
  } else if (task.commit && task.state === "completed") {
    lines.push(`  commit: ${task.commit}`);
  }
  return lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width))).map((line) => {
    if (task.state === "closed") return theme.fg("dim", theme.strikethrough(line));
    return task.state === "completed" ? theme.fg("success", line) : task.block ? theme.fg("warning", line) : line;
  });
}
