import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { HandoffStore } from "./store.ts";
import type { IntegrationCheck, IntegrationJob, TaskIntegration } from "./types.ts";

export function initializeIntegration(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(handoff_tasks)").all();
  if (!columns.some(column => column.name === "requires_integration")) {
    db.exec("ALTER TABLE handoff_tasks ADD COLUMN requires_integration INTEGER NOT NULL DEFAULT 0");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS handoff_integrations (
      id TEXT PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES handoff_tasks(id),
      creator TEXT NOT NULL REFERENCES handoff_sides(id), commit_hash TEXT NOT NULL,
      repo TEXT NOT NULL, remote_fingerprint TEXT NOT NULL, reviewed_base TEXT NOT NULL,
      checks_json TEXT NOT NULL, state TEXT NOT NULL, note TEXT NOT NULL,
      main_commit TEXT, attempts INTEGER NOT NULL DEFAULT 0, owner TEXT,
      UNIQUE(task_id,commit_hash)
    );
    CREATE INDEX IF NOT EXISTS handoff_integration_pending ON handoff_integrations(repo,state);
    CREATE TABLE IF NOT EXISTS handoff_integration_locks (
      repo TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, start_key TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS handoff_integration_close_guard BEFORE INSERT ON handoff_task_events
      WHEN NEW.kind='close' AND EXISTS(SELECT 1 FROM handoff_tasks t WHERE t.id=NEW.task_id
        AND (t.requires_integration=1 OR EXISTS(SELECT 1 FROM handoff_integrations j WHERE j.task_id=t.id)))
        AND NOT EXISTS(SELECT 1 FROM handoff_integrations j WHERE j.task_id=NEW.task_id
          AND j.commit_hash=json_extract(NEW.data_json,'$.commit') AND j.state='pushed' AND j.main_commit=json_extract(NEW.data_json,'$.mainCommit'))
      BEGIN SELECT RAISE(ABORT, 'Integrate and push the reviewed commit before closing this code task'); END;
    CREATE TRIGGER IF NOT EXISTS handoff_integration_reopen_guard BEFORE INSERT ON handoff_task_events
      WHEN NEW.kind='reopen' AND EXISTS(SELECT 1 FROM handoff_integrations j WHERE j.task_id=NEW.task_id
        AND j.state IN ('queued','running','pushed') AND j.commit_hash=(SELECT json_extract(data_json,'$.commit')
          FROM handoff_task_events WHERE task_id=NEW.task_id AND kind='complete' ORDER BY seq DESC LIMIT 1))
      BEGIN SELECT RAISE(ABORT, 'Cannot return queued/running or pushed code; wait for integration, or create a corrective task for merged code'); END;
    CREATE TRIGGER IF NOT EXISTS handoff_resume_integration AFTER INSERT ON handoff_task_events
      WHEN NEW.kind='integration' AND json_extract(NEW.data_json,'$.state') IN ('pushed','blocked')
      BEGIN INSERT INTO handoff_resume_events(recipient,task_id,kind,source)
        SELECT creator,NEW.task_id,'integration','integration:'||NEW.seq FROM handoff_tasks WHERE id=NEW.task_id; END;
  `);
}

function startKey(pid: number): string {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[19]; }
  catch { return ""; }
}
function alive(pid: number, key: string): boolean {
  try { process.kill(pid, 0); return !key || !startKey(pid) || startKey(pid) === key; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export class IntegrationQueue {
  private db: DatabaseSync;
  private owner = randomUUID();
  private store: HandoffStore;
  constructor(store: HandoffStore) {
    this.store = store;
    this.db = new DatabaseSync(store.dbPath);
    this.db.exec("PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON");
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private job(row: Record<string, unknown>): IntegrationJob {
    return { jobId: String(row.id), taskId: Number(row.task_id), creator: String(row.creator),
      state: row.state as TaskIntegration["state"], commit: String(row.commit_hash), repo: String(row.repo),
      remoteFingerprint: String(row.remote_fingerprint), reviewedBase: String(row.reviewed_base),
      checks: JSON.parse(String(row.checks_json)), attempts: Number(row.attempts),
      note: String(row.note), ...(row.main_commit ? { mainCommit: String(row.main_commit) } : {}) };
  }
  private event(job: IntegrationJob): void {
    const { jobId, state, commit, mainCommit, note } = job;
    this.db.prepare("INSERT INTO handoff_task_events(task_id,actor,kind,data_json,at) VALUES(?,?,'integration',?,?)")
      .run(job.taskId, job.creator, JSON.stringify({ jobId, state, commit, mainCommit, note, ...(state === "pushed" ? { checks: job.checks } : {}) }), new Date().toISOString());
  }
  read(id: string): IntegrationJob {
    const row = this.db.prepare("SELECT * FROM handoff_integrations WHERE id=?").get(id);
    if (!row) throw new Error("Integration job not found");
    return this.job(row);
  }
  enqueue(input: { taskId: number; actor: string; commit: string; repo: string; remoteFingerprint: string;
    reviewedBase: string; checks: IntegrationCheck[]; note: string; retry?: boolean }): IntegrationJob {
    if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(input.commit) || !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(input.reviewedBase)) throw new Error("Full commit hashes required");
    if (!input.note.trim() || input.note.length > 4000) throw new Error("Record the actual review result (1-4000 characters)");
    if (!Array.isArray(input.checks) || !input.checks.length || input.checks.length > 10) throw new Error("Provide 1-10 integration check commands");
    for (const check of input.checks) {
      if (!check.command || /[\x00\r\n]/.test(check.command) || check.command.length > 512
        || !Array.isArray(check.args) || check.args.length > 100 || check.args.some(arg => typeof arg !== "string" || arg.includes("\0") || arg.length > 4096)) throw new Error("Invalid integration check command/arguments");
    }
    return this.transaction(() => {
      const task = this.store.read(input.taskId, input.actor);
      if (task.creator.id !== input.actor || task.state !== "completed" || task.commit !== input.commit) throw new Error("Only the creator can queue the reviewed, completed commit");
      const previous = this.db.prepare("SELECT * FROM handoff_integrations WHERE task_id=? AND commit_hash=?").get(task.id, input.commit);
      if (previous && (previous.state === "queued" || previous.state === "running" || previous.state === "pushed" && !input.retry)) return this.job(previous);
      if (previous && !input.retry) throw new Error("Integration is blocked; read the reason, resolve it, and explicitly retry");
      const id = previous ? String(previous.id) : randomUUID();
      this.db.prepare(`INSERT INTO handoff_integrations(id,task_id,creator,commit_hash,repo,remote_fingerprint,reviewed_base,checks_json,state,note)
        VALUES(?,?,?,?,?,?,?,?,'queued',?) ON CONFLICT(task_id,commit_hash) DO UPDATE SET
        repo=excluded.repo,remote_fingerprint=excluded.remote_fingerprint,reviewed_base=excluded.reviewed_base,
        checks_json=excluded.checks_json,state='queued',note=excluded.note,main_commit=NULL,attempts=0,owner=NULL`)
        .run(id, task.id, input.actor, input.commit, input.repo, input.remoteFingerprint, input.reviewedBase, JSON.stringify(input.checks), input.note);
      const job = this.read(id); this.event(job); return job;
    });
  }
  claim(repo: string): IntegrationJob | null {
    if (!this.db.prepare("SELECT 1 FROM handoff_integrations WHERE repo=? AND state IN ('queued','running') LIMIT 1").get(repo)) return null;
    return this.transaction(() => {
      const lock = this.db.prepare("SELECT * FROM handoff_integration_locks WHERE repo=?").get(repo);
      if (lock && lock.owner !== this.owner && alive(Number(lock.pid), String(lock.start_key))) return null;
      this.db.prepare("INSERT INTO handoff_integration_locks VALUES(?,?,?,?) ON CONFLICT(repo) DO UPDATE SET owner=excluded.owner,pid=excluded.pid,start_key=excluded.start_key")
        .run(repo, this.owner, process.pid, startKey(process.pid));
      const row = this.db.prepare("SELECT * FROM handoff_integrations WHERE repo=? AND state IN ('queued','running') ORDER BY rowid LIMIT 1").get(repo);
      if (!row) return null;
      this.db.prepare("UPDATE handoff_integrations SET state='running',owner=?,attempts=attempts+1 WHERE id=?").run(this.owner, row.id);
      const job = this.read(String(row.id)); this.event(job); return job;
    });
  }
  finish(id: string, state: "blocked" | "pushed" | "queued", note: string, mainCommit?: string): void {
    this.transaction(() => {
      const result = this.db.prepare("UPDATE handoff_integrations SET state=?,note=?,main_commit=? WHERE id=? AND owner=?")
        .run(state, note.slice(0, 12000), mainCommit ?? null, id, this.owner);
      if (result.changes !== 1) throw new Error("Integration ownership changed");
      this.event(this.read(id));
    });
  }
  release(repo: string): void {
    this.db.prepare("DELETE FROM handoff_integration_locks WHERE repo=? AND owner=?").run(repo, this.owner);
  }
}
