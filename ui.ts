import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { HandoffTask, TaskSummary } from "./types.ts";

// Task text is data: remove terminal controls before applying our own styles.
const plain = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, " ");

export function taskLines(task: HandoffTask | TaskSummary, expanded: boolean, theme: Theme, width: number): string[] {
  const checked = task.items.filter((item) => item.checked).length;
  const status = task.state === "open" ? "[ ] 待处理" : task.state === "completed" ? "[✓] 待发起方验收" : "[✓] 已验收关闭";
  const fold = expanded ? "▾" : "▸";
  const heading = `${fold} #${task.id} ${status} ${plain(task.creator.name)} → ${plain(task.assignee.name)} · ${plain(task.subject)} · ${checked}/${task.items.length}`;
  const lines = [heading];
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
    return task.state === "completed" ? theme.fg("success", line) : line;
  });
}
