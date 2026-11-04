export const HANDOFF_EXTENSION_VERSION = "4.5.1";

export interface Side {
  id: string;
  name: string;
  sessionId: string;
  pid: number;
  worktree: string;
  branch: string;
}

export type TaskState = "open" | "completed" | "closed";
export interface TaskBlock {
  reason: string;
  waitingFor: string;
  dependencies: number[];
  needsReview: boolean;
}

export interface TaskEvent {
  seq: number;
  actor: string;
  kind: "check" | "complete" | "close" | "reopen" | "block" | "unblock";
  data: Record<string, unknown>;
  at: string;
}

export interface HandoffTask {
  id: number;
  creator: Side;
  assignee: Side;
  subject: string;
  body: string;
  refs: string[];
  items: { text: string; checked: boolean }[];
  state: TaskState;
  block: TaskBlock | null;
  commit: string | null;
  summary: string | null;
  reviewNote: string | null;
  createdAt: string;
  events: TaskEvent[];
}

export type TaskSummary = Omit<HandoffTask, "body" | "events">;

export interface CreateInput {
  to: string;
  subject: string;
  body: string;
  items: string[];
  refs?: string[];
  idempotencyKey?: string;
}
