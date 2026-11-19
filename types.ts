export const HANDOFF_EXTENSION_VERSION = "5.4.8";

export interface Side {
  id: string;
  name: string;
  sessionId: string;
  pid: number;
  worktree: string;
  branch: string;
  removedAt?: string;
}

export type TaskPriority = "urgent" | "high" | "normal" | "low";
export type TaskState = "open" | "completed" | "closed" | "cancelled";
export type TaskKind = "local" | "handoff";
export interface UserAction {
  kind: "manual" | "input";
  limitation: string;
}
export interface BlockerActionInput {
  owner: string;
  action: string;
  expectedResult: string;
}

export interface BlockerAction {
  id: number;
  taskId: number;
  owner: Pick<Side, "id" | "name">;
  requester: Pick<Side, "id" | "name">;
  action: string;
  expectedResult: string;
  status: "pending" | "waiting" | "ready";
  revision: number;
  evidence?: string;
  dependencyId?: number;
  priority: TaskPriority;
  ownerAvailability: "available" | "paused" | "offline";
}

export interface TaskBlock {
  reason: string;
  waitingFor: string;
  action?: BlockerAction;
  external?: boolean;
  untracked?: boolean;
  userRequest?: string;
  userAction?: UserAction;
  userRequestNeedsReview?: boolean;
  dependencies: number[];
  needsReview: boolean;
}

export interface BackgroundResult {
  path: string;
  deadline: string;
  state: "waiting" | "ready" | "timedOut" | "unavailable";
}

export interface TaskEvent {
  seq: number;
  actor: string;
  kind: "check" | "complete" | "close" | "reopen" | "block" | "unblock" | "integration" | "reply" | "priority" | "cancel" | "action_result";
  data: Record<string, unknown>;
  at: string;
}

export interface HandoffTask {
  id: number;
  creator: Side;
  assignee: Side;
  kind: TaskKind;
  cancellation?: { actor: string; reason: string; at: string };
  subject: string;
  priority: TaskPriority;
  body: string;
  refs: string[];
  items: { text: string; checked: boolean }[];
  state: TaskState;
  block: TaskBlock | null;
  backgroundResult?: BackgroundResult;
  lastReply?: { seq: number; actor: string; at: string; inReplyTo?: number };
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
  to?: string;
  refs?: string[];
  subject: string;
  body: string;
  items: string[];
  priority?: TaskPriority;
  idempotencyKey?: string;
  requiresIntegration?: boolean;
}

export interface IntegrationCheck {
  command: string;
  args: string[];
}

export interface TaskIntegration {
  reviewMode?: "self" | "peer";
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
