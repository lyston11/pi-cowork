import { initializeIntegration } from "./integration-store.ts";
import { initializeWorkspaces } from "./workspaces.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HANDOFF_EXTENSION_VERSION, type CreateInput, type HandoffTask, type Side, type TaskEvent, type TaskPriority, type TaskSummary, type UserAction } from "./types.ts";

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${name} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function isUserWaiting(value: string): boolean {
  return /user|用户|manual test|人工测试|手工测试/i.test(value);
}

// Read queries use the same validator as writes. Never persist this connection-
// local function in triggers: older Pi processes must still be able to write.
const userActionEvidenceSql = 'cowork_valid_user_request(e.data_json)=1';

function validateUserAction(action: UserAction | undefined): asserts action is UserAction {
  if (!action || !['manual', 'input'].includes(action.kind)) {
    throw new Error('userAction is required and only accepts manual or input. Approvals belong to Agents, not the user; do not turn them into user requests or relabel them as manual/input.');
  }
  text(action.limitation, 'userAction.limitation: why no authorized Agent can do this', 1000);
}

function validateUserRequest(value: unknown, action: UserAction | undefined): void {
  const request = text(value, 'User action request', 1000);
  validateUserAction(action);
  const approval = /^\s*(?:(?:请|麻烦)(?:你|您)?\s*)?(?:(?:回复|答复)\s*)?[“"'「]?(?:批准|授权|同意)(?:仅|本次|继续|执行|实施|更新|发布|部署|重启|合并|推进)/;
  const approvalEnglish = /^\s*(?:please\s+)?(?:(?:reply|respond)\s+(?:with\s+)?["']?)?(?:approve|authori[sz]e|decide whether to|give (?:your )?(?:approval|permission))\b/i;
  if (approval.test(request) || approvalEnglish.test(request)) {
    throw new Error('Approvals belong to Agents, not the user. Continue the delegated work; userRequest is only for an actual user-only operation or unavailable input.');
  }
  const content = `${request.trim()}\n${action.limitation.trim()}`;
  // Reject explicit denials, not incidental words such as “无需重装” or
  // “没有用户操作权限”. This is a contradiction guard, not an authorization judge.
  const denied = /(?:(?:无需|无须|不需(?:要)?|不用)(?:用户|你|您)(?:进行)?(?:操作|输入|配合|协作|批准|授权)|(?:用户|你|您)(?:无需|无须|不需(?:要)?|不用)(?:操作|输入|配合|协作)|无(?:新增)?用户(?:操作(?:条件)?|输入|配合(?:项)?|协作(?:项)?))(?=$|[，。；、,.!?！？;:\n])/m;
  const deniedEnglish = /\b(?:no (?:user|human) (?:action|input|assistance|approval)(?: (?:is )?(?:needed|required|necessary))?|(?:user|human) (?:action|input|assistance|approval) (?:is )?not (?:needed|required|necessary))\s*(?=$|[.;,!?\n])/im;
  if (denied.test(content) || deniedEnglish.test(content)) {
    throw new Error('No user action is requested. For internal dependencies omit userRequest and userAction; re-register the actual waitingFor and dependencies to withdraw a previous request without unblocking the task.');
  }
}

function integer(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
  return value;
}

const priorityRank: Record<TaskPriority, number> = { urgent: 4, high: 3, normal: 2, low: 1 };
function priority(value: unknown): TaskPriority {
  if (value === "urgent" || value === "high" || value === "normal" || value === "low") return value;
  throw new Error("Priority must be urgent, high, normal, or low");
}

const immutable = (table: string) => `
  CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'CoWork records are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'CoWork records are append-only'); END;
`;

export interface HumanTaskSnapshot {
  ids: number[];
  eventSeq: number;
  actor?: string;
  userRequestCount?: number;
}

export interface ResumeEvent {
  seq: number;
  taskId: number;
  kind: "created" | "complete" | "reopen" | "close" | "cancel" | "dependency" | "checkpoint" | "integration" | "blocked" | "reply" | "priority";
}

export interface ResumeBatch {
  throughSeq: number;
  events: ResumeEvent[];
}

export type SideDirectoryScope = "current" | "history" | "all";

export interface SidePageOptions {
  query?: string;
  after?: string;
  limit?: number;
  scope?: SideDirectoryScope;
}

export interface SidePage {
  sides: Side[];
  nextAfter: string | null;
  total: number;
  matched: number;
}

export class HandoffStore {
  readonly rootDir: string;
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(channelDir: string) {
    this.rootDir = join(channelDir, "pi-handoff");
    this.dbPath = join(this.rootDir, "handoff.sqlite");
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.dbPath);
    try {
      this.db.function('cowork_valid_user_request', (value) => {
        try {
          const data = JSON.parse(String(value));
          validateUserRequest(data.userRequest, data.userAction);
          return 1;
        } catch { return 0; }
      });
      this.db.exec("PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      // New tables preserve all V3 messages and any earlier board records unchanged.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS handoff_sides (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          session_id TEXT NOT NULL,
          pid INTEGER NOT NULL,
          worktree TEXT NOT NULL,
          branch TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS handoff_side_bindings (
          side_id TEXT PRIMARY KEY REFERENCES handoff_sides(id),
          session_id TEXT UNIQUE
        );
        CREATE TABLE IF NOT EXISTS handoff_side_sessions (
          session_id TEXT PRIMARY KEY,
          side_id TEXT NOT NULL REFERENCES handoff_sides(id),
          released_at TEXT
        );
        CREATE TABLE IF NOT EXISTS handoff_side_transfers (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          side_id TEXT NOT NULL REFERENCES handoff_sides(id),
          from_session TEXT NOT NULL,
          to_session TEXT NOT NULL,
          actor_side TEXT NOT NULL REFERENCES handoff_sides(id),
          reason TEXT NOT NULL,
          at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS handoff_side_removals (
          side_id TEXT PRIMARY KEY REFERENCES handoff_sides(id),
          session_id TEXT NOT NULL,
          actor TEXT NOT NULL REFERENCES handoff_sides(id),
          reason TEXT NOT NULL,
          at TEXT NOT NULL
        );
        ${immutable("handoff_side_removals")}
        CREATE TRIGGER IF NOT EXISTS handoff_removed_side_update BEFORE UPDATE ON handoff_sides
          WHEN EXISTS(SELECT 1 FROM handoff_side_removals WHERE side_id=OLD.id)
          BEGIN SELECT RAISE(ABORT,'Side was removed; it cannot register again'); END;
        CREATE TRIGGER IF NOT EXISTS handoff_removed_side_insert BEFORE INSERT ON handoff_sides
          WHEN EXISTS(SELECT 1 FROM handoff_side_removals WHERE side_id=NEW.id)
          BEGIN SELECT RAISE(ABORT,'Side was removed; it cannot register again'); END;
        DROP TRIGGER IF EXISTS handoff_side_owner_guard_v2;
        CREATE TRIGGER IF NOT EXISTS handoff_side_owner_guard_v3 BEFORE UPDATE ON handoff_sides
          WHEN NEW.session_id<>OLD.session_id AND (
            EXISTS(SELECT 1 FROM handoff_side_transfers t WHERE t.side_id=OLD.id AND t.from_session=NEW.session_id)
            OR (NOT EXISTS(SELECT 1 FROM handoff_side_bindings b WHERE b.side_id=OLD.id AND b.session_id=NEW.session_id)
              AND NOT EXISTS(SELECT 1 FROM handoff_side_sessions s WHERE s.side_id=OLD.id AND s.session_id=NEW.session_id AND s.released_at IS NOT NULL))
          )
          BEGIN SELECT RAISE(ABORT, 'Side ownership transferred; this session cannot reclaim it'); END;
        DROP TRIGGER IF EXISTS handoff_side_owner_guard;
        ${immutable("handoff_side_transfers")}
        CREATE TABLE IF NOT EXISTS handoff_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          creator TEXT NOT NULL REFERENCES handoff_sides(id),
          assignee TEXT NOT NULL REFERENCES handoff_sides(id),
          subject TEXT NOT NULL,
          body TEXT NOT NULL,
          items_json TEXT NOT NULL,
          refs_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          idempotency_key TEXT,
          payload_hash TEXT NOT NULL,
          UNIQUE(creator, idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS handoff_task_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES handoff_tasks(id),
          actor TEXT NOT NULL REFERENCES handoff_sides(id),
          kind TEXT NOT NULL,
          data_json TEXT NOT NULL,
          at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS handoff_tasks_creator ON handoff_tasks(creator,id);
        CREATE INDEX IF NOT EXISTS handoff_tasks_assignee ON handoff_tasks(assignee,id);
        CREATE INDEX IF NOT EXISTS handoff_task_history ON handoff_task_events(task_id,seq);
        CREATE TRIGGER IF NOT EXISTS handoff_removed_side_task BEFORE INSERT ON handoff_tasks
          WHEN EXISTS(SELECT 1 FROM handoff_side_removals WHERE side_id IN (NEW.creator,NEW.assignee))
          BEGIN SELECT RAISE(ABORT,'Removed sides cannot send or receive tasks'); END;
        CREATE TRIGGER IF NOT EXISTS handoff_removed_side_event BEFORE INSERT ON handoff_task_events
          WHEN EXISTS(SELECT 1 FROM handoff_side_removals WHERE side_id=NEW.actor)
            OR EXISTS(SELECT 1 FROM handoff_tasks t JOIN handoff_side_removals r ON r.side_id IN (t.creator,t.assignee) WHERE t.id=NEW.task_id)
          BEGIN SELECT RAISE(ABORT,'Removed sides cannot change task history'); END;
        ${immutable("handoff_tasks")}
        ${immutable("handoff_task_events")}
        CREATE TRIGGER IF NOT EXISTS handoff_cancel_terminal_guard BEFORE INSERT ON handoff_task_events
          WHEN EXISTS(SELECT 1 FROM handoff_task_events WHERE task_id=NEW.task_id AND kind='cancel')
          BEGIN SELECT RAISE(ABORT, 'Cancelled tasks are terminal; create a new authorized task'); END;
        CREATE TRIGGER IF NOT EXISTS handoff_cancel_guard BEFORE INSERT ON handoff_task_events
          WHEN NEW.kind='cancel'
          BEGIN
            SELECT CASE WHEN NEW.actor<>(SELECT creator FROM handoff_tasks WHERE id=NEW.task_id)
              THEN RAISE(ABORT, 'Only the creator can cancel a task') END;
            SELECT CASE WHEN EXISTS(SELECT 1 FROM handoff_task_events WHERE task_id=NEW.task_id AND kind='close')
              THEN RAISE(ABORT, 'Cannot cancel a closed task') END;
            SELECT CASE WHEN EXISTS(SELECT 1 FROM handoff_integrations WHERE task_id=NEW.task_id AND state IN ('queued','running','pushed'))
              THEN RAISE(ABORT, 'Cannot cancel queued/running or pushed code') END;
          END;
      `);
      if (!(this.db.prepare("PRAGMA table_info(handoff_tasks)").all() as Array<{ name: string }>).some(column => column.name === "priority")) {
        this.db.exec("ALTER TABLE handoff_tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
      }
      this.transaction(() => {
        this.db.exec(`
          INSERT OR IGNORE INTO handoff_side_sessions(session_id,side_id,released_at)
            SELECT s.session_id,s.id,CASE WHEN EXISTS(SELECT 1 FROM handoff_side_bindings b WHERE b.side_id=s.id AND b.session_id=s.session_id) THEN NULL ELSE CURRENT_TIMESTAMP END FROM handoff_sides s;
          INSERT OR IGNORE INTO handoff_side_sessions(session_id,side_id,released_at) SELECT from_session,side_id,at FROM handoff_side_transfers;
          INSERT OR IGNORE INTO handoff_side_sessions(session_id,side_id,released_at) SELECT to_session,side_id,NULL FROM handoff_side_transfers;
        `);
      });
      this.initializeResume();
      this.transaction(() => { initializeWorkspaces(this.db); initializeIntegration(this.db); });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private initializeResume(): void {
    this.transaction(() => {
      const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff_resume_events'").get();
      const blockerEscalationExists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='handoff_resume_blocked'").get();
      const userRequestNotificationsExist = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff_user_request_notifications'").get();
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS handoff_resume_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          recipient TEXT NOT NULL REFERENCES handoff_sides(id),
          task_id INTEGER NOT NULL REFERENCES handoff_tasks(id),
          kind TEXT NOT NULL,
          source TEXT NOT NULL UNIQUE
        );
        CREATE INDEX IF NOT EXISTS handoff_resume_recipient ON handoff_resume_events(recipient,seq);
        CREATE TABLE IF NOT EXISTS handoff_resume_state (
          side_id TEXT PRIMARY KEY REFERENCES handoff_sides(id),
          ack_seq INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          reason TEXT,
          consumer TEXT,
          lease_until INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS handoff_user_request_notifications (
          task_id INTEGER NOT NULL REFERENCES handoff_tasks(id),
          block_seq INTEGER NOT NULL REFERENCES handoff_task_events(seq),
          side_id TEXT NOT NULL REFERENCES handoff_sides(id),
          delivered_at INTEGER,
          PRIMARY KEY(task_id,block_seq,side_id)
        );
        CREATE INDEX IF NOT EXISTS handoff_user_request_pending ON handoff_user_request_notifications(side_id,delivered_at,block_seq);
        DROP TRIGGER IF EXISTS handoff_resume_created;
        CREATE TRIGGER handoff_resume_created AFTER INSERT ON handoff_tasks
          WHEN NEW.creator<>NEW.assignee
          BEGIN INSERT INTO handoff_resume_events(recipient,task_id,kind,source)
            VALUES(NEW.assignee,NEW.id,'created','task:'||NEW.id); END;
        DROP TRIGGER IF EXISTS handoff_resume_changed;
        CREATE TRIGGER handoff_resume_changed AFTER INSERT ON handoff_task_events
          WHEN NEW.kind IN ('complete','reopen','close','cancel')
          BEGIN INSERT INTO handoff_resume_events(recipient,task_id,kind,source)
            SELECT CASE NEW.kind WHEN 'complete' THEN creator ELSE assignee END,
              NEW.task_id,NEW.kind,'event:'||NEW.seq FROM handoff_tasks WHERE id=NEW.task_id AND creator<>assignee; END;
        DROP TRIGGER IF EXISTS handoff_resume_priority;
        CREATE TRIGGER handoff_resume_priority AFTER INSERT ON handoff_task_events
          WHEN NEW.kind='priority'
          BEGIN INSERT INTO handoff_resume_events(recipient,task_id,kind,source)
            SELECT CASE WHEN NEW.actor=t.creator THEN t.assignee ELSE t.creator END,t.id,'priority','priority:'||NEW.seq
            FROM handoff_tasks t WHERE t.id=NEW.task_id AND t.creator<>t.assignee; END;
        DROP TRIGGER IF EXISTS handoff_resume_blocked;
        CREATE TRIGGER handoff_resume_blocked AFTER INSERT ON handoff_task_events
          WHEN NEW.kind='block' AND NOT EXISTS(
            SELECT 1 FROM handoff_task_events e WHERE e.task_id=NEW.task_id AND e.kind='block' AND e.seq<NEW.seq
              AND e.seq>COALESCE((SELECT MAX(seq) FROM handoff_task_events
                WHERE task_id=NEW.task_id AND kind IN ('unblock','complete','close','reopen','cancel') AND seq<NEW.seq),0))
          BEGIN INSERT INTO handoff_resume_events(recipient,task_id,kind,source)
            SELECT creator,NEW.task_id,'blocked','blocked:'||NEW.seq FROM handoff_tasks WHERE id=NEW.task_id AND creator<>assignee; END;
        ${immutable("handoff_resume_events")}
        CREATE TABLE IF NOT EXISTS handoff_task_dependencies (
          block_seq INTEGER NOT NULL REFERENCES handoff_task_events(seq),
          task_id INTEGER NOT NULL REFERENCES handoff_tasks(id),
          dependency_id INTEGER NOT NULL REFERENCES handoff_tasks(id),
          observed_seq INTEGER NOT NULL,
          PRIMARY KEY(block_seq, dependency_id)
        );
        CREATE INDEX IF NOT EXISTS handoff_dependency_target ON handoff_task_dependencies(dependency_id);
        ${immutable("handoff_task_dependencies")}
        CREATE TRIGGER IF NOT EXISTS handoff_dependency_index AFTER INSERT ON handoff_task_events
          WHEN NEW.kind='block'
          BEGIN INSERT INTO handoff_task_dependencies(block_seq,task_id,dependency_id,observed_seq)
            SELECT NEW.seq,NEW.task_id,json_extract(value,'$.id'),json_extract(value,'$.seq')
            FROM json_each(NEW.data_json,'$.dependencies'); END;
        CREATE UNIQUE INDEX IF NOT EXISTS handoff_reply_key ON handoff_task_events(task_id,actor,json_extract(data_json,'$.idempotencyKey')) WHERE kind='reply';
        DROP TRIGGER IF EXISTS handoff_resume_reply;
        CREATE TRIGGER handoff_resume_reply AFTER INSERT ON handoff_task_events
          WHEN NEW.kind='reply'
          BEGIN INSERT INTO handoff_resume_events(recipient,task_id,kind,source)
            SELECT CASE NEW.actor WHEN creator THEN assignee ELSE creator END,NEW.task_id,'reply','reply:'||NEW.seq
            FROM handoff_tasks WHERE id=NEW.task_id AND creator<>assignee; END;
        DROP TRIGGER IF EXISTS handoff_resume_dependency;
        CREATE TRIGGER handoff_resume_dependency AFTER INSERT ON handoff_task_events
          WHEN NEW.kind IN ('complete','reopen','close','cancel','reply')
          BEGIN INSERT INTO handoff_resume_events(recipient,task_id,kind,source)
            SELECT t.assignee,d.task_id,'dependency','dependency:'||NEW.seq||':'||d.block_seq
            FROM handoff_task_dependencies d JOIN handoff_tasks t ON t.id=d.task_id
            WHERE d.dependency_id=NEW.task_id AND NEW.seq>d.observed_seq
              AND d.block_seq=(SELECT seq FROM handoff_task_events WHERE task_id=d.task_id
                AND kind IN ('block','unblock','complete','close','reopen','cancel') ORDER BY seq DESC LIMIT 1); END;
      `);
      // Bootstrap old clients' records once. Triggers also cover writes by Pi
      // processes still running an earlier extension version.
      if (!exists) this.db.exec(`
        INSERT OR IGNORE INTO handoff_resume_events(recipient,task_id,kind,source)
          SELECT assignee,id,'created','task:'||id FROM handoff_tasks WHERE creator<>assignee;
        INSERT OR IGNORE INTO handoff_resume_events(recipient,task_id,kind,source)
          SELECT CASE e.kind WHEN 'complete' THEN t.creator ELSE t.assignee END,
            t.id,e.kind,'event:'||e.seq FROM handoff_task_events e JOIN handoff_tasks t ON t.id=e.task_id
            WHERE t.creator<>t.assignee AND e.kind IN ('complete','reopen','close','cancel') ORDER BY e.seq;
      `);
      // Notify creators of existing active blocker episodes once on upgrade.
      // Reopening the store or revising the reason must not repeat escalation.
      if (!blockerEscalationExists) this.db.exec(`
        INSERT OR IGNORE INTO handoff_resume_events(recipient,task_id,kind,source)
          SELECT t.creator,t.id,'blocked','blocked:'||e.seq FROM handoff_tasks t JOIN handoff_task_events e
            ON e.task_id=t.id AND e.kind='block'
          WHERE t.creator<>t.assignee AND e.seq=(SELECT MIN(seq) FROM handoff_task_events WHERE task_id=t.id AND kind='block'
            AND seq>COALESCE((SELECT MAX(seq) FROM handoff_task_events WHERE task_id=t.id
              AND kind IN ('unblock','complete','close','reopen','cancel')),0))
            AND (SELECT kind FROM handoff_task_events WHERE task_id=t.id
              AND kind IN ('block','unblock','complete','close','reopen','cancel') ORDER BY seq DESC LIMIT 1)='block';
      `);
      if (!userRequestNotificationsExist) {
        const userRequest = `(length(trim(COALESCE(json_extract(e.data_json,'$.userRequest'),''))) > 0
          OR lower(COALESCE(json_extract(e.data_json,'$.waitingFor'),'')) LIKE '%user%'
          OR COALESCE(json_extract(e.data_json,'$.waitingFor'),'') LIKE '%用户%'
          OR lower(COALESCE(json_extract(e.data_json,'$.waitingFor'),'')) LIKE '%manual test%'
          OR COALESCE(json_extract(e.data_json,'$.waitingFor'),'') LIKE '%人工测试%'
          OR COALESCE(json_extract(e.data_json,'$.waitingFor'),'') LIKE '%手工测试%')`;
        this.db.exec(`
          INSERT OR IGNORE INTO handoff_user_request_notifications(task_id,block_seq,side_id)
            SELECT t.id,e.seq,t.creator FROM handoff_tasks t JOIN handoff_task_events e ON e.task_id=t.id
            WHERE t.creator<>t.assignee AND e.kind='block' AND ${userRequest}
              AND e.seq=(SELECT seq FROM handoff_task_events WHERE task_id=t.id
                AND kind IN ('block','unblock','complete','close','reopen','cancel') ORDER BY seq DESC LIMIT 1)
            UNION ALL
            SELECT t.id,e.seq,t.assignee FROM handoff_tasks t JOIN handoff_task_events e ON e.task_id=t.id
            WHERE e.kind='block' AND ${userRequest}
              AND e.seq=(SELECT seq FROM handoff_task_events WHERE task_id=t.id
                AND kind IN ('block','unblock','complete','close','reopen','cancel') ORDER BY seq DESC LIMIT 1);
        `);
      }

    });
  }

  claimUserRequestNotification(sideId: string, taskId: number, blockSeq: number): HandoffTask | undefined {
    return this.transaction(() => {
      const task = this.read(taskId, sideId);
      if (task.state !== 'open' || !task.block?.userRequest || task.block.userRequestNeedsReview || task.events.findLast((event) => event.kind === 'block')?.seq !== blockSeq) return undefined;
      const delivered = this.db.prepare(`UPDATE handoff_user_request_notifications SET delivered_at=?
        WHERE task_id=? AND block_seq=? AND side_id=? AND delivered_at IS NULL`).run(Date.now(), taskId, blockSeq, sideId);
      return delivered.changes === 1 ? task : undefined;
    });
  }

  pendingUserRequestNotifications(sideId: string, limit = 50): Array<{ taskId: number; blockSeq: number }> {
    integer(limit, 'notification limit', 1);
    return this.db.prepare(`SELECT n.task_id,n.block_seq FROM handoff_user_request_notifications n
      JOIN handoff_tasks t ON t.id=n.task_id
      JOIN handoff_task_events e ON e.seq=n.block_seq
      WHERE n.side_id=? AND n.delivered_at IS NULL AND ${userActionEvidenceSql}
        AND n.block_seq=(SELECT seq FROM handoff_task_events WHERE task_id=t.id
          AND kind IN ('block','unblock','complete','close','reopen','cancel') ORDER BY seq DESC LIMIT 1)
      ORDER BY n.block_seq,n.task_id LIMIT ?`).all(sideId, limit).map((row) => ({ taskId: Number(row.task_id), blockSeq: Number(row.block_seq) }));
  }

  acquireResume(actor: string, sessionId: string, consumer: string, now = Date.now()): boolean {
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM handoff_side_removals WHERE side_id=?').get(actor)) return false;
      if (!this.db.prepare("SELECT 1 FROM handoff_sides WHERE id=? AND session_id=?").get(actor, sessionId)) return false;
      this.db.prepare("INSERT OR IGNORE INTO handoff_resume_state(side_id) VALUES(?)").run(actor);
      return this.db.prepare(`UPDATE handoff_resume_state SET consumer=?,lease_until=? WHERE side_id=? AND enabled=1
        AND (consumer IS NULL OR consumer=? OR lease_until<=?)`).run(consumer, now + 15000, actor, consumer, now).changes === 1;
    });
  }

  private replyNeedsAction(id: number, actor: string, fromSeq = 0): boolean {
    return !!this.db.prepare(`SELECT 1 FROM handoff_task_events incoming
      WHERE incoming.task_id=? AND incoming.kind='reply' AND incoming.actor<>? AND incoming.seq>=?
        AND NOT EXISTS(SELECT 1 FROM handoff_task_events response WHERE response.task_id=incoming.task_id
          AND response.actor=? AND response.seq>incoming.seq
          AND (response.kind<>'reply' OR json_extract(response.data_json,'$.inReplyTo')>=incoming.seq)) LIMIT 1`).get(id, actor, fromSeq, actor);
  }

  reconcileResume(actor: string, consumer: string): { queued: number[]; stalled: number[] } {
    return this.transaction(() => {
      const queued: number[] = [], stalled: number[] = [];
      if (!this.db.prepare("SELECT 1 FROM handoff_resume_state WHERE side_id=? AND consumer=? AND enabled=1").get(actor, consumer)) return { queued, stalled };
      let before: number | undefined;
      do {
        const page = this.list(actor, { activeOnly: true, limit: 100, before });
        for (const task of page.tasks) {
          const needsWork = task.assignee.id === actor && task.state === "open" && (!task.block || task.block.needsReview)
            || task.creator.id === actor && task.state === "completed" && task.integration?.state !== "queued" && task.integration?.state !== "running"
            || task.creator.id === actor && task.state === 'open' && !!task.block?.userRequestNeedsReview
            || !!task.lastReply && this.replyNeedsAction(task.id, actor);
          if (!needsWork) continue;
          const ids = [task.id, ...(task.block?.dependencies ?? [])];
          const version = Number(this.db.prepare(
            "SELECT COALESCE(MAX(seq),0) AS seq FROM handoff_task_events WHERE task_id IN (" + ids.map(() => "?").join(",") + ")",
          ).get(...ids)!.seq);
          // Queue only from the upgraded side's own consumer. An older peer
          // must not consume/discard this review before it has loaded the rule.
          const source = task.block?.userRequestNeedsReview
            ? `user-action-review:${this.db.prepare("SELECT MAX(seq) AS seq FROM handoff_task_events WHERE task_id=? AND kind='block'").get(task.id)!.seq}:${actor}`
            : "checkpoint:" + actor + ":" + task.id + ":" + version;
          const added = this.db.prepare("INSERT OR IGNORE INTO handoff_resume_events(recipient,task_id,kind,source) VALUES(?,?,'checkpoint',?)")
            .run(actor, task.id, source).changes;
          (added ? queued : stalled).push(task.id);
        }
        before = page.nextBefore ?? undefined;
      } while (before !== undefined);
      return { queued, stalled };
    });
  }

  pendingResume(actor: string, consumer: string): ResumeBatch | null {
    const state = this.db.prepare("SELECT ack_seq FROM handoff_resume_state WHERE side_id=? AND consumer=? AND enabled=1").get(actor, consumer);
    if (!state) return null;
    const rows = this.db.prepare(`SELECT r.seq,r.task_id,r.kind,r.source,
      (SELECT kind FROM handoff_task_events WHERE task_id=r.task_id AND kind IN ('complete','reopen','close','cancel') ORDER BY seq DESC LIMIT 1) AS current_kind,
      (SELECT seq FROM handoff_task_events WHERE task_id=r.task_id AND kind IN ('complete','reopen','close','cancel') ORDER BY seq DESC LIMIT 1) AS current_seq,
      (SELECT seq FROM handoff_task_events WHERE task_id=r.task_id AND kind='priority' ORDER BY seq DESC LIMIT 1) AS current_priority_seq
      FROM handoff_resume_events r WHERE recipient=? AND seq>? ORDER BY seq LIMIT 100`).all(actor, Number(state.ack_seq));
    if (!rows.length) return null;
    let hasWork: boolean | undefined;
    const events = new Map<number, ResumeEvent>();
    for (const row of rows) {
      const kind = row.kind as ResumeEvent["kind"];
      let relevant = kind === "complete" || kind === "integration" ? row.current_kind === "complete"
        : kind === "close" || kind === "cancel" ? row.current_kind === kind : row.current_kind === null || row.current_kind === "reopen";
      if (kind === "priority") relevant = row.source === `priority:${row.current_priority_seq}`;
      if (String(row.source).startsWith("task:") && row.current_seq !== null) relevant = false;
      if (String(row.source).startsWith("event:") && row.source !== `event:${row.current_seq}`) relevant = false;
      if (relevant && kind === "close") {
        // Acceptance can unblock other work, but never wake solely to admire a
        // closed task when this side has nothing left to execute or review.
        hasWork ??= !!this.db.prepare(`SELECT 1 FROM handoff_tasks t WHERE
          (assignee=? AND COALESCE((SELECT kind FROM handoff_task_events WHERE task_id=t.id AND kind IN ('complete','close','reopen','cancel') ORDER BY seq DESC LIMIT 1),'reopen')='reopen')
          OR (creator=? AND (SELECT kind FROM handoff_task_events WHERE task_id=t.id AND kind IN ('complete','close','reopen','cancel') ORDER BY seq DESC LIMIT 1)='complete') LIMIT 1`).get(actor, actor);
        relevant = hasWork;
      }
      if (relevant && kind === "dependency") {
        // Only a dependency of the current blocking record can request recheck.
        relevant = !!this.db.prepare(`SELECT 1 FROM handoff_task_dependencies d
          WHERE d.task_id=? AND ? LIKE 'dependency:%:'||d.block_seq
            AND d.block_seq=(SELECT seq FROM handoff_task_events WHERE task_id=d.task_id
              AND kind IN ('block','unblock','complete','close','reopen','cancel') ORDER BY seq DESC LIMIT 1)`).get(row.task_id, row.source);
      }
      if (kind === "reply") {
        const task = this.read(Number(row.task_id), actor);
        relevant = (task.state !== "closed" && task.state !== "cancelled") && this.replyNeedsAction(task.id, actor, Number(String(row.source).slice("reply:".length)));
      }
      if (kind === "checkpoint") {
        const task = this.read(Number(row.task_id), actor);
        relevant = String(row.source).startsWith('user-action-review:')
          ? task.state === 'open' && !!task.block?.userRequestNeedsReview
            && row.source === `user-action-review:${task.events.findLast(e => e.kind === 'block')?.seq}:${actor}`
          : task.assignee.id === actor && task.state === "open" && (!task.block || task.block.needsReview)
          || task.creator.id === actor && task.state === "completed" && task.integration?.state !== "queued" && task.integration?.state !== "running"
          || (task.state !== "closed" && task.state !== "cancelled") && !!task.lastReply && this.replyNeedsAction(task.id, actor);
      }
      if (kind === "blocked") {
        const task = this.read(Number(row.task_id), actor);
        const after = task.events.findLast((event) => ["unblock", "complete", "close", "reopen"].includes(event.kind))?.seq ?? 0;
        const episode = task.events.find((event) => event.kind === "block" && event.seq > after);
        relevant = task.creator.id === actor && task.state === "open" && task.block !== null && row.source === `blocked:${episode?.seq}`;
      }
      if (relevant && (kind === "complete" || kind === "integration")) {
        const task = this.read(Number(row.task_id), actor);
        if (task.integration?.state === "queued" || task.integration?.state === "running") relevant = false;
        if (kind === "integration" && row.source !== `integration:${task.events.findLast(event => event.kind === "integration")?.seq}`) relevant = false;
      }
      if (relevant && (kind === "created" || kind === "reopen")) {
        const task = this.read(Number(row.task_id), actor);
        if (task.block && !task.block.needsReview) relevant = false;
      }
      if (row.current_kind === "cancel" && kind !== "cancel") relevant = false;
      if (relevant) events.set(Number(row.task_id), { seq: Number(row.seq), taskId: Number(row.task_id), kind });
    }
    return { throughSeq: Number(rows.at(-1)!.seq), events: [...events.values()] };
  }

  acknowledgeResume(actor: string, consumer: string, throughSeq: number): void {
    integer(throughSeq, "resume cursor", 0);
    const max = Number(this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM handoff_resume_events WHERE recipient=?").get(actor)!.seq);
    if (throughSeq > max) throw new Error("Invalid resume cursor");
    this.db.prepare("UPDATE handoff_resume_state SET ack_seq=MAX(ack_seq,?) WHERE side_id=? AND consumer=?")
      .run(throughSeq, actor, consumer);
  }

  releaseResume(actor: string, consumer: string): void {
    this.db.prepare("UPDATE handoff_resume_state SET consumer=NULL,lease_until=0 WHERE side_id=? AND consumer=?").run(actor, consumer);
  }

  setResumeEnabled(actor: string, enabled: boolean, reason: string | null = null): void {
    this.transaction(() => {
      if (enabled && this.db.prepare('SELECT 1 FROM handoff_side_removals WHERE side_id=?').get(actor)) throw new Error('Side was removed; start a new Pi session to join again');
      const previous = this.db.prepare("SELECT enabled FROM handoff_resume_state WHERE side_id=?").get(actor);
      this.db.prepare(`INSERT INTO handoff_resume_state(side_id,enabled,reason) VALUES(?,?,?)
        ON CONFLICT(side_id) DO UPDATE SET enabled=excluded.enabled,reason=excluded.reason`).run(actor, Number(enabled), reason);
      if (enabled && previous?.enabled === 0) {
        // Explicit user recovery should also retry delivered-but-failed work.
        // Repeated 'on' while enabled creates no new events or model loop.
        const source = `retry:${randomUUID()}:`;
        this.db.prepare(`INSERT INTO handoff_resume_events(recipient,task_id,kind,source)
          SELECT ?,t.id,CASE WHEN t.assignee=? THEN 'created' ELSE 'complete' END,?||t.id FROM handoff_tasks t
          WHERE (t.assignee=? AND COALESCE((SELECT kind FROM handoff_task_events WHERE task_id=t.id AND kind IN ('complete','close','reopen','cancel') ORDER BY seq DESC LIMIT 1),'reopen')='reopen')
            OR (t.creator=? AND (SELECT kind FROM handoff_task_events WHERE task_id=t.id AND kind IN ('complete','close','reopen','cancel') ORDER BY seq DESC LIMIT 1)='complete')`)
          .run(actor, actor, source, actor, actor);
      }
    });
  }

  resumeStatus(actor: string): Record<string, unknown> {
    const state = this.db.prepare("SELECT enabled,ack_seq,reason FROM handoff_resume_state WHERE side_id=?").get(actor);
    const ackSeq = Number(state?.ack_seq ?? 0);
    return { enabled: state ? !!state.enabled : true, ackSeq, reason: state?.reason ?? null,
      pendingEvents: Number(this.db.prepare("SELECT COUNT(*) AS total FROM handoff_resume_events WHERE recipient=? AND seq>?").get(actor, ackSeq)!.total) };
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  register(side: Side): void {
    this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM handoff_side_removals WHERE side_id=?").get(side.id)) throw new Error("Side was removed; it cannot register again");
      const bound = this.sessionSide(side.sessionId);
      const historical = this.historicalSessionSide(side.sessionId);
      if (historical && historical.id !== side.id) throw new Error("Session belongs to another historical side; use its inherited identity");
      if (bound && bound.id !== side.id) throw new Error("Session is bound to another side; use its inherited identity");
      this.db.prepare(`INSERT INTO handoff_sides(id,name,session_id,pid,worktree,branch) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,session_id=excluded.session_id,
        pid=excluded.pid,worktree=excluded.worktree,branch=excluded.branch`).run(
          side.id, side.name, side.sessionId, side.pid, side.worktree, side.branch,
        );
      this.db.prepare(`INSERT INTO handoff_side_bindings(side_id,session_id) VALUES(?,?)
        ON CONFLICT(side_id) DO UPDATE SET session_id=excluded.session_id`).run(side.id, side.sessionId);
      this.db.prepare(`INSERT INTO handoff_side_sessions(session_id,side_id,released_at) VALUES(?,?,NULL)
        ON CONFLICT(session_id) DO UPDATE SET released_at=NULL WHERE side_id=excluded.side_id`).run(side.sessionId, side.id);
    });
  }

  release(side: Side): void {
    this.transaction(() => {
      this.db.prepare("UPDATE handoff_side_bindings SET session_id=NULL WHERE side_id=? AND session_id=?").run(side.id, side.sessionId);
      this.db.prepare("UPDATE handoff_side_sessions SET released_at=? WHERE side_id=? AND session_id=?").run(new Date().toISOString(), side.id, side.sessionId);
    });
  }

  sessionSide(sessionId: string): Side | undefined {
    const binding = this.db.prepare("SELECT side_id FROM handoff_side_bindings WHERE session_id=? AND session_id IS NOT NULL").get(sessionId);
    if (binding) return this.sideById(String(binding.side_id));
    if (this.db.prepare("SELECT 1 FROM handoff_side_transfers WHERE from_session=? LIMIT 1").get(sessionId)) {
      throw new Error("This session was replaced by a CoWork takeover. It cannot reclaim the old side.");
    }
    const mapping = this.db.prepare("SELECT side_id,released_at FROM handoff_side_sessions WHERE session_id=?").get(sessionId) as { side_id: string; released_at: string | null } | undefined;
    if (mapping?.released_at) {
      const released = this.sideById(mapping.side_id, true);
      return released?.removedAt ? released : undefined;
    }
    if (mapping) return this.sideById(mapping.side_id, true);
    const legacy = this.db.prepare("SELECT id FROM handoff_sides WHERE session_id=?").get(sessionId);
    return legacy ? this.sideById(String(legacy.id), true) : undefined;
  }

  historicalSessionSide(sessionId: string): Side | undefined {
    const mapping = this.db.prepare("SELECT side_id FROM handoff_side_sessions WHERE session_id=?").get(sessionId) as { side_id: string } | undefined;
    return mapping ? this.sideById(mapping.side_id, true) : undefined;
  }

  takeover(actor: Side, targetId: string, expectedSessionId: string, reason: string): Side {
    text(targetId, "Target side id", 256);
    text(expectedSessionId, "Expected session id", 256);
    text(reason, "Takeover reason", 2000);
    return this.transaction(() => {
      const current = this.currentSides().find((side) => side.id === actor.id);
      const target = this.sideById(targetId);
      if (!current || current.sessionId !== actor.sessionId) throw new Error("Current side ownership has changed");
      if (!target) throw new Error("Target side not found; use an id from cowork_sides");
      if (target.id === actor.id) return current;
      if (target.sessionId !== expectedSessionId) throw new Error("Target ownership changed; read cowork_sides again before taking over");
      if (this.db.prepare("SELECT 1 FROM handoff_tasks WHERE creator=? OR assignee=? LIMIT 1").get(actor.id, actor.id)) {
        throw new Error("Current side already owns tasks. Start a fresh Pi session to take over without losing its access.");
      }
      try {
        process.kill(target.pid, 0);
        throw new Error(`Old side process ${target.pid} is still running; stop it before taking over`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const at = new Date().toISOString();
      this.db.prepare("UPDATE handoff_side_sessions SET released_at=? WHERE side_id=? AND session_id=?").run(at, actor.id, actor.sessionId);
      this.db.prepare("INSERT INTO handoff_side_sessions(session_id,side_id,released_at) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET released_at=excluded.released_at").run(target.sessionId,target.id,at);
      this.db.prepare("INSERT INTO handoff_side_sessions(session_id,side_id,released_at) VALUES(?,?,NULL) ON CONFLICT(session_id) DO UPDATE SET side_id=excluded.side_id,released_at=NULL").run(actor.sessionId,target.id);
      this.db.prepare("INSERT INTO handoff_side_bindings(side_id,session_id) VALUES(?,NULL) ON CONFLICT(side_id) DO UPDATE SET session_id=NULL").run(actor.id);
      this.db.prepare("INSERT INTO handoff_side_bindings(side_id,session_id) VALUES(?,?) ON CONFLICT(side_id) DO UPDATE SET session_id=excluded.session_id").run(target.id, actor.sessionId);
      this.db.prepare("UPDATE handoff_sides SET session_id=?,pid=?,worktree=?,branch=? WHERE id=?").run(actor.sessionId, actor.pid, actor.worktree, actor.branch, target.id);
      this.db.prepare("UPDATE handoff_side_sessions SET released_at=? WHERE side_id=? AND session_id=?").run(at,target.id,target.sessionId);
      this.db.prepare("INSERT INTO handoff_side_transfers(side_id,from_session,to_session,actor_side,reason,at) VALUES(?,?,?,?,?,?)").run(target.id, target.sessionId, actor.sessionId, actor.id, reason, at);
      return { ...actor, id: target.id, name: target.name };
    });
  }

  removeSide(actor: Side, targetId: string, expectedSessionId: string, reason: string): Side {
    text(targetId, 'Side id', 256); text(expectedSessionId, 'Expected session id', 256); text(reason, 'Removal reason', 2000);
    return this.transaction(() => {
      const current = this.currentSides().find(side => side.id === actor.id);
      if (!current || current.sessionId !== actor.sessionId) throw new Error('Current side ownership has changed');
      const target = this.sideById(targetId);
      if (!target) throw new Error('Side not found; read cowork_sides again');
      if (target.sessionId !== expectedSessionId) throw new Error('Side ownership changed; read cowork_sides again');
      if (this.list(target.id, { activeOnly: true, limit: 1 }).tasks.length) throw new Error('Side still has unclosed sent or received tasks; finish their review first');
      if (this.db.prepare("SELECT 1 FROM handoff_workspaces WHERE owner=? AND state='active' LIMIT 1").get(target.id)) throw new Error('Side still owns an active workspace; reconcile and safely retire it before removing the side');
      const state = this.db.prepare('SELECT enabled,consumer,lease_until FROM handoff_resume_state WHERE side_id=?').get(target.id);
      if (target.id === actor.id) {
        if (target.pid !== actor.pid || target.pid !== process.pid) throw new Error('Current side is being used by another process');
        if (!state || state.enabled) throw new Error('Pause this side with /cowork auto off before removing it');
      } else {
        try { process.kill(target.pid, 0); throw new Error('Side process is still running; stop it or remove the current side from its own Pi'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      if (state?.consumer && Number(state.lease_until) > Date.now()) throw new Error('Side still has a resume consumer; wait for it to stop before removal');
      const at = new Date().toISOString();
      this.db.prepare('INSERT INTO handoff_side_removals(side_id,session_id,actor,reason,at) VALUES(?,?,?,?,?)').run(target.id, target.sessionId, actor.id, reason, at);
      this.db.prepare("UPDATE handoff_side_bindings SET session_id=NULL WHERE side_id=?").run(target.id);
      this.db.prepare("UPDATE handoff_side_sessions SET released_at=? WHERE side_id=? AND session_id=?").run(at,target.id,target.sessionId);
      this.db.prepare("INSERT INTO handoff_resume_state(side_id,enabled,reason) VALUES(?,0,?) ON CONFLICT(side_id) DO UPDATE SET enabled=0,consumer=NULL,lease_until=0,reason=excluded.reason").run(target.id, 'Side removed');
      return { ...target, removedAt: at };
    });
  }

  private sideById(id: string, includeRemoved = false): Side | undefined {
    const row = this.db.prepare(`SELECT s.*,r.at AS removed_at FROM handoff_sides s
      LEFT JOIN handoff_side_removals r ON r.side_id=s.id WHERE s.id=? AND (? OR r.side_id IS NULL)`).get(id, Number(includeRemoved)) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { id: String(row.id), name: String(row.name), sessionId: String(row.session_id), pid: Number(row.pid), worktree: String(row.worktree), branch: String(row.branch), ...(row.removed_at ? { removedAt: String(row.removed_at) } : {}) };
  }

  private currentSides(): Side[] {
    return this.db.prepare(`SELECT s.* FROM handoff_sides s WHERE EXISTS(
      SELECT 1 FROM handoff_side_bindings b WHERE b.side_id=s.id AND b.session_id IS NOT NULL
    ) AND NOT EXISTS(SELECT 1 FROM handoff_side_removals r WHERE r.side_id=s.id) ORDER BY s.name,s.id`).all().map((row) => ({
      id: String(row.id), name: String(row.name), sessionId: String(row.session_id), pid: Number(row.pid), worktree: String(row.worktree), branch: String(row.branch),
    }));
  }

  private allSides(includeRemoved = false): Side[] {
    return this.db.prepare(`SELECT s.*,r.at AS removed_at FROM handoff_sides s LEFT JOIN handoff_side_removals r ON r.side_id=s.id
      WHERE (? OR r.side_id IS NULL) ORDER BY name,id`).all(Number(includeRemoved)).map((row) => ({
        id: String(row.id), name: String(row.name), sessionId: String(row.session_id), pid: Number(row.pid), worktree: String(row.worktree), branch: String(row.branch),
        ...(row.removed_at ? { removedAt: String(row.removed_at) } : {}),
      }));
  }

  sides(includeRemoved = false): Side[] {
    return this.db.prepare(`SELECT s.*,r.at AS removed_at FROM handoff_sides s LEFT JOIN handoff_side_removals r ON r.side_id=s.id WHERE (? OR r.side_id IS NULL) AND EXISTS(
      SELECT 1 FROM handoff_side_bindings b WHERE b.side_id=s.id AND b.session_id IS NOT NULL
    ) ORDER BY name,id`).all(Number(includeRemoved)).map((row) => ({
      id: String(row.id), name: String(row.name), sessionId: String(row.session_id), pid: Number(row.pid), worktree: String(row.worktree), branch: String(row.branch),
      ...(row.removed_at ? { removedAt: String(row.removed_at) } : {}),
    }));
  }

  sideForHumanUi(id: string) {
    const side = this.sideById(id);
    if (!side) throw new Error('Side not found; refresh the side directory');
    const openTasks = Number(this.db.prepare(`SELECT COUNT(*) AS total FROM handoff_tasks t
      WHERE (creator=? OR assignee=?) AND COALESCE((SELECT kind FROM handoff_task_events
        WHERE task_id=t.id AND kind IN ('complete','close','reopen','cancel') ORDER BY seq DESC LIMIT 1),'reopen') NOT IN ('close','cancel')`).get(id, id)!.total);
    const workspaces = Number(this.db.prepare("SELECT COUNT(*) AS total FROM handoff_workspaces WHERE owner=? AND state='active'").get(id)!.total);
    return { side, openTasks, workspaces, autoResume: this.resumeStatus(id) };
  }

  sidePage(options: SidePageOptions = {}): SidePage {
    const limit = options.limit === undefined ? 30 : integer(options.limit, 'limit', 1);
    if (limit > 100) throw new Error('Limit must not exceed 100');
    const after = options.after === undefined ? '' : text(options.after, 'after', 256);
    const query = options.query === undefined ? '' : text(options.query, 'query', 256);
    const scope = options.scope ?? 'current';
    const scopeSql = scope === 'current'
      ? 'AND EXISTS(SELECT 1 FROM handoff_side_bindings cb WHERE cb.side_id=s.id AND cb.session_id IS NOT NULL)'
      : scope === 'history'
        ? 'AND NOT EXISTS(SELECT 1 FROM handoff_side_bindings hb WHERE hb.side_id=s.id AND hb.session_id IS NOT NULL)'
        : '';
    const base = `FROM handoff_sides s WHERE s.id>? ${scopeSql}
      AND NOT EXISTS(SELECT 1 FROM handoff_side_removals r WHERE r.side_id=s.id)
      AND (instr(lower(s.name),lower(?))>0 OR instr(lower(s.id),lower(?))>0)`;
    const rows = this.db.prepare(`SELECT s.* ${base} ORDER BY s.id LIMIT ?`).all(after, query, query, limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const sides = rows.map(row => ({ id: String(row.id), name: String(row.name), sessionId: String(row.session_id), pid: Number(row.pid), worktree: String(row.worktree), branch: String(row.branch) }));
    const counts = this.db.prepare(`SELECT COUNT(*) AS total ${base}`).get('', query, query)!;
    return { sides, nextAfter: hasMore ? sides.at(-1)!.id : null, total: Number(counts.total), matched: Number(counts.total) };
  }

  create(input: CreateInput, actor: string): HandoffTask {
    const to = input.to === undefined ? actor : text(input.to, "Assignee", 256);
    const subject = text(input.subject, "Subject", 160);
    const taskPriority = priority(input.priority ?? "normal");
    const body = text(input.body, "Body", 16000);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) throw new Error("Provide 1-50 checklist items");
    const items = input.items.map((item) => text(item, "Checklist item", 1000));
    if (input.refs !== undefined && (!Array.isArray(input.refs) || input.refs.length > 20)) throw new Error("At most 20 references are allowed");
    const refs = (input.refs ?? []).map((ref) => text(ref, "Reference", 512));
    if (input.requiresIntegration !== undefined && typeof input.requiresIntegration !== "boolean") throw new Error("requiresIntegration must be boolean");
    const requiresIntegration = input.requiresIntegration ?? false;
    const key = input.idempotencyKey === undefined ? null : text(input.idempotencyKey, "Idempotency key", 160);
    return this.transaction(() => {
      const matches = this.currentSides().filter((side) => side.id === to || side.name === to);
      if (matches.length !== 1) throw new Error("Assignee not found or name is ambiguous; use an id from cowork_sides");
      const assignee = matches[0].id;
      const hash = createHash("sha256").update(JSON.stringify({ assignee, subject, ...(taskPriority !== 'normal' ? { priority: taskPriority } : {}), body, items, refs, ...(requiresIntegration ? { requiresIntegration } : {}) })).digest("hex");
      if (key !== null) {
        const existing = this.db.prepare("SELECT id,payload_hash FROM handoff_tasks WHERE creator=? AND idempotency_key=?").get(actor, key);
        if (existing) {
          if (existing.payload_hash !== hash) throw new Error("Idempotency key is already bound to different content");
          return this.read(Number(existing.id), actor);
        }
      }
      const result = this.db.prepare(`INSERT INTO handoff_tasks(
        creator,assignee,subject,priority,body,items_json,refs_json,created_at,idempotency_key,payload_hash,requires_integration
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(actor, assignee, subject, taskPriority, body, JSON.stringify(items), JSON.stringify(refs), new Date().toISOString(), key, hash, Number(requiresIntegration));
      return this.read(Number(result.lastInsertRowid), actor);
    });
  }

  read(id: number, actor: string): HandoffTask {
    integer(id, "task id", 1);
    const row = this.db.prepare("SELECT * FROM handoff_tasks WHERE id=? AND (creator=? OR assignee=?)").get(id, actor, actor);
    if (!row) throw new Error("Task not found or not visible to this side");
    return this.taskFromRow(row);
  }

  private taskFromRow(row: Record<string, unknown>, sides = this.allSides(true), eventSeq = Number.MAX_SAFE_INTEGER): HandoffTask {
    const task: HandoffTask = {
      id: Number(row.id), kind: row.creator === row.assignee ? "local" : "handoff", creator: sides.find((side) => side.id === row.creator)!,
      assignee: sides.find((side) => side.id === row.assignee)!, subject: String(row.subject), priority: priority(row.priority ?? 'normal'), body: String(row.body),
      refs: JSON.parse(String(row.refs_json)), items: (JSON.parse(String(row.items_json)) as string[]).map((value) => ({ text: value, checked: false })),
      state: "open", block: null, commit: null, summary: null, reviewNote: null, requiresIntegration: !!row.requires_integration, integration: null, createdAt: String(row.created_at),
      events: this.db.prepare("SELECT * FROM handoff_task_events WHERE task_id=? AND seq<=? ORDER BY seq").all(Number(row.id), eventSeq).map((event) => ({
        seq: Number(event.seq), actor: String(event.actor), kind: String(event.kind) as TaskEvent["kind"], data: JSON.parse(String(event.data_json)), at: String(event.at),
      })),
    };
    let blockSeq = 0;
    for (const event of task.events) {
      if (event.kind === "check") task.items[Number(event.data.item) - 1].checked = event.data.checked === true;
      if (event.kind === "block") {
        blockSeq = event.seq;
        const waitingFor = String(event.data.waitingFor);
        const userRequest = typeof event.data.userRequest === "string" && event.data.userRequest.trim()
          ? event.data.userRequest : isUserWaiting(waitingFor) ? String(event.data.reason) : undefined;
        let userAction: UserAction | undefined;
        if (userRequest) {
          try { validateUserRequest(event.data.userRequest, event.data.userAction as UserAction | undefined); userAction = event.data.userAction as UserAction; }
          catch { /* Keep legacy evidence, send it back to Agents for review. */ }
        }
        task.block = {
          reason: String(event.data.reason), waitingFor, ...(userRequest ? { userRequest, ...(userAction ? { userAction } : { userRequestNeedsReview: true }) } : {}),
          dependencies: (event.data.dependencies as { id: number }[]).map((dependency) => dependency.id),
          needsReview: false,
        };
      }
      if (event.kind === "priority") task.priority = priority(event.data.priority);
      if (event.kind === "reply") task.lastReply = { seq: event.seq, actor: event.actor, at: event.at, ...(event.data.inReplyTo ? { inReplyTo: Number(event.data.inReplyTo) } : {}) };
      if (event.kind === "unblock") task.block = null;
      if (event.kind === "complete") {
        task.block = null;
        task.deliveryId = event.data.deliveryId ? String(event.data.deliveryId) : undefined;
        task.state = "completed"; task.commit = String(event.data.commit); task.summary = String(event.data.summary);
      }
      if (event.kind === "close") { task.state = "closed"; task.reviewNote = String(event.data.note); }
      if (event.kind === "cancel") { task.state = "cancelled"; task.block = null; task.cancellation = { actor: event.actor, reason: String(event.data.reason), at: event.at }; }
      if (event.kind === "integration") { task.integration = event.data as unknown as HandoffTask["integration"]; task.requiresIntegration = true; }
      if (event.kind === "reopen") {
        task.integration = null; task.deliveryId = undefined;
        task.state = "open"; task.block = null; task.commit = null; task.summary = null; task.reviewNote = null;
        task.items.forEach((item) => { item.checked = false; });
      }
    }
    if (task.deliveryId) {
      const d = this.db.prepare('SELECT * FROM handoff_deliveries WHERE id=?').get(task.deliveryId);
      if (!d) throw new Error('Delivery snapshot is missing; preserve the task for reconciliation');
      task.delivery = { id: String(d.id), workspaceId: String(d.workspace_id), base: String(d.base), tip: String(d.tip), tree: String(d.tree), commits: JSON.parse(String(d.commits_json)), files: JSON.parse(String(d.files_json)), digest: String(d.digest) };
    }
    if (task.block) task.block.needsReview = !!task.block.userRequestNeedsReview || !!this.db.prepare(`SELECT 1 FROM handoff_task_dependencies d
      JOIN handoff_task_events e ON e.task_id=d.dependency_id
      WHERE d.block_seq=? AND e.seq>d.observed_seq AND e.seq<=?
        AND e.kind IN ('complete','close','reopen','cancel','reply') LIMIT 1`).get(blockSeq, eventSeq)
      || !!this.db.prepare(`SELECT 1 FROM handoff_task_events WHERE task_id=? AND kind='reply' AND actor=? AND seq>? AND seq<=? LIMIT 1`)
        .get(task.id, task.creator.id, blockSeq, eventSeq);
    return task;
  }

  list(actor: string, options: { before?: number; limit?: number; activeOnly?: boolean } = {}): { tasks: TaskSummary[]; nextBefore: number | null } {
    const limit = options.limit === undefined ? 30 : integer(options.limit, "limit", 1);
    if (limit > 100) throw new Error("Limit must not exceed 100");
    const before = options.before === undefined ? Number.MAX_SAFE_INTEGER : integer(options.before, "before", 1);
    const rows = this.db.prepare(`SELECT id FROM handoff_tasks WHERE (creator=? OR assignee=?) AND id<?
      ORDER BY id DESC`).all(actor, actor, before);
    const tasks: TaskSummary[] = [];
    for (const row of rows) {
      const { body: _body, events: _events, ...task } = this.read(Number(row.id), actor);
      if (options.activeOnly && (task.state === "closed" || task.state === "cancelled")) continue;
      tasks.push(task);
      if (tasks.length > limit) break;
    }
    const hasMore = tasks.length > limit;
    if (hasMore) tasks.pop();
    return { tasks, nextBefore: hasMore ? tasks.at(-1)!.id : null };
  }

  // Human-only TUI data: never expose this project-wide query as an agent tool.
  listForHumanUi(options: { actor?: string; after?: number; limit?: number; sort?: "id" | "pending" | "reviewed"; snapshot?: HumanTaskSnapshot } = {}): { tasks: HandoffTask[]; nextAfter: number | null; snapshot: HumanTaskSnapshot } {
    const limit = options.limit === undefined ? 30 : integer(options.limit, "limit", 1);
    if (limit > 100) throw new Error("Limit must not exceed 100");
    const after = options.after === undefined ? 0 : integer(options.after, "after", 0);
    let snapshot = options.snapshot;
    if (!snapshot) {
      // Capture only order and event watermark. Immutable task/event records let later
      // pages render the same view while other processes complete or return tasks.
      this.db.exec("BEGIN");
      try {
        const eventSeq = Number(this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM handoff_task_events").get()!.seq);
        const priorityAtSnapshot = "COALESCE((SELECT json_extract(p.data_json,'$.priority') FROM handoff_task_events p WHERE p.task_id=t.id AND p.kind='priority' AND p.seq<=? ORDER BY p.seq DESC LIMIT 1),t.priority)";
        const priorityRank = `CASE ${priorityAtSnapshot} WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END`;
        const userRequestAtSnapshot = `CASE WHEN e.kind='block' AND ${userActionEvidenceSql} THEN 1 ELSE 0 END`;
        const order = options.sort === "pending"
          ? "user_request_rank DESC, state_rank ASC, priority_rank DESC, id ASC"
          : options.sort === "reviewed"
            ? "user_request_rank DESC, state_rank DESC, priority_rank DESC, id ASC"
            : "user_request_rank DESC, priority_rank DESC, id ASC";
        const rows = this.db.prepare(`SELECT t.id, ${priorityRank} AS priority_rank, ${userRequestAtSnapshot} AS user_request_rank, CASE e.kind
          WHEN 'close' THEN 3 WHEN 'cancel' THEN 3 WHEN 'complete' THEN 1 WHEN 'block' THEN
            CASE WHEN (NOT COALESCE(${userActionEvidenceSql},0) AND (
              length(trim(COALESCE(json_extract(e.data_json,'$.userRequest'),'')))>0
              OR lower(COALESCE(json_extract(e.data_json,'$.waitingFor'),'')) LIKE '%user%'
              OR COALESCE(json_extract(e.data_json,'$.waitingFor'),'') LIKE '%用户%'
              OR lower(COALESCE(json_extract(e.data_json,'$.waitingFor'),'')) LIKE '%manual test%'
              OR COALESCE(json_extract(e.data_json,'$.waitingFor'),'') LIKE '%人工测试%'
              OR COALESCE(json_extract(e.data_json,'$.waitingFor'),'') LIKE '%手工测试%')) OR EXISTS(SELECT 1 FROM handoff_task_dependencies d
              JOIN handoff_task_events changed ON changed.task_id=d.dependency_id
              WHERE d.block_seq=e.seq AND changed.seq>d.observed_seq AND changed.seq<=?
                AND changed.kind IN ('complete','close','reopen','cancel')) THEN 0 ELSE 2 END
          ELSE 0 END AS state_rank
        FROM handoff_tasks t LEFT JOIN handoff_task_events e ON e.seq=(
          SELECT seq FROM handoff_task_events WHERE task_id=t.id AND seq<=?
            AND kind IN ('block','unblock','complete','close','reopen','cancel') ORDER BY seq DESC LIMIT 1)
        ${options.actor === undefined ? "" : "WHERE creator=? OR assignee=?"} ORDER BY ${order}`)
          .all(eventSeq, eventSeq, eventSeq, ...(options.actor === undefined ? [] : [options.actor, options.actor]));
        const userRequestScope = options.actor === undefined ? "" : " AND (t.creator=? OR t.assignee=?)";
        const userCounts = this.db.prepare(`SELECT COUNT(*) AS count FROM handoff_tasks t
          JOIN handoff_task_events e ON e.seq=(SELECT seq FROM handoff_task_events WHERE task_id=t.id AND seq<=?
            AND kind IN ('block','unblock','complete','close','reopen','cancel') ORDER BY seq DESC LIMIT 1)
          WHERE e.kind='block' AND ${userRequestAtSnapshot}${userRequestScope}`).get(eventSeq, ...(options.actor === undefined ? [] : [options.actor, options.actor]))!;
        snapshot = { ids: rows.map((row) => Number(row.id)), eventSeq, actor: options.actor, userRequestCount: Number(userCounts.count) };
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    if (snapshot.actor !== options.actor) throw new Error("Task snapshot belongs to another view; refresh the panel");
    const cursor = after === 0 ? -1 : snapshot.ids.indexOf(after);
    if (after !== 0 && cursor === -1) throw new Error("Unknown task cursor; refresh the panel");
    const ids = snapshot.ids.slice(cursor + 1, cursor + 1 + limit);
    const sides = ids.length ? this.allSides(true) : [];
    const rows = ids.length ? this.db.prepare(`SELECT * FROM handoff_tasks WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) : [];
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    const tasks = ids.map((id) => this.taskFromRow(byId.get(id)!, sides, snapshot.eventSeq));
    return { tasks, snapshot, nextAfter: cursor + 1 + limit < snapshot.ids.length ? tasks.at(-1)!.id : null };
  }

  private update(id: number, actor: string, kind: TaskEvent["kind"], data: Record<string, unknown>, validate: (task: HandoffTask) => boolean): HandoffTask {
    return this.transaction(() => {
      const task = this.read(id, actor);
      if (!validate(task)) return task;
      this.db.prepare("INSERT INTO handoff_task_events(task_id,actor,kind,data_json,at) VALUES(?,?,?,?,?)")
        .run(id, actor, kind, JSON.stringify(data), new Date().toISOString());
      return this.read(id, actor);
    });
  }

  setPriority(id: number, actor: string, value: TaskPriority): HandoffTask {
    const next = priority(value);
    return this.update(id, actor, "priority", { priority: next }, task => {
      if (task.state === "closed" || task.state === "cancelled") throw new Error(`Cannot change priority of a ${task.state} task`);
      return task.priority !== next;
    });
  }
  block(id: number, actor: string, reason: string, waitingFor: string, dependencyIds: number[] = [], userRequest?: string, userAction?: UserAction): HandoffTask {
    text(reason, "Block reason and recovery condition", 2000);
    text(waitingFor, "Waiting for", 160);
    if (userRequest !== undefined) { text(userRequest, "User action request", 1000); userRequest = userRequest.trim(); }
    if (isUserWaiting(waitingFor) && !userRequest) throw new Error('userRequest is required when waiting for user action; do not turn routine work into approval requests');
    if (userRequest) validateUserRequest(userRequest, userAction);
    else if (userAction) throw new Error('userAction requires an explicit userRequest');
    const effectiveUserRequest = userRequest;
    if (!Array.isArray(dependencyIds) || dependencyIds.length > 20) throw new Error("At most 20 dependencies are allowed");
    dependencyIds.forEach((dependency) => integer(dependency, "dependency id", 1));
    if (new Set(dependencyIds).size !== dependencyIds.length) throw new Error("Dependency ids must be unique");
    return this.transaction(() => {
      const task = this.read(id, actor);
      if (task.assignee.id !== actor || task.state !== "open") throw new Error("Only the assignee can block an open task");
      const dependencies = dependencyIds.map((dependency) => {
        if (dependency === id) throw new Error("A task cannot depend on itself");
        this.read(dependency, actor); // Never allow linking another side's private task.
        const cycle = this.db.prepare(`WITH RECURSIVE reachable(id) AS (
          SELECT ? UNION SELECT d.dependency_id FROM handoff_task_dependencies d JOIN reachable r ON d.task_id=r.id
          WHERE d.block_seq=(SELECT seq FROM handoff_task_events WHERE task_id=d.task_id
            AND kind IN ('block','unblock','complete','close','reopen','cancel') ORDER BY seq DESC LIMIT 1)
        ) SELECT 1 FROM reachable WHERE id=? LIMIT 1`).get(dependency, id);
        if (cycle) throw new Error("Dependency would create a cycle");
        const latest = this.db.prepare(`SELECT COALESCE(MAX(seq),0) AS seq FROM handoff_task_events
          WHERE task_id=? AND kind IN ('complete','close','reopen','cancel','reply')`).get(dependency)!;
        return { id: dependency, seq: Number(latest.seq) };
      }).sort((a, b) => a.id - b.id);
      const data = { reason, waitingFor, dependencies, ...(effectiveUserRequest ? { userRequest: effectiveUserRequest, userAction: { kind: userAction!.kind, limitation: userAction!.limitation } } : {}) };
      const previous = task.events.findLast((event) => event.kind === "block");
      if (task.block && JSON.stringify(previous?.data) === JSON.stringify(data)) return task;
      const event = this.db.prepare("INSERT INTO handoff_task_events(task_id,actor,kind,data_json,at) VALUES(?,?,'block',?,?)")
        .run(id, actor, JSON.stringify(data), new Date().toISOString());
      const blockSeq = Number(event.lastInsertRowid);
      if (effectiveUserRequest) {
        for (const sideId of new Set([task.creator.id, task.assignee.id])) {
          this.db.prepare("INSERT OR IGNORE INTO handoff_user_request_notifications(task_id,block_seq,side_id) VALUES(?,?,?)")
            .run(id, blockSeq, sideId);
        }
      }
      return this.read(id, actor);
    });
  }

  reply(id: number, actor: string, message: string, idempotencyKey: string, inReplyTo?: number): HandoffTask {
    text(message, "Reply message", 4000);
    text(idempotencyKey, "Reply idempotency key", 160);
    if (inReplyTo !== undefined) integer(inReplyTo, "reply seq", 1);
    return this.update(id, actor, "reply", { message, idempotencyKey, ...(inReplyTo !== undefined ? { inReplyTo } : {}) }, (task) => {
      const previous = task.events.find(event => event.kind === "reply" && event.actor === actor && event.data.idempotencyKey === idempotencyKey);
      if (previous) {
        if (previous.data.message !== message || previous.data.inReplyTo !== inReplyTo) throw new Error("Reply idempotency key is already bound to different content");
        return false;
      }
      if (task.state === "closed" || task.state === "cancelled") throw new Error(`Cannot reply to a ${task.state} task; create a new authorized task instead`);
      if (inReplyTo !== undefined && !task.events.some(event => event.seq === inReplyTo && event.kind === "reply" && event.actor !== actor)) throw new Error("inReplyTo must name a peer reply on this task");
      return true;
    });
  }

  unblock(id: number, actor: string, note: string): HandoffTask {
    text(note, "Unblock evidence", 2000);
    return this.update(id, actor, "unblock", { note }, (task) => {
      if (task.assignee.id !== actor || task.state !== "open") throw new Error("Only the assignee can unblock an open task");
      return task.block !== null;
    });
  }

  check(id: number, actor: string, item: number, checked: boolean): HandoffTask {
    integer(item, "checklist item", 1);
    if (typeof checked !== "boolean") throw new Error("checked must be boolean");
    return this.update(id, actor, "check", { item, checked }, (task) => {
      if (task.assignee.id !== actor || task.state !== "open") throw new Error("Only the assignee can check items on an open task");
      if (item > task.items.length) throw new Error("Unknown checklist item");
      return task.items[item - 1].checked !== checked;
    });
  }

  complete(id: number, actor: string, commit: string, summary: string, deliveryId?: string): HandoffTask {
    text(summary, "Completion summary", 4000);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("A full Git commit hash is required");
    return this.update(id, actor, "complete", { commit, summary, ...(deliveryId ? { deliveryId } : {}) }, (task) => {
      if (task.assignee.id !== actor) throw new Error("Only the assignee can complete this task");
      if (task.state === "completed" && task.commit === commit && task.summary === summary) return false;
      if (task.state !== "open" || task.items.some((item) => !item.checked)) throw new Error("Check every item before completing an open task");
      if (task.block) throw new Error("Recheck dependencies and unblock the task before completing it");
      if (deliveryId) {
        const delivery = this.db.prepare('SELECT d.tip,w.owner FROM handoff_deliveries d JOIN handoff_workspaces w ON w.id=d.workspace_id WHERE d.id=?').get(deliveryId);
        if (!delivery || delivery.tip !== commit || delivery.owner !== actor) throw new Error('Delivery snapshot must match this side and commit');
      }
      return true;
    });
  }

  closeTask(id: number, actor: string, reviewedCommit: string, note: string): HandoffTask {
    text(note, "Review note", 4000);
    const data: Record<string, unknown> = { commit: reviewedCommit, note };
    return this.update(id, actor, "close", data, (task) => {
      if (task.creator.id !== actor) throw new Error("Only the creator can close this task");
      if (task.commit !== reviewedCommit) throw new Error("Reviewed commit must match the completed commit");
      if (task.state === "closed") return false;
      if (task.state !== "completed") throw new Error("The assignee must complete the task before review closure");
      if (task.requiresIntegration) {
        if (task.integration?.state !== "pushed" || task.integration.commit !== reviewedCommit || !task.integration.mainCommit) throw new Error("Integrate and push the reviewed commit before closing this code task");
        data.mainCommit = task.integration.mainCommit;
        data.jobId = task.integration.jobId;
      }
      data.reviewMode = task.kind === "local" ? "self" : "peer";
      return true;
    });
  }

  cancel(id: number, actor: string, reason: string): HandoffTask {
    text(reason, "Cancellation reason", 2000);
    return this.update(id, actor, "cancel", { reason }, (task) => {
      if (task.creator.id !== actor) throw new Error("Only the creator can cancel a task");
      if (task.state === "cancelled") {
        if (task.cancellation?.reason !== reason) throw new Error("Task was already cancelled with a different reason");
        return false;
      }
      if (task.state === "closed") throw new Error("Cannot cancel a closed task");
      if (task.integration && task.integration.state !== "blocked") throw new Error("Cannot cancel queued/running or pushed code; preserve it and wait for integration, or create a corrective task");
      return true;
    });
  }

  reopen(id: number, actor: string, note: string): HandoffTask {
    text(note, "Return reason", 4000);
    return this.update(id, actor, "reopen", { note }, (task) => {
      if (task.creator.id !== actor || task.state !== "completed") throw new Error("Only the creator can return a completed task for changes");
      if (task.integration?.state === "queued" || task.integration?.state === "running") throw new Error("Integration is queued/running; wait for its result before returning changes");
      if (task.integration?.state === "pushed") throw new Error("Already integrated code requires a new corrective task, not reopening the delivered commit");
      return true;
    });
  }

  status(actor: string): Record<string, unknown> {
    const visible = this.db.prepare("SELECT COUNT(*) AS total FROM handoff_tasks WHERE creator=? OR assignee=?").get(actor, actor)!;
    return {
      extensionVersion: HANDOFF_EXTENSION_VERSION, dbPath: this.dbPath, visibleTasks: Number(visible.total),
      autoResume: this.resumeStatus(actor),
      integrity: String(Object.values(this.db.prepare("PRAGMA integrity_check").get()!)[0]),
      takeovers: this.db.prepare("SELECT * FROM handoff_side_transfers WHERE side_id=? ORDER BY seq").all(actor),
    };
  }
}
