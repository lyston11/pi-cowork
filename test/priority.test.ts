import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HandoffStore } from "../store.ts";
import { taskLines } from "../ui.ts";

const side = (id: string, root: string) => ({ id, name: id, sessionId: `session-${id}`, pid: process.pid, worktree: root, branch: "main" });

test("priority defaults old-style and omitted tasks to normal, sorts within status, and notifies the other participant", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-cowork-priority-"));
  const store = new HandoffStore(root), peer = new HandoffStore(root);
  const creator = side("creator", root), assignee = side("assignee", root);
  try {
    store.register(creator); store.register(assignee);
    const make = (subject: string, priority?: "urgent" | "high" | "normal" | "low") =>
      peer.create({ to: assignee.id, subject, body: subject, items: ["deliver"], refs: [], requiresIntegration: false, ...(priority ? { priority } : {}) }, creator.id);
    const normal = make("default");
    const high = make("high", "high");
    const low = make("low", "low");
    const urgent = make("urgent", "urgent");
    assert.deepEqual([normal, high, low, urgent].map(task => task.priority), ["normal", "high", "low", "urgent"]);
    const theme = { fg: (_color: string, value: string) => value } as any;
    assert.match(taskLines(normal, false, theme, 120)[0], /\[P2 普通\]/);
    assert.match(taskLines(urgent, false, theme, 120)[0], /\[P0 紧急\]/);
    assert.deepEqual(store.listForHumanUi({ sort: "pending", limit: 10 }).tasks.map(task => task.id), [urgent.id, high.id, normal.id, low.id]);

    assert(store.acquireResume(assignee.id, assignee.sessionId, "assignee"));
    store.acknowledgeResume(assignee.id, "assignee", store.pendingResume(assignee.id, "assignee")!.throughSeq);
    peer.setPriority(normal.id, creator.id, "urgent");
    assert.equal(store.read(normal.id, assignee.id).priority, "urgent");
    assert.deepEqual(store.pendingResume(assignee.id, "assignee")!.events.map(event => [event.taskId, event.kind]), [[normal.id, "priority"]]);
    peer.setPriority(normal.id, assignee.id, "low");
    assert.deepEqual(peer.listForHumanUi({ sort: "pending", limit: 10 }).tasks.map(task => task.id), [urgent.id, high.id, normal.id, low.id]);
    peer.check(normal.id, assignee.id, 1, true);
    const completed = peer.complete(normal.id, assignee.id, "a".repeat(40), "done");
    assert.equal(peer.setPriority(normal.id, creator.id, "high").priority, "high");
    peer.closeTask(normal.id, creator.id, "a".repeat(40), "reviewed");
    assert.throws(() => peer.setPriority(normal.id, assignee.id, "urgent"), /closed/);
    assert.equal(completed.priority, "low");
  } finally { peer.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
