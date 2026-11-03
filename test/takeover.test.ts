import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { HandoffStore } from "../store.ts";
import type { Side } from "../types.ts";

const old: Side = { id: "old", name: "tools", sessionId: "old-session", pid: 2147483647, worktree: "/old", branch: "task/old" };
const lead: Side = { ...old, id: "lead", name: "lead", sessionId: "lead-session" };
const fresh: Side = { ...old, id: "fresh", name: "new Pi", sessionId: "new-session", pid: process.pid, worktree: "/new", branch: "task/new" };
const third: Side = { ...old, id: "third", name: "other", sessionId: "third-session" };
const commit = "a".repeat(40);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-takeover-"));
  const store = new HandoffStore(root);
  for (const side of [old, lead, fresh, third]) store.register(side);
  return { root, store, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const taskInput = { to: old.id, subject: "Continue implementation", body: "private", items: ["implement", "commit"] };

test("takeover preserves both task roles, history and stable identity across restart; replaced session is revoked", () => {
  const f = fixture();
  try {
    const received = f.store.create(taskInput, lead.id);
    const sent = f.store.create({ ...taskInput, to: lead.id }, old.id);
    f.store.check(received.id, old.id, 1, true);
    for (const item of [1, 2]) f.store.check(sent.id, lead.id, item, true);
    f.store.complete(sent.id, lead.id, commit, "review me");
    const originalEvents = f.store.read(received.id, old.id).events;
    const inherited = f.store.takeover(fresh, old.id, old.sessionId, "User asked to inherit stopped tools side");
    assert.equal(inherited.id, old.id);
    assert.equal(inherited.name, old.name);
    assert.equal(inherited.sessionId, fresh.sessionId);
    assert.deepEqual(f.store.list(inherited.id).tasks.map((task) => task.id), [sent.id, received.id]);
    assert.deepEqual(f.store.read(received.id, inherited.id).events, originalEvents);
    assert.equal(f.store.read(received.id, inherited.id).items[0].checked, true);
    assert.equal(f.store.sides().some((side) => side.id === fresh.id), false);
    assert.throws(() => f.store.read(received.id, third.id), /not found or not visible/);
    assert.throws(() => f.store.register(old), /replaced/);
    assert.throws(() => f.store.register(fresh), /inherited identity/);
    const legacy = new DatabaseSync(f.store.dbPath);
    try {
      assert.throws(() => legacy.prepare("UPDATE handoff_sides SET session_id=?,pid=? WHERE id=?").run(old.sessionId, old.pid, old.id), /ownership transferred/);
      assert.throws(() => legacy.exec("DELETE FROM handoff_side_transfers"), /append-only/);
    } finally { legacy.close(); }
    f.store.close();
    const resumed = new HandoffStore(f.root);
    try {
      assert.equal(resumed.sessionSide(fresh.sessionId)?.id, old.id);
      assert.throws(() => resumed.sessionSide(old.sessionId), /replaced/);
      resumed.register({ ...inherited, branch: "task/next" });
      resumed.check(received.id, inherited.id, 2, true);
      assert.equal(resumed.complete(received.id, inherited.id, commit, "inherited implementation").state, "completed");
      assert.equal(resumed.closeTask(sent.id, inherited.id, commit, "inherited review").state, "closed");
      const status = resumed.status(inherited.id);
      assert.equal((status.takeovers as any[]).length, 1);
      assert.equal((status.takeovers as any[])[0].from_session, old.sessionId);
      assert.equal(status.integrity, "ok");
    } finally { resumed.close(); }
  } finally { f.close(); }
});

test("takeover refuses live PIDs, stale ownership, unknown IDs and dropping the new side's own tasks", () => {
  const f = fixture();
  try {
    f.store.register({ ...old, pid: process.pid });
    assert.throws(() => f.store.takeover(fresh, old.id, old.sessionId, "user request"), /still running/);
    f.store.register(old);
    assert.throws(() => f.store.takeover(fresh, old.id, "outdated-session", "user request"), /ownership changed/);
    assert.throws(() => f.store.takeover(fresh, "missing", old.sessionId, "user request"), /not found/);
    assert.throws(() => f.store.takeover(fresh, old.id, old.sessionId, ""), /reason/);
    const own = f.store.create({ ...taskInput, to: fresh.id }, lead.id);
    for (const item of [1, 2]) f.store.check(own.id, fresh.id, item, true);
    f.store.complete(own.id, fresh.id, commit, "own work");
    f.store.closeTask(own.id, lead.id, commit, "reviewed");
    assert.throws(() => f.store.takeover(fresh, old.id, old.sessionId, "user request"), /already owns tasks/);
    assert.equal(f.store.sessionSide(old.sessionId)?.id, old.id);
    assert.equal((f.store.status(old.id).takeovers as any[]).length, 0);
  } finally { f.close(); }
});

test("concurrent processes cannot both inherit the same observed owner", async () => {
  const f = fixture();
  try {
    f.store.create(taskInput, lead.id);
    const code = `
      import { HandoffStore } from ${JSON.stringify(new URL("../store.ts", import.meta.url).href)};
      const store = new HandoffStore(process.argv[1]);
      const side = { id: process.argv[2], sessionId: process.argv[2], name: 'claimant', pid: process.pid, worktree: '/new', branch: 'new' };
      try {
        store.register(side);
        store.takeover(side, 'old', 'old-session', 'User authorized takeover');
        console.log('won');
      } catch (error) { console.log(String(error)); }
      finally { store.close(); }
    `;
    const claim = (name: string) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code, f.root, name], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", (data) => out += data); child.stderr.on("data", (data) => err += data);
      child.on("error", reject); child.on("close", (exit) => exit === 0 ? resolve(out) : reject(new Error(err)));
    });
    const results = await Promise.all([claim("claim-one"), claim("claim-two")]);
    assert.equal(results.filter((out) => out.trim() === "won").length, 1);
    assert(results.some((out) => /ownership changed/.test(out)));
    assert.equal((f.store.status(old.id).takeovers as any[]).length, 1);
    assert.equal(f.store.list(old.id).tasks.length, 1);
  } finally { f.close(); }
});
