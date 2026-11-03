import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HANDOFF_EXTENSION_VERSION, type CreateInput, type HandoffTask, type Side, type TaskEvent, type TaskSummary } from "./types.ts";

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${name} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function integer(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
  return value;
}

const immutable = (table: string) => `
  CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'Handoff records are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'Handoff records are append-only'); END;
`;

export interface HumanTaskSnapshot {
  ids: number[];
  eventSeq: number;
  actor?: string;
}

export interface ResumeEvent {
  seq: number;
  taskId: number;
  kind: "created" | "complete" | "reopen" | "close";
}

export interface ResumeBatch {
  throughSeq: number;
  events: ResumeEvent[];
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
        CREATE TABLE IF NOT EXISTS handoff_side_transfers (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          side_id TEXT NOT NULL REFERENCES handoff_sides(id),
          from_session TEXT NOT NULL,
          to_session TEXT NOT NULL,
          actor_side TEXT NOT NULL REFERENCES handoff_sides(id),
          reason TEXT NOT NULL,
          at TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS handoff_side_owner_guard BEFORE UPDATE ON handoff_sides
          WHEN EXISTS(SELECT 1 FROM handoff_side_bindings b WHERE b.side_id=OLD.id
            AND (b.session_id IS NULL OR b.session_id<>NEW.session_id))
          BEGIN SELECT RAISE(ABORT, 'Side ownership transferred; this session cannot reclaim it'); END;
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
        ${immutable("handoff_tasks")}
        ${immutable("handoff_task_events")}
      `);
      this.initializeResume();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private initializeResume(): void {
    this.transaction(() => {
      const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff_resume_events'").get();
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
        CREATE TRIGGER IF NOT EXISTS handoff_resume_created AFTER INSERT ON handoff_tasks
          BEGIN INSERT INTO handoff_resume_events(recipient,task_id,kind,source)
            VALUES(NEW.assignee,NEW.id,'created','task:'||NEW.id); END;
        CREATE TRIGGER IF NOT EXISTS handoff_resume_changed AFTER INSERT ON handoff_task_events
          WHEN NEW.kind IN ('complete','reopen','close')
          BEGIN INSERT INTO handoff_resume_events(recipient,task_id,kind,source)
            SELECT CASE NEW.kind WHEN 'complete' THEN creator ELSE assignee END,
              NEW.task_id,NEW.kind,'event:'||NEW.seq FROM handoff_tasks WHERE id=NEW.task_id; END;
        ${immutable("handoff_resume_events")}
      `);
      // Bootstrap old clients' records once. Triggers also cover writes by Pi
      // processes still running an earlier extension version.
      if (!exists) this.db.exec(`
        INSERT OR IGNORE INTO handoff_resume_events(recipient,task_id,kind,source)
          SELECT assignee,id,'created','task:'||id FROM handoff_tasks;
        INSERT OR IGNORE INTO handoff_resume_events(recipient,task_id,kind,source)
          SELECT CASE e.kind WHEN 'complete' THEN t.creator ELSE t.assignee END,
            t.id,e.kind,'event:'||e.seq FROM handoff_task_events e JOIN handoff_tasks t ON t.id=e.task_id
            WHERE e.kind IN ('complete','reopen','close') ORDER BY e.seq;
      `);
    });
  }

  acquireResume(actor: string, sessionId: string, consumer: string, now = Date.now()): boolean {
    return this.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM handoff_sides WHERE id=? AND session_id=?").get(actor, sessionId)) return false;
      this.db.prepare("INSERT OR IGNORE INTO handoff_resume_state(side_id) VALUES(?)").run(actor);
      return this.db.prepare(`UPDATE handoff_resume_state SET consumer=?,lease_until=? WHERE side_id=? AND enabled=1
        AND (consumer IS NULL OR consumer=? OR lease_until<=?)`).run(consumer, now + 15000, actor, consumer, now).changes === 1;
    });
  }

  pendingResume(actor: string, consumer: string): ResumeBatch | null {
    const state = this.db.prepare("SELECT ack_seq FROM handoff_resume_state WHERE side_id=? AND consumer=? AND enabled=1").get(actor, consumer);
    if (!state) return null;
    const rows = this.db.prepare(`SELECT r.seq,r.task_id,r.kind,r.source,
      (SELECT kind FROM handoff_task_events WHERE task_id=r.task_id AND kind IN ('complete','reopen','close') ORDER BY seq DESC LIMIT 1) AS current_kind,
      (SELECT seq FROM handoff_task_events WHERE task_id=r.task_id AND kind IN ('complete','reopen','close') ORDER BY seq DESC LIMIT 1) AS current_seq
      FROM handoff_resume_events r WHERE recipient=? AND seq>? ORDER BY seq LIMIT 100`).all(actor, Number(state.ack_seq));
    if (!rows.length) return null;
    let hasWork: boolean | undefined;
    const events = new Map<number, ResumeEvent>();
    for (const row of rows) {
      const kind = row.kind as ResumeEvent["kind"];
      let relevant = kind === "complete" ? row.current_kind === "complete"
        : kind === "close" ? row.current_kind === "close" : row.current_kind === null || row.current_kind === "reopen";
      if (String(row.source).startsWith("task:") && row.current_seq !== null) relevant = false;
      if (String(row.source).startsWith("event:") && row.source !== `event:${row.current_seq}`) relevant = false;
      if (relevant && kind === "close") {
        // Acceptance can unblock other work, but never wake solely to admire a
        // closed task when this side has nothing left to execute or review.
        hasWork ??= !!this.db.prepare(`SELECT 1 FROM handoff_tasks t WHERE
          (assignee=? AND COALESCE((SELECT kind FROM handoff_task_events WHERE task_id=t.id AND kind IN ('complete','close','reopen') ORDER BY seq DESC LIMIT 1),'reopen')='reopen')
          OR (creator=? AND (SELECT kind FROM handoff_task_events WHERE task_id=t.id AND kind IN ('complete','close','reopen') ORDER BY seq DESC LIMIT 1)='complete') LIMIT 1`).get(actor, actor);
        relevant = hasWork;
      }
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
      const previous = this.db.prepare("SELECT enabled FROM handoff_resume_state WHERE side_id=?").get(actor);
      this.db.prepare(`INSERT INTO handoff_resume_state(side_id,enabled,reason) VALUES(?,?,?)
        ON CONFLICT(side_id) DO UPDATE SET enabled=excluded.enabled,reason=excluded.reason`).run(actor, Number(enabled), reason);
      if (enabled && previous?.enabled === 0) {
        // Explicit user recovery should also retry delivered-but-failed work.
        // Repeated 'on' while enabled creates no new events or model loop.
        const source = `retry:${randomUUID()}:`;
        this.db.prepare(`INSERT INTO handoff_resume_events(recipient,task_id,kind,source)
          SELECT ?,t.id,CASE WHEN t.assignee=? THEN 'created' ELSE 'complete' END,?||t.id FROM handoff_tasks t
          WHERE (t.assignee=? AND COALESCE((SELECT kind FROM handoff_task_events WHERE task_id=t.id AND kind IN ('complete','close','reopen') ORDER BY seq DESC LIMIT 1),'reopen')='reopen')
            OR (t.creator=? AND (SELECT kind FROM handoff_task_events WHERE task_id=t.id AND kind IN ('complete','close','reopen') ORDER BY seq DESC LIMIT 1)='complete')`)
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
      const bound = this.sessionSide(side.sessionId);
      if (bound && bound.id !== side.id) throw new Error("Session is bound to another side; use its inherited identity");
      this.db.prepare(`INSERT INTO handoff_sides(id,name,session_id,pid,worktree,branch) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,session_id=excluded.session_id,
        pid=excluded.pid,worktree=excluded.worktree,branch=excluded.branch`).run(
          side.id, side.name, side.sessionId, side.pid, side.worktree, side.branch,
        );
    });
  }

  sessionSide(sessionId: string): Side | undefined {
    const binding = this.db.prepare("SELECT side_id FROM handoff_side_bindings WHERE session_id=?").get(sessionId);
    if (binding) return this.sides().find((side) => side.id === binding.side_id);
    if (this.db.prepare("SELECT 1 FROM handoff_side_transfers WHERE from_session=? LIMIT 1").get(sessionId)) {
      throw new Error("This session was replaced by a handoff takeover. It cannot reclaim the old side.");
    }
    return this.sides().find((side) => side.sessionId === sessionId);
  }

  takeover(actor: Side, targetId: string, expectedSessionId: string, reason: string): Side {
    text(targetId, "Target side id", 256);
    text(expectedSessionId, "Expected session id", 256);
    text(reason, "Takeover reason", 2000);
    return this.transaction(() => {
      const sides = this.sides();
      const current = sides.find((side) => side.id === actor.id);
      const target = sides.find((side) => side.id === targetId);
      if (!current || current.sessionId !== actor.sessionId) throw new Error("Current side ownership has changed");
      if (!target) throw new Error("Target side not found; use an id from handoff_sides");
      if (target.id === actor.id) return current;
      if (target.sessionId !== expectedSessionId) throw new Error("Target ownership changed; read handoff_sides again before taking over");
      if (this.db.prepare("SELECT 1 FROM handoff_tasks WHERE creator=? OR assignee=? LIMIT 1").get(actor.id, actor.id)) {
        throw new Error("Current side already owns tasks. Start a fresh Pi session to take over without losing its access.");
      }
      try {
        process.kill(target.pid, 0);
        throw new Error(`Old side process ${target.pid} is still running; stop it before taking over`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      this.db.prepare("INSERT INTO handoff_side_bindings(side_id,session_id) VALUES(?,NULL) ON CONFLICT(side_id) DO UPDATE SET session_id=NULL").run(actor.id);
      this.db.prepare("INSERT INTO handoff_side_bindings(side_id,session_id) VALUES(?,?) ON CONFLICT(side_id) DO UPDATE SET session_id=excluded.session_id").run(target.id, actor.sessionId);
      this.db.prepare("UPDATE handoff_sides SET session_id=?,pid=?,worktree=?,branch=? WHERE id=?").run(actor.sessionId, actor.pid, actor.worktree, actor.branch, target.id);
      this.db.prepare("INSERT INTO handoff_side_transfers(side_id,from_session,to_session,actor_side,reason,at) VALUES(?,?,?,?,?,?)").run(target.id, target.sessionId, actor.sessionId, actor.id, reason, new Date().toISOString());
      return { ...actor, id: target.id, name: target.name };
    });
  }

  sides(): Side[] {
    return this.db.prepare(`SELECT * FROM handoff_sides s WHERE NOT EXISTS(
      SELECT 1 FROM handoff_side_bindings b WHERE b.side_id=s.id AND b.session_id IS NULL
    ) ORDER BY name,id`).all().map((row) => ({
      id: String(row.id), name: String(row.name), sessionId: String(row.session_id),
      pid: Number(row.pid), worktree: String(row.worktree), branch: String(row.branch),
    }));
  }

  create(input: CreateInput, actor: string): HandoffTask {
    const to = text(input.to, "Assignee", 256);
    const subject = text(input.subject, "Subject", 160);
    const body = text(input.body, "Body", 16000);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) throw new Error("Provide 1-50 checklist items");
    const items = input.items.map((item) => text(item, "Checklist item", 1000));
    if (input.refs !== undefined && (!Array.isArray(input.refs) || input.refs.length > 20)) throw new Error("At most 20 references are allowed");
    const refs = (input.refs ?? []).map((ref) => text(ref, "Reference", 512));
    const key = input.idempotencyKey === undefined ? null : text(input.idempotencyKey, "Idempotency key", 160);
    return this.transaction(() => {
      const matches = this.sides().filter((side) => side.id === to || side.name === to);
      if (matches.length !== 1) throw new Error("Assignee not found or name is ambiguous; use an id from handoff_sides");
      const assignee = matches[0].id;
      if (assignee === actor) throw new Error("Assign the handoff to another side");
      const hash = createHash("sha256").update(JSON.stringify({ assignee, subject, body, items, refs })).digest("hex");
      if (key !== null) {
        const existing = this.db.prepare("SELECT id,payload_hash FROM handoff_tasks WHERE creator=? AND idempotency_key=?").get(actor, key);
        if (existing) {
          if (existing.payload_hash !== hash) throw new Error("Idempotency key is already bound to different content");
          return this.read(Number(existing.id), actor);
        }
      }
      const result = this.db.prepare(`INSERT INTO handoff_tasks(
        creator,assignee,subject,body,items_json,refs_json,created_at,idempotency_key,payload_hash
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(actor, assignee, subject, body, JSON.stringify(items), JSON.stringify(refs), new Date().toISOString(), key, hash);
      return this.read(Number(result.lastInsertRowid), actor);
    });
  }

  read(id: number, actor: string): HandoffTask {
    integer(id, "task id", 1);
    const row = this.db.prepare("SELECT * FROM handoff_tasks WHERE id=? AND (creator=? OR assignee=?)").get(id, actor, actor);
    if (!row) throw new Error("Task not found or not visible to this side");
    return this.taskFromRow(row);
  }

  private taskFromRow(row: Record<string, unknown>, sides = this.sides(), eventSeq = Number.MAX_SAFE_INTEGER): HandoffTask {
    const task: HandoffTask = {
      id: Number(row.id), creator: sides.find((side) => side.id === row.creator)!,
      assignee: sides.find((side) => side.id === row.assignee)!, subject: String(row.subject), body: String(row.body),
      refs: JSON.parse(String(row.refs_json)), items: (JSON.parse(String(row.items_json)) as string[]).map((value) => ({ text: value, checked: false })),
      state: "open", commit: null, summary: null, reviewNote: null, createdAt: String(row.created_at),
      events: this.db.prepare("SELECT * FROM handoff_task_events WHERE task_id=? AND seq<=? ORDER BY seq").all(Number(row.id), eventSeq).map((event) => ({
        seq: Number(event.seq), actor: String(event.actor), kind: String(event.kind) as TaskEvent["kind"], data: JSON.parse(String(event.data_json)), at: String(event.at),
      })),
    };
    for (const event of task.events) {
      if (event.kind === "check") task.items[Number(event.data.item) - 1].checked = event.data.checked === true;
      if (event.kind === "complete") {
        task.state = "completed"; task.commit = String(event.data.commit); task.summary = String(event.data.summary);
      }
      if (event.kind === "close") { task.state = "closed"; task.reviewNote = String(event.data.note); }
      if (event.kind === "reopen") {
        task.state = "open"; task.commit = null; task.summary = null; task.reviewNote = null;
        task.items.forEach((item) => { item.checked = false; });
      }
    }
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
      if (options.activeOnly && task.state === "closed") continue;
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
        const order = options.sort === "pending" ? "state_rank ASC,id ASC" : options.sort === "reviewed" ? "state_rank DESC,id ASC" : "id ASC";
        const rows = this.db.prepare(`SELECT t.id, COALESCE((
          SELECT CASE kind WHEN 'complete' THEN 1 WHEN 'close' THEN 2 ELSE 0 END
          FROM handoff_task_events WHERE task_id=t.id AND kind IN ('complete','close','reopen')
          ORDER BY seq DESC LIMIT 1
        ),0) AS state_rank FROM handoff_tasks t
        ${options.actor === undefined ? "" : "WHERE creator=? OR assignee=?"} ORDER BY ${order}`)
          .all(...(options.actor === undefined ? [] : [options.actor, options.actor]));
        snapshot = { ids: rows.map((row) => Number(row.id)), eventSeq, actor: options.actor };
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    if (snapshot.actor !== options.actor) throw new Error("Task snapshot belongs to another view; refresh the panel");
    const cursor = after === 0 ? -1 : snapshot.ids.indexOf(after);
    if (after !== 0 && cursor === -1) throw new Error("Unknown task cursor; refresh the panel");
    const ids = snapshot.ids.slice(cursor + 1, cursor + 1 + limit);
    const sides = ids.length ? this.sides() : [];
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

  check(id: number, actor: string, item: number, checked: boolean): HandoffTask {
    integer(item, "checklist item", 1);
    if (typeof checked !== "boolean") throw new Error("checked must be boolean");
    return this.update(id, actor, "check", { item, checked }, (task) => {
      if (task.assignee.id !== actor || task.state !== "open") throw new Error("Only the assignee can check items on an open task");
      if (item > task.items.length) throw new Error("Unknown checklist item");
      return task.items[item - 1].checked !== checked;
    });
  }

  complete(id: number, actor: string, commit: string, summary: string): HandoffTask {
    text(summary, "Completion summary", 4000);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("A full Git commit hash is required");
    return this.update(id, actor, "complete", { commit, summary }, (task) => {
      if (task.assignee.id !== actor) throw new Error("Only the assignee can complete this task");
      if (task.state === "completed" && task.commit === commit && task.summary === summary) return false;
      if (task.state !== "open" || task.items.some((item) => !item.checked)) throw new Error("Check every item before completing an open task");
      return true;
    });
  }

  closeTask(id: number, actor: string, reviewedCommit: string, note: string): HandoffTask {
    text(note, "Review note", 4000);
    return this.update(id, actor, "close", { commit: reviewedCommit, note }, (task) => {
      if (task.creator.id !== actor) throw new Error("Only the creator can close this task");
      if (task.commit !== reviewedCommit) throw new Error("Reviewed commit must match the completed commit");
      if (task.state === "closed") return false;
      if (task.state !== "completed") throw new Error("The assignee must complete the task before review closure");
      return true;
    });
  }

  reopen(id: number, actor: string, note: string): HandoffTask {
    text(note, "Return reason", 4000);
    return this.update(id, actor, "reopen", { note }, (task) => {
      if (task.creator.id !== actor || task.state !== "completed") throw new Error("Only the creator can return a completed task for changes");
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
