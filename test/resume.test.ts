import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { HandoffStore } from "../store.ts";
import { EventResume } from "../resume.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-handoff-resume-"));
  const store = new HandoffStore(root);
  const peer = new HandoffStore(root);
  const side = (id: string) => {
    const side = { id, sessionId: `session-${id}`, pid: process.pid, worktree: root, branch: "main", name: id };
    store.register(side);
    return side;
  };
  const a = side("a"), b = side("b"), c = side("c");
  const create = (from = a.id, to = b.id) => peer.create({ to, subject: "deliver", body: "Authorized project work", items: ["finish"], refs: [] }, from);
  const complete = (id: number, assignee = b.id) => { peer.check(id, assignee, 1, true); peer.complete(id, assignee, "a".repeat(40), "done"); };
  return { root, store, peer, a, b, c, create, complete, cleanup() { peer.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("peer writes durably route lifecycle events; stale events, checks and unrelated sides do not wake", () => {
  const f = fixture();
  try {
    const { store, a, b, c } = f;
    const first = f.create();
    assert(store.acquireResume(b.id, b.sessionId, "b"));
    assert(store.acquireResume(a.id, a.sessionId, "a"));
    assert(store.acquireResume(c.id, c.sessionId, "c"));
    let batch = store.pendingResume(b.id, "b")!;
    assert.deepEqual(batch.events.map(e => [e.taskId, e.kind]), [[first.id, "created"]]);
    assert.equal(store.pendingResume(c.id, "c"), null);
    store.acknowledgeResume(b.id, "b", batch.throughSeq);
    f.complete(first.id);
    batch = store.pendingResume(a.id, "a")!;
    assert.deepEqual(batch.events.map(e => e.kind), ["complete"]);
    store.acknowledgeResume(a.id, "a", batch.throughSeq);
    f.peer.reopen(first.id, a.id, "needs more");
    assert.deepEqual(store.pendingResume(b.id, "b")!.events.map(e => e.kind), ["reopen"]);
    f.complete(first.id);
    f.peer.closeTask(first.id, a.id, "a".repeat(40), "accepted");
    assert.deepEqual(store.pendingResume(b.id, "b")!.events, []);
    store.acknowledgeResume(b.id, "b", store.pendingResume(b.id, "b")!.throughSeq);
    assert.deepEqual(store.pendingResume(a.id, "a")!.events, []);
    const waiting = f.create();
    const dep = f.create(b.id, a.id);
    f.complete(dep.id, a.id);
    f.peer.closeTask(dep.id, b.id, "a".repeat(40), "accepted");
    assert.deepEqual(store.pendingResume(b.id, "b")!.events.map(e => [e.taskId, e.kind]), [[waiting.id, "created"]]);
    // B is the assignee of a closed task, and still has other work; acceptance
    // from A is a relevant dependency change.
    const secondDep = f.create(); f.complete(secondDep.id);
    f.peer.closeTask(secondDep.id, a.id, "a".repeat(40), "accepted");
    assert(store.pendingResume(b.id, "b")!.events.some(e => e.taskId === secondDep.id && e.kind === "close"));
  } finally { f.cleanup(); }
});

test("long historical backlogs skip superseded events even across delivery pages", () => {
  const f = fixture();
  try {
    const task = f.create();
    for (let i = 0; i < 101; i++) {
      f.complete(task.id);
      f.peer.reopen(task.id, f.a.id, `revision ${i}`);
    }
    assert(f.store.acquireResume(f.b.id, f.b.sessionId, "backlog"));
    const first = f.store.pendingResume(f.b.id, "backlog")!;
    assert.deepEqual(first.events, []);
    f.store.acknowledgeResume(f.b.id, "backlog", first.throughSeq);
    const last = f.store.pendingResume(f.b.id, "backlog")!;
    assert.deepEqual(last.events.map(e => [e.taskId, e.kind]), [[task.id, "reopen"]]);
    f.store.acknowledgeResume(f.b.id, "backlog", last.throughSeq);
    assert.equal(f.store.pendingResume(f.b.id, "backlog"), null);
  } finally { f.cleanup(); }
});

test("resume consumer lease prevents duplicate processes and rejects retired sessions", () => {
  const f = fixture();
  try {
    const { store, peer, b } = f;
    assert(store.acquireResume(b.id, b.sessionId, "first", 1000));
    assert(!peer.acquireResume(b.id, b.sessionId, "second", 1001));
    assert(peer.acquireResume(b.id, b.sessionId, "second", 16001));
    assert(!store.acquireResume(b.id, "wrong-session", "third", 40000));
    store.releaseResume(b.id, "first");
    assert(!store.acquireResume(b.id, b.sessionId, "first", 16002));
    store.setResumeEnabled(b.id, false, "stopped");
    assert(!store.acquireResume(b.id, b.sessionId, "second", 17000));
  } finally { f.cleanup(); }
});

test("first upgrade backfills actionable old records and triggers catch old writer SQL", () => {
  const f = fixture();
  try {
    const task = f.create();
    const sql = new DatabaseSync(f.store.dbPath);
    sql.exec("DROP TRIGGER handoff_resume_created; DROP TRIGGER handoff_resume_changed; DROP TRIGGER handoff_resume_dependency; DROP TABLE handoff_resume_events; DROP TABLE handoff_resume_state;");
    const upgraded = new HandoffStore(f.root);
    try {
      assert(upgraded.acquireResume(f.b.id, f.b.sessionId, "upgraded"));
      assert.equal(upgraded.pendingResume(f.b.id, "upgraded")!.events[0].taskId, task.id);
      // Raw legacy SQL, without calling any new extension method.
      sql.prepare("INSERT INTO handoff_task_events(task_id,actor,kind,data_json,at) VALUES(?,?,'reopen',?,?)")
        .run(task.id, f.a.id, JSON.stringify({ note: "legacy peer" }), new Date().toISOString());
      assert.equal(upgraded.pendingResume(f.b.id, "upgraded")!.events.at(-1)!.kind, "reopen");
    } finally { upgraded.close(); sql.close(); }
  } finally { f.cleanup(); }
});

function dispatcher(f: ReturnType<typeof fixture>, entries: unknown[] = []) {
  let idle = true, pendingMessages = false, editor = "";
  const sent: any[] = [], notices: string[] = [];
  const ctx: any = { mode: "rpc", isIdle: () => idle, hasPendingMessages: () => pendingMessages,
    ui: { notify: (text: string) => notices.push(text), getEditorText: () => editor }, sessionManager: { getEntries: () => entries } };
  const resume = new EventResume({ sendMessage: (message: any, options: any) => { sent.push({ ...message, options }); } } as any, f.store, f.b, ctx);
  resume.start();
  return { resume, sent, ctx, notices, idle: (v: boolean) => idle = v,
    persist: (message: any) => {
      entries.push({ type: "custom_message", customType: message.customType, details: message.details });
      resume.observeMessage({ role: "custom", ...message });
    },
    queued: (v: boolean) => pendingMessages = v, editor: (v: string) => editor = v };
}

test("idle dispatch batches events without task text; busy/UI/editor states defer, durable message deduplicates reload", () => {
  const f = fixture();
  const d = dispatcher(f);
  try {
    f.create(); f.create();
    d.idle(false); d.resume.tick(); assert.equal(d.sent.length, 0);
    d.idle(true); d.queued(true); d.resume.tick(); assert.equal(d.sent.length, 0);
    d.queued(false); d.resume.uiWaiting(true); d.resume.tick(); assert.equal(d.sent.length, 0);
    d.resume.uiWaiting(false); d.ctx.mode = "tui"; d.editor("draft"); d.resume.tick(); assert.equal(d.sent.length, 0);
    d.editor(""); d.resume.tick();
    assert.equal(d.sent.length, 1);
    assert.match(d.sent[0].content, /#1 created.*#2 created/);
    assert.doesNotMatch(d.sent[0].content, /Authorized project work|deliver/);
    assert.deepEqual(d.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
    d.resume.tick(); assert.equal(d.sent.length, 1);
    const delivered = d.sent[0];
    // Simulate a crash after the custom message persisted and both tasks were
    // completed, before our observer acknowledged the cursor. Recovery must not
    // replay delivered work that is now waiting for the creator.
    f.complete(1); f.complete(2);
    d.resume.stop();
    const restored = dispatcher(f, [{ type: "custom_message", customType: delivered.customType, details: delivered.details }]);
    try {
      restored.resume.tick(); assert.equal(restored.sent.length, 0);
      assert.equal(f.store.resumeStatus(f.b.id).pendingEvents, 0);
      f.create(); restored.resume.tick(); assert.equal(restored.sent.length, 1);
      restored.resume.observeMessage({ role: "custom", ...restored.sent[0] });
      restored.resume.tick();
      assert.equal(f.store.resumeStatus(f.b.id).pendingEvents, 1, "message_end alone precedes durable persistence");
      restored.persist(restored.sent[0]);
      restored.resume.tick(); assert.equal(restored.sent.length, 1);
      assert.equal(f.store.resumeStatus(f.b.id).pendingEvents, 0);
    } finally { restored.resume.stop(); }
  } finally { d.resume.stop(); f.cleanup(); }
});

test("abort and model failure persistently pause event runs without discarding pending work", () => {
  const f = fixture();
  const d = dispatcher(f);
  try {
    d.resume.settled(true);
    f.create(); d.resume.tick(); assert.equal(d.sent.length, 0);
    assert.equal(f.store.resumeStatus(f.b.id).enabled, false);
    f.store.setResumeEnabled(f.b.id, true);
    d.resume.tick(); assert.equal(d.sent.length, 1);
    d.persist(d.sent[0]);
    d.resume.tick();
    d.resume.runStarted();
    d.resume.observeMessage({ role: "assistant", stopReason: "error", errorMessage: "provider 502" });
    d.resume.settled(false);
    assert.equal(f.store.resumeStatus(f.b.id).enabled, false);
    f.create(); d.resume.tick(); assert.equal(d.sent.length, 1);
    assert.equal(f.store.resumeStatus(f.b.id).pendingEvents, 1);
    assert.equal(d.notices.length, 2);
    f.store.setResumeEnabled(f.b.id, true);
    d.resume.tick(); assert.equal(d.sent.length, 2);
    // Recovery rechecks both the failed, already-delivered task and the task
    // that arrived while paused. Repeated enabling cannot manufacture a loop.
    assert.match(d.sent[1].content, /#1 created/);
    assert.match(d.sent[1].content, /#2 created/);
    d.persist(d.sent[1]);
    d.resume.tick();
    f.store.setResumeEnabled(f.b.id, true);
    d.resume.tick(); assert.equal(d.sent.length, 2);
  } finally { d.resume.stop(); f.cleanup(); }
});

test("checkpoints persist once per task revision and only target this side's work", () => {
  const f = fixture();
  try {
    const task = f.create();
    assert(f.store.acquireResume(f.b.id, f.b.sessionId, "b"));
    let batch = f.store.pendingResume(f.b.id, "b")!;
    f.store.acknowledgeResume(f.b.id, "b", batch.throughSeq);
    assert.deepEqual(f.store.reconcileResume(f.b.id, "b"), { queued: [task.id], stalled: [] });
    batch = f.store.pendingResume(f.b.id, "b")!;
    assert.deepEqual(batch.events.map(e => [e.taskId, e.kind]), [[task.id, "checkpoint"]]);
    f.store.acknowledgeResume(f.b.id, "b", batch.throughSeq);
    f.peer.check(task.id, f.b.id, 1, false); // A no-op is not a new revision.
    assert.deepEqual(f.peer.reconcileResume(f.b.id, "b"), { queued: [], stalled: [task.id] });
    f.peer.check(task.id, f.b.id, 1, true);
    assert.deepEqual(f.store.reconcileResume(f.b.id, "b"), { queued: [task.id], stalled: [] });
    f.complete(task.id);
    assert.deepEqual(f.store.pendingResume(f.b.id, "b")!.events, [], "completed work supersedes its checkpoint");
    assert.deepEqual(f.store.reconcileResume(f.b.id, "b"), { queued: [], stalled: [] });
    assert(f.store.acquireResume(f.a.id, f.a.sessionId, "a"));
    assert.deepEqual(f.store.reconcileResume(f.a.id, "a"), { queued: [task.id], stalled: [] }, "creator still needs to review");
    assert(f.store.acquireResume(f.c.id, f.c.sessionId, "c"));
    assert.deepEqual(f.store.reconcileResume(f.c.id, "c"), { queued: [], stalled: [] });
    f.store.setResumeEnabled(f.a.id, false);
    assert.deepEqual(f.store.reconcileResume(f.a.id, "a"), { queued: [], stalled: [] }, "pause blocks reconciliation");
    assert.deepEqual(f.store.reconcileResume(f.b.id, "wrong-consumer"), { queued: [], stalled: [] });
  } finally { f.cleanup(); }
});

test("checkpoints leave recorded blockers alone and recheck changed dependencies", () => {
  const f = fixture();
  try {
    const task = f.create();
    const dependency = f.create(f.b.id, f.a.id);
    assert(f.store.acquireResume(f.b.id, f.b.sessionId, "b"));
    f.store.block(task.id, f.b.id, "Need the real input", "a", [dependency.id]);
    assert.deepEqual(f.store.reconcileResume(f.b.id, "b"), { queued: [], stalled: [] });
    f.complete(dependency.id, f.a.id);
    assert(f.store.reconcileResume(f.b.id, "b").queued.includes(task.id));
    f.store.block(task.id, f.b.id, "Delivered input still lacks approval", "user", []);
    assert(!f.store.pendingResume(f.b.id, "b")!.events.some(e => e.taskId === task.id));
    assert(!f.store.reconcileResume(f.b.id, "b").stalled.includes(task.id));
  } finally { f.cleanup(); }
});

test("startup and settled checkpoints resume once, warn without looping, and survive reload", () => {
  const f = fixture();
  const task = f.create();
  assert(f.store.acquireResume(f.b.id, f.b.sessionId, "previous"));
  f.store.acknowledgeResume(f.b.id, "previous", f.store.pendingResume(f.b.id, "previous")!.throughSeq);
  f.store.releaseResume(f.b.id, "previous");
  const entries: unknown[] = [];
  const d = dispatcher(f, entries);
  try {
    d.resume.tick();
    assert.equal(d.sent.length, 1, "reload discovers unclosed work even when old events were consumed");
    assert.match(d.sent[0].content, /#1 checkpoint/);
    d.persist(d.sent[0]); d.resume.tick();
    d.resume.runStarted(); d.resume.settled(false);
    assert.equal(d.sent.length, 1, "the unchanged task cannot loop");
    assert.match(d.notices.at(-1)!, /仍未收口.*#1/);
    d.resume.stop();
    const restored = dispatcher(f, entries);
    try {
      restored.resume.tick(); assert.equal(restored.sent.length, 0, "checkpoint deduplication is durable");
      f.peer.check(task.id, f.b.id, 1, true);
      restored.resume.runStarted(); restored.resume.settled(false);
      assert.equal(restored.sent.length, 1, "real progress permits a new completion checkpoint");
      restored.persist(restored.sent[0]); restored.resume.tick();
      f.peer.block(task.id, f.b.id, "Need explicit approval", "user", []);
      restored.resume.runStarted(); restored.resume.settled(false);
      assert.equal(restored.sent.length, 1, "a genuine recorded blocker stops cleanly");
    } finally { restored.resume.stop(); }
  } finally { d.resume.stop(); f.cleanup(); }
});

test("settled checks all active pages and never retries sent work", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 102; i++) f.create();
    f.create(f.b.id, f.a.id); // This side waits for the assignee.
    assert(f.store.acquireResume(f.b.id, f.b.sessionId, "b"));
    const result = f.store.reconcileResume(f.b.id, "b");
    assert.equal(result.queued.length, 102);
    assert.equal(new Set(result.queued).size, 102);
    assert.deepEqual(result.stalled, []);
  } finally { f.cleanup(); }
});

test("storage failure stops the scheduler locally without repeated timer errors", () => {
  const f = fixture();
  const d = dispatcher(f);
  try {
    f.store.acquireResume = () => { throw new Error("database unavailable"); };
    f.store.setResumeEnabled = () => { throw new Error("database unavailable"); };
    assert.doesNotThrow(() => d.resume.tick());
    assert.match(d.notices[0], /执行 \/reload/);
    d.resume.tick();
    assert.equal(d.notices.length, 1);
    assert.equal(d.sent.length, 0);
  } finally { d.resume.stop(); f.cleanup(); }
});
