export const HANDOFF_EXTENSION_VERSION = "5.0.2";

export interface Side {
  id: string;
  name: string;
  sessionId: string;
  pid: number;
  worktree: string;
  branch: string;
  removedAt?: string;
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
  kind: "check" | "complete" | "close" | "reopen" | "block" | "unblock" | "integration";
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
  deliveryId?: string;
  delivery?: { id: string; workspaceId: string; base: string; tip: string; tree: string; commits: string[]; files: string[]; digest: string };
  commit: string | null;
  summary: string | null;
  reviewNote: string | null;
  requiresIntegration: boolean;
  integration: TaskIntegration | null;
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
  requiresIntegration?: boolean;
}

export interface IntegrationCheck {
  command: string;
  args: string[];
}

export interface TaskIntegration {
  deliveryId?: string;
  targetKey?: string;
  policyRevision?: string;
  approvedCommits?: string[];
  jobId: string;
  state: "queued" | "running" | "blocked" | "pushed";
  commit: string;
  mainCommit?: string;
  note: string;
}

export interface IntegrationJob extends TaskIntegration {
  taskId: number;
  creator: string;
  repo: string;
  remoteFingerprint: string;
  reviewedBase: string;
  checks: IntegrationCheck[];
  attempts: number;
}
