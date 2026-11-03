import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { HandoffStore } from "../store.ts";
import type { Side } from "../types.ts";

const A: Side = { id: "a", name: "planner", sessionId: "sa", pid: 1, worktree: "/a", branch: "main" };
const B: Side = { ...A, id: "b", name: "backend", sessionId: "sb", pid: 2 };
const C: Side = { ...A, id: "c", name: "frontend", sessionId: "sc", pid: 3 };
const commit = "a".repeat(40);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-handoff-task-"));
  const store = new HandoffStore(root);
  for (const side of [A, B, C]) store.register(side);
  return { root, store, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const input = { to: "b", subject: "contract", body: "private contract", items: ["implement", "commit"] };

test("only creator and assignee can list/read/update; checklist, commit and review have separate owners", () => {
  const f = fixture();
  try {
    const task = f.store.create(input, A.id);
    assert.equal(f.store.list(B.id).tasks[0].id, task.id);
    assert.deepEqual(f.store.list(C.id).tasks, []);
    assert.equal(f.store.status(C.id).visibleTasks, 0);
    assert.throws(() => f.store.read(task.id, C.id), /not found or not visible/);
    assert.throws(() => f.store.check(task.id, C.id, 1, true), /not found or not visible/);
    assert.throws(() => f.store.complete(task.id, C.id, commit, "done"), /not found or not visible/);
    assert.throws(() => f.store.closeTask(task.id, C.id, commit, "reviewed"), /not found or not visible/);
    assert.throws(() => f.store.check(task.id, A.id, 1, true), /Only the assignee/);
    assert.throws(() => f.store.closeTask(task.id, A.id, commit, "too early"), /Reviewed commit/);
    assert.throws(() => f.store.complete(task.id, B.id, commit, "not checked"), /Check every item/);
    for (const item of [1, 2]) f.store.check(task.id, B.id, item, true);
    assert.equal(f.store.complete(task.id, B.id, commit, "done").state, "completed");
    assert.throws(() => f.store.check(task.id, B.id, 1, false), /open task/);
    assert.throws(() => f.store.closeTask(task.id, B.id, commit, "reviewed"), /Only the creator/);
    assert.throws(() => f.store.closeTask(task.id, A.id, "b".repeat(40), "wrong commit"), /Reviewed commit/);
    const closed = f.store.closeTask(task.id, A.id, commit, "diff reviewed");
    assert.equal(closed.state, "closed");
    assert.equal(closed.reviewNote, "diff reviewed");
    assert.deepEqual(closed.events.map((event) => event.kind), ["check", "check", "complete", "close"]);
    assert.equal(f.store.list(A.id).tasks.length, 1);
    assert.equal(f.store.list(A.id, { activeOnly: true }).tasks.length, 0);
    const db = new DatabaseSync(f.store.dbPath);
    try {
      assert.throws(() => db.exec("DELETE FROM handoff_tasks"), /append-only/);
      assert.throws(() => db.exec("UPDATE handoff_task_events SET kind='close'"), /append-only/);
    } finally { db.close(); }
  } finally { f.close(); }
});

test("restart, role rename and review return preserve identity and append-only evidence", () => {
  const f = fixture();
  try {
    const first = f.store.create({ ...input, idempotencyKey: "contract-v1" }, A.id);
    f.store.check(first.id, B.id, 1, true); f.store.check(first.id, B.id, 2, true);
    f.store.complete(first.id, B.id, commit, "attempt one");
    f.store.close();
    const resumed = new HandoffStore(f.root);
    try {
      resumed.register({ ...B, name: "data platform", pid: 9000, branch: "task/another" });
      assert.equal(resumed.read(first.id, B.id).assignee.name, "data platform");
      assert.equal(resumed.create({ ...input, idempotencyKey: "contract-v1" }, A.id).id, first.id);
      assert.throws(() => resumed.create({ ...input, body: "changed", idempotencyKey: "contract-v1" }, A.id), /different content/);
      const returned = resumed.reopen(first.id, A.id, "missing edge case");
      assert.equal(returned.state, "open");
      assert.equal(returned.items.some((item) => item.checked), false);
      assert.equal(returned.commit, null);
      assert.equal(returned.events.some((event) => event.kind === "complete" && event.data.commit === commit), true);
      resumed.check(first.id, B.id, 1, true); resumed.check(first.id, B.id, 2, true);
      resumed.complete(first.id, B.id, "b".repeat(40), "attempt two");
      assert.equal(resumed.closeTask(first.id, A.id, "b".repeat(40), "verified").state, "closed");
    } finally { resumed.close(); }
  } finally { f.close(); }
});

test("arbitrary sides, ambiguous names, invalid checklist and pagination", () => {
  const f = fixture();
  try {
    f.store.register({ ...C, name: B.name });
    assert.throws(() => f.store.create({ ...input, to: B.name }, A.id), /ambiguous/);
    assert.throws(() => f.store.create({ ...input, to: A.id }, A.id), /another side/);
    assert.throws(() => f.store.create({ ...input, items: [] }, A.id), /checklist/);
    for (let i = 0; i < 3; i++) f.store.create({ ...input, subject: `task ${i}` }, A.id);
    const first = f.store.list(A.id, { limit: 2 });
    assert.deepEqual(first.tasks.map((task) => task.id), [3, 2]);
    assert.equal(first.nextBefore, 2);
    assert.deepEqual(f.store.list(B.id, { before: first.nextBefore!, limit: 2 }).tasks.map((task) => task.id), [1]);
    assert.equal(f.store.list(C.id).nextBefore, null);
    assert.throws(() => f.store.check(1, B.id, 99, true), /Unknown checklist/);
    assert.throws(() => f.store.complete(1, B.id, "fake", "done"), /full Git/);
  } finally { f.close(); }
});

test("human project overview paginates every task while side views retain sent and received tasks", () => {
  const f = fixture();
  try {
    const sent = f.store.create(input, A.id);
    const received = f.store.create({ ...input, to: A.id, subject: "reply" }, B.id);
    const unrelated = f.store.create({ ...input, subject: "other sides" }, C.id);
    const first = f.store.listForHumanUi({ limit: 2 });
    assert.deepEqual(first.tasks.map((task) => task.id), [sent.id, received.id]);
    assert.equal(first.nextAfter, received.id);
    assert.deepEqual(f.store.listForHumanUi({ after: first.nextAfter!, limit: 2 }).tasks.map((task) => task.id), [unrelated.id]);
    assert.deepEqual(f.store.listForHumanUi({ actor: A.id }).tasks.map((task) => task.id), [sent.id, received.id]);
    assert.deepEqual(f.store.list(A.id).tasks.map((task) => task.id), [received.id, sent.id]);
    assert.throws(() => f.store.read(unrelated.id, A.id), /not found or not visible/);
    assert.throws(() => f.store.listForHumanUi({ limit: 101 }), /Limit/);
  } finally { f.close(); }
});

test("human status sorting spans pages, reverses status groups, and follows returned tasks", () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 6; i++) {
      const task = f.store.create({ ...input, subject: `task ${i}` }, A.id);
      if (i % 3 !== 0) {
        f.store.check(task.id, B.id, 1, true); f.store.check(task.id, B.id, 2, true);
        f.store.complete(task.id, B.id, commit, "done");
        if (i % 3 === 1) f.store.closeTask(task.id, A.id, commit, "reviewed");
      }
    }
    const unrelated = f.store.create({ ...input, subject: "other sides" }, C.id);
    for (const [sort, expected] of [
      ["pending", [3, 6, 2, 5, 1, 4]],
      ["reviewed", [1, 4, 2, 5, 3, 6]],
    ] as const) {
      const ids: number[] = [];
      let after: number | null = null;
      do {
        const page = f.store.listForHumanUi({ actor: A.id, sort, limit: 2, after: after ?? undefined });
        ids.push(...page.tasks.map((task) => task.id));
        after = page.nextAfter;
      } while (after !== null);
      assert.deepEqual(ids, [...expected]);
    }
    assert.deepEqual(f.store.listForHumanUi({ sort: "pending" }).tasks.map((task) => task.id), [3, 6, unrelated.id, 2, 5, 1, 4]);
    f.store.reopen(2, A.id, "needs changes");
    assert.deepEqual(f.store.listForHumanUi({ actor: A.id, sort: "pending" }).tasks.map((task) => task.id), [2, 3, 6, 5, 1, 4]);
    assert.deepEqual(f.store.listForHumanUi({ actor: A.id }).tasks.map((task) => task.id), [1, 2, 3, 4, 5, 6]);
    assert.throws(() => f.store.read(unrelated.id, A.id), /not found or not visible/);
  } finally { f.close(); }
});

test("human snapshots do not skip or duplicate tasks during completion, return, creation and review", () => {
  for (const sort of ["id", "pending", "reviewed"] as const) for (const actor of [undefined, A.id]) {
    const f = fixture(), writer = new HandoffStore(f.root);
    try {
      for (let i = 0; i < 36; i++) {
        const task = f.store.create({ ...input, body: "x".repeat(16000) }, A.id);
        if (i % 3 !== 0) {
          for (const item of [1, 2]) f.store.check(task.id, B.id, item, true);
          f.store.complete(task.id, B.id, commit, "done");
          if (i % 3 === 2) f.store.closeTask(task.id, A.id, commit, "reviewed");
        }
      }
      f.store.create({ ...input, subject: "unrelated" }, C.id);
      const before = f.store.listForHumanUi({ actor, sort, limit: 100 });
      const first = f.store.listForHumanUi({ actor, sort, limit: 5 });
      // Move the cursor and an earlier entry between state groups.
      const change = (id: number) => {
        const task = writer.read(id, A.id);
        if (task.state === "completed") writer.reopen(id, A.id, "changes");
        else if (task.state === "open") {
          for (const item of [1, 2]) writer.check(id, B.id, item, true);
          writer.complete(id, B.id, commit, "done");
        }
      };
      change(first.nextAfter!); change(first.tasks[0].id);
      writer.closeTask(2, A.id, commit, "reviewed concurrently");
      writer.create({ ...input, subject: "created after snapshot" }, A.id);
      const actual = [...first.tasks];
      let after = first.nextAfter;
      while (after !== null) {
        const page = f.store.listForHumanUi({ actor, sort, limit: 5, after, snapshot: first.snapshot });
        actual.push(...page.tasks); after = page.nextAfter;
      }
      assert.deepEqual(actual, before.tasks);
      assert.equal(new Set(actual.map((task) => task.id)).size, actual.length);
      assert.throws(() => f.store.listForHumanUi({ actor: C.id, snapshot: first.snapshot }), /another view/);
      const refreshed = f.store.listForHumanUi({ actor, sort, limit: 100 });
      assert.equal(refreshed.tasks.length, before.tasks.length + 1);
      assert.equal(refreshed.tasks.find((task) => task.id === 2)!.state, "closed");
    } finally { writer.close(); f.close(); }
  }
});

test("human pages load only their own task details and reuse the ordering snapshot", () => {
  const f = fixture();
  const original = DatabaseSync.prototype.prepare;
  try {
    for (let i = 0; i < 150; i++) f.store.create({ ...input, body: "x".repeat(16000) }, A.id);
    const sql: string[] = [];
    DatabaseSync.prototype.prepare = function (query: string) { sql.push(query); return original.call(this, query); };
    const first = f.store.listForHumanUi({ sort: "pending", limit: 30 });
    assert.equal(first.tasks.length, 30);
    assert(sql.length <= 35, `first page used ${sql.length} queries`);
    assert.equal(sql.filter((query) => query.startsWith("SELECT * FROM handoff_task_events")).length, 30);
    assert.equal(sql.filter((query) => query.startsWith("SELECT * FROM handoff_tasks")).length, 1);
    sql.length = 0;
    const second = f.store.listForHumanUi({ sort: "pending", limit: 30, after: first.nextAfter!, snapshot: first.snapshot });
    assert.equal(second.tasks[0].id, 31);
    assert(sql.length <= 32, `next page used ${sql.length} queries`);
    assert(!sql.some((query) => query.includes("state_rank")));
    assert.equal(sql.filter((query) => query.startsWith("SELECT * FROM handoff_task_events")).length, 30);
  } finally { DatabaseSync.prototype.prepare = original; f.close(); }
});

test("original V3/board records are retained and never published to new unrelated sides", () => {
  const f = fixture(); f.store.close();
  const db = new DatabaseSync(f.store.dbPath);
  db.exec("CREATE TABLE messages(body TEXT); INSERT INTO messages VALUES('old private'); CREATE TABLE board_entries(body TEXT); INSERT INTO board_entries VALUES('original board');");
  db.close();
  const reopened = new HandoffStore(f.root);
  try {
    assert.equal(reopened.list(C.id).tasks.length, 0);
    const original = new DatabaseSync(f.store.dbPath);
    try {
      assert.equal(original.prepare("SELECT body FROM messages").get()?.body, "old private");
      assert.equal(original.prepare("SELECT body FROM board_entries").get()?.body, "original board");
    } finally { original.close(); }
  } finally { reopened.close(); f.close(); }
});

test("four processes append tasks concurrently without overwrites or duplicate logical actions", async () => {
  const f = fixture();
  try {
    await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, "concurrency-worker.ts"), f.root, String(index), "8"], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = ""; child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
    })));
    const tasks = f.store.list(A.id, { limit: 100 }).tasks;
    assert.equal(tasks.length, 33);
    assert.equal(new Set(tasks.map((task) => task.id)).size, 33);
    assert.equal(tasks.filter((task) => task.subject === "shared retry").length, 1);
    assert.equal(f.store.list(C.id).tasks.length, 0);
    assert.equal(f.store.status(A.id).integrity, "ok");
  } finally { f.close(); }
});
