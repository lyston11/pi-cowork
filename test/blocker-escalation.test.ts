import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { HandoffStore } from "../store.ts";

const inputAction = { kind: 'input' as const, limitation: 'The missing credential is held only by the user; project inputs do not contain it' };
const request = 'Provide the missing test credential using the private input channel';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-blocked-report-"));
  const store = new HandoffStore(root);
  for (const id of ["a", "b", "c"]) store.register({ id, sessionId: id, name: id, pid: process.pid, worktree: root, branch: "main" });
  const peer = new HandoffStore(root);
  for (const id of ["a", "b", "c"]) store.acquireResume(id, id, id);
  return { root, store, peer,
    create: () => store.create({ to: "b", subject: "work", body: "private task", items: ["finish"] }, "a"),
    close() { peer.close(); store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("each ongoing blocker wakes only the creator once and delivers the latest reason", () => {
  const f = fixture();
  try {
    const task = f.create();
    f.store.acknowledgeResume("b", "b", f.store.pendingResume("b", "b")!.throughSeq);
    f.peer.block(task.id, "b", "missing approval", "user", [], request, inputAction);
    const first = f.store.pendingResume("a", "a")!;
    assert.deepEqual(first.events.map(e => [e.taskId, e.kind]), [[task.id, "blocked"]]);
    assert.equal(f.store.pendingResume("b", "b"), null);
    assert.equal(f.store.pendingResume("c", "c"), null);
    assert.throws(() => f.store.read(task.id, "c"), /not visible/);
    f.peer.check(task.id, "b", 1, true);
    f.peer.block(task.id, "b", "updated missing configuration", "user and operations", [], request, inputAction);
    assert.equal(f.store.pendingResume("a", "a")!.throughSeq, first.throughSeq);
    assert.match(f.store.read(task.id, "a").block!.reason, /updated/);
    f.store.acknowledgeResume("a", "a", first.throughSeq);
    f.peer.block(task.id, "b", "another review, still missing input", "user", [], request, inputAction);
    assert.equal(f.store.pendingResume("a", "a"), null);
    f.peer.unblock(task.id, "b", "approval received");
    f.peer.block(task.id, "b", "new external outage", "operations");
    const second = f.store.pendingResume("a", "a")!;
    assert(second.throughSeq > first.throughSeq);
    assert.deepEqual(second.events.map(e => e.kind), ["blocked"]);
    // A queued escalation must become irrelevant once the blocker is resolved.
    f.peer.unblock(task.id, "b", "outage resolved");
    assert.deepEqual(f.store.pendingResume("a", "a")!.events, []);
  } finally { f.close(); }
});

test("upgrade backfills existing active blockers once without enabling paused creators", () => {
  const f = fixture(); const sql = new DatabaseSync(f.store.dbPath);
  try {
    sql.exec("DROP TRIGGER handoff_resume_blocked");
    const active = f.create(), resolved = f.create(), completed = f.create();
    f.peer.block(active.id, "b", "old missing configuration", "user", [], request, inputAction);
    f.peer.block(active.id, "b", "old reason clarified", "user", [], request, inputAction);
    f.peer.block(resolved.id, "b", "old resolved blocker", "user", [], request, inputAction);
    f.peer.unblock(resolved.id, "b", "already resolved");
    f.peer.block(completed.id, "b", "old blocker", "user", [], request, inputAction);
    f.peer.unblock(completed.id, "b", "ready");
    f.peer.check(completed.id, "b", 1, true);
    f.peer.complete(completed.id, "b", "a".repeat(40), "finished");
    const before = f.store.pendingResume("a", "a")!;
    f.store.acknowledgeResume("a", "a", before.throughSeq);
    f.store.setResumeEnabled("a", false, "user paused");
    const upgraded = new HandoffStore(f.root);
    upgraded.close();
    assert.equal(f.store.pendingResume("a", "a"), null);
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM handoff_resume_events WHERE kind='blocked'").get()!.n, 1);
    assert.equal(sql.prepare("SELECT enabled FROM handoff_resume_state WHERE side_id='a'").get()!.enabled, 0);
    const restarted = new HandoffStore(f.root); restarted.close();
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM handoff_resume_events WHERE kind='blocked'").get()!.n, 1);
    f.store.setResumeEnabled("a", true);
    assert(f.store.acquireResume("a", "a", "a"));
    const batch = f.store.pendingResume("a", "a")!;
    assert.deepEqual(batch.events.filter(e => e.kind === "blocked").map(e => e.taskId), [active.id]);
  } finally { sql.close(); f.close(); }
});

test("older writers notify transactionally and rolled-back blockers leave no escalation", () => {
  const f = fixture(); const sql = new DatabaseSync(f.store.dbPath);
  try {
    const task = f.create();
    const insert = sql.prepare("INSERT INTO handoff_task_events(task_id,actor,kind,data_json,at) VALUES(?,'b','block',?,?)");
    const data = JSON.stringify({ reason: "legacy blocker", waitingFor: "user", dependencies: [] });
    sql.exec("BEGIN IMMEDIATE");
    insert.run(task.id, data, new Date().toISOString());
    assert.equal(f.store.pendingResume("a", "a"), null);
    sql.exec("ROLLBACK");
    assert.equal(f.store.pendingResume("a", "a"), null);
    insert.run(task.id, data, new Date().toISOString());
    assert.deepEqual(f.store.pendingResume("a", "a")!.events.map(e => e.kind), ["blocked"]);
  } finally { sql.close(); f.close(); }
});
