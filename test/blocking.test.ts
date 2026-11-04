import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { HandoffStore } from "../store.ts";
import { taskLines } from "../ui.ts";
import type { Side } from "../types.ts";

const A: Side = { id: "a", name: "发起侧", sessionId: "a", pid: 1, worktree: "/a", branch: "main" };
const B: Side = { ...A, id: "b", name: "工具侧", sessionId: "b", pid: 2 };
const C: Side = { ...A, id: "c", name: "数据侧", sessionId: "c", pid: 3 };
const commit = "a".repeat(40);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-blocked-"));
  const store = new HandoffStore(root);
  for (const side of [A, B, C]) store.register(side);
  const peer = new HandoffStore(root);
  return { root, store, peer,
    create: (creator = A.id, assignee = B.id, subject = "main") => store.create({ to: assignee, subject, body: "private body", items: ["done"] }, creator),
    finish: (id: number, actor = B.id) => { peer.check(id, actor, 1, true); peer.complete(id, actor, commit, "done"); },
    close() { peer.close(); store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("block records are assignee-owned, private, validated, append-only and preserve checklist progress", () => {
  const f = fixture();
  try {
    const task = f.create();
    const hidden = f.create(A.id, C.id, "hidden input");
    assert.equal(task.block, null, "old records remain unclassified, not silently blocked");
    assert.throws(() => f.store.block(task.id, A.id, "missing", "data"), /Only the assignee/);
    assert.throws(() => f.store.block(task.id, C.id, "missing", "data"), /not found or not visible/);
    assert.throws(() => f.store.block(task.id, B.id, "", "data"), /Block reason/);
    assert.throws(() => f.store.block(task.id, B.id, "missing", ""), /Waiting for/);
    assert.throws(() => f.store.block(task.id, B.id, "missing", "data", [task.id]), /itself/);
    assert.throws(() => f.store.block(task.id, B.id, "missing", "data", [hidden.id]), /not found or not visible/);
    const dependency = f.create(B.id, A.id);
    assert.throws(() => f.store.block(task.id, B.id, "missing", "data", [dependency.id, dependency.id]), /unique/);
    const blocked = f.store.block(task.id, B.id, "缺批准；批准后继续", "业务审核人");
    assert.equal(blocked.block?.waitingFor, "业务审核人");
    assert.equal(blocked.state, "open");
    assert.equal(f.store.block(task.id, B.id, "缺批准；批准后继续", "业务审核人").events.length, blocked.events.length);
    f.store.check(task.id, B.id, 1, true);
    assert.throws(() => f.store.complete(task.id, B.id, commit, "not actually ready"), /unblock/);
    assert.throws(() => f.store.unblock(task.id, A.id, "override"), /Only the assignee/);
    assert.throws(() => f.store.read(task.id, C.id), /not found or not visible/);
    const resumed = new HandoffStore(f.root);
    try { assert.equal(resumed.read(task.id, B.id).block?.reason, "缺批准；批准后继续"); }
    finally { resumed.close(); }
    assert.equal(f.store.unblock(task.id, B.id, "批准记录 refs/approval").items[0].checked, true);
    f.store.complete(task.id, B.id, commit, "done");
    assert.throws(() => f.store.block(task.id, B.id, "again", "data"), /open task/);
    const sql = new DatabaseSync(f.store.dbPath);
    try { assert.throws(() => sql.exec("DELETE FROM handoff_task_events WHERE kind='block'"), /append-only/); }
    finally { sql.close(); }
  } finally { f.close(); }
});

test("dependency deliveries wake only the current blocked task and require explicit recheck", () => {
  const f = fixture();
  try {
    const task = f.create();
    const dependency = f.create(B.id, C.id, "PRIVATE-DEPENDENCY");
    f.store.block(task.id, B.id, "等待输入交付", C.name, [dependency.id]);
    f.store.acquireResume(B.id, B.sessionId, "consumer");
    let batch = f.store.pendingResume(B.id, "consumer")!;
    assert.equal(batch.events.length, 0, "an unchanged blocker must not wake on old assignment");
    f.store.acknowledgeResume(B.id, "consumer", batch.throughSeq);
    f.finish(dependency.id, C.id);
    batch = f.store.pendingResume(B.id, "consumer")!;
    assert(batch.events.some((event) => event.taskId === task.id && event.kind === "dependency"));
    assert.equal(f.store.read(task.id, B.id).block?.needsReview, true);
    assert.equal(f.store.read(task.id, A.id).block?.needsReview, true);
    assert.throws(() => f.store.read(dependency.id, A.id), /not found or not visible/);
    assert(!JSON.stringify(f.store.read(task.id, A.id)).includes("PRIVATE-DEPENDENCY"));
    f.store.acknowledgeResume(B.id, "consumer", batch.throughSeq);
    assert.equal(f.store.pendingResume(B.id, "consumer"), null);
    // Rejecting a deliverable records the new watermark rather than repeatedly waking.
    f.store.block(task.id, B.id, "输入缺字段；等待补齐", C.name, [dependency.id]);
    assert.equal(f.store.read(task.id, B.id).block?.needsReview, false);
    assert.equal(f.store.pendingResume(B.id, "consumer"), null);
    f.peer.reopen(dependency.id, B.id, "missing field");
    assert(f.store.pendingResume(B.id, "consumer")!.events.some((event) => event.taskId === task.id));
    f.store.unblock(task.id, B.id, "inputs now verified");
    assert(!f.store.pendingResume(B.id, "consumer")!.events.some((event) => event.taskId === task.id));
    f.finish(task.id);
    f.peer.reopen(task.id, A.id, "needs fix");
    assert.equal(f.store.read(task.id, B.id).block, null);
  } finally { f.close(); }
});

test("dependency cycles are rejected and old writers still route dependency events transactionally", () => {
  const f = fixture();
  try {
    const task = f.create();
    const dependency = f.create(B.id, A.id);
    f.store.block(task.id, B.id, "input", A.name, [dependency.id]);
    assert.throws(() => f.store.block(dependency.id, A.id, "cycle", B.name, [task.id]), /cycle/);
    const sql = new DatabaseSync(f.store.dbPath);
    try {
      sql.prepare("INSERT INTO handoff_task_events(task_id,actor,kind,data_json,at) VALUES(?,?,'complete',?,?)")
        .run(dependency.id, A.id, JSON.stringify({ commit, summary: "legacy writer" }), new Date().toISOString());
      assert.equal(f.store.read(task.id, B.id).block?.needsReview, true);
      f.store.acquireResume(B.id, B.sessionId, "consumer");
      assert(f.store.pendingResume(B.id, "consumer")!.events.some((event) => event.kind === "dependency"));
    } finally { sql.close(); }
  } finally { f.close(); }
});

test("blocked sorting and dependency recheck use a stable snapshot across pages", () => {
  const f = fixture();
  try {
    const ready = f.create();
    const review = f.create(); f.finish(review.id);
    const blocked = f.create();
    const closed = f.create(); f.finish(closed.id); f.store.closeTask(closed.id, A.id, commit, "reviewed");
    const dependency = f.create(B.id, C.id);
    f.store.block(blocked.id, B.id, "等待数据", C.name, [dependency.id]);
    const first = f.store.listForHumanUi({ actor: A.id, sort: "pending", limit: 2 });
    assert.deepEqual(first.snapshot.ids, [ready.id, review.id, blocked.id, closed.id]);
    assert.deepEqual(f.store.listForHumanUi({ actor: A.id, sort: "reviewed" }).snapshot.ids, [closed.id, blocked.id, review.id, ready.id]);
    f.finish(dependency.id, C.id);
    const tail = f.store.listForHumanUi({ actor: A.id, sort: "pending", after: first.nextAfter!, snapshot: first.snapshot });
    assert.equal(tail.tasks[0].block?.needsReview, false, "later pages retain the original dependency watermark");
    const refreshed = f.store.listForHumanUi({ actor: A.id, sort: "pending" });
    assert.deepEqual(refreshed.snapshot.ids, [ready.id, blocked.id, review.id, closed.id]);
    assert.equal(refreshed.tasks[1].block?.needsReview, true);
    const theme: any = { fg: (_: string, text: string) => text, strikethrough: (text: string) => text };
    const waitingText = taskLines(tail.tasks[0], false, theme, 100).join("\n");
    assert.match(waitingText, /被阻塞[\s\S]*下一步：数据侧提供条件/);
    assert.match(waitingText, /阻塞：等待数据/);
    const recheckText = taskLines(refreshed.tasks[1], false, theme, 100).join("\n");
    assert.match(recheckText, /依赖更新待复核/);
    assert.match(recheckText, /下一步：工具侧复核依赖/);
    assert.match(taskLines(refreshed.tasks[2], false, theme, 100).join("\n"), /下一步：发起侧验收/);
  } finally { f.close(); }
});
