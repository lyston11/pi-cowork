import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { HandoffStore } from '../store.ts';
import { taskLines } from '../ui.ts';

const commit = 'a'.repeat(40);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-cowork-local-'));
  const store = new HandoffStore(root);
  for (const id of ['a', 'b', 'c']) store.register({ id, name: id, sessionId: id, pid: process.pid, worktree: root, branch: 'main' });
  const create = (to?: string) => store.create({ ...(to === undefined ? {} : { to }), subject: 'authorized work', body: 'Do the assigned work', items: ['implement'], requiresIntegration: false }, 'a');
  const drain = (actor: string) => {
    const consumer = 'consumer-' + actor;
    assert(store.acquireResume(actor, actor, consumer));
    const result = [];
    for (let batch; (batch = store.pendingResume(actor, consumer));) {
      result.push(...batch.events); store.acknowledgeResume(actor, consumer, batch.throughSeq);
    }
    return result;
  };
  return { root, store, create, drain, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('omitting to or explicitly assigning self creates a private local task, not a forced delegation', () => {
  const f = fixture(); try {
    const local = f.create(), explicit = f.create('a'), peer = f.create('b');
    for (const task of [local, explicit]) {
      assert.equal(task.kind, 'local'); assert.equal(task.creator.id, 'a'); assert.equal(task.assignee.id, 'a');
      assert.throws(() => f.store.read(task.id, 'b'), /not found or not visible/);
      assert.throws(() => f.store.read(task.id, 'c'), /not found or not visible/);
    }
    assert.equal(peer.kind, 'handoff');
    assert.equal(f.store.list('a').tasks.length, 3);
    assert.deepEqual(f.store.list('b').tasks.map(t => t.id), [peer.id]);
    assert.throws(() => f.create(''), /Assignee/);
    assert.throws(() => f.create('missing'), /not found/);
  } finally { f.close(); }
});

test('a single owner can implement, revise, verify and close; self-verification is not peer review', () => {
  const f = fixture(); try {
    const t = f.create();
    f.store.block(t.id, 'a', 'external input missing', 'user');
    assert.deepEqual(f.drain('a'), [], 'a local blocker is not a report to another side');
    f.store.unblock(t.id, 'a', 'input verified'); f.store.check(t.id, 'a', 1, true);
    f.store.complete(t.id, 'a', commit, 'implemented');
    assert.equal(f.store.read(t.id, 'a').state, 'completed');
    assert.deepEqual(f.drain('a'), [], 'local lifecycle writes do not loop back as peer events');
    assert.deepEqual(f.store.reconcileResume('a', 'consumer-a').queued, [t.id], 'unfinished local verification is actionable');
    f.drain('a');
    f.store.reopen(t.id, 'a', 'one fix needed'); assert.equal(f.store.read(t.id, 'a').items[0].checked, false);
    f.store.check(t.id, 'a', 1, true); f.store.complete(t.id, 'a', commit, 'fixed');
    const closed = f.store.closeTask(t.id, 'a', commit, 'self-verified within user authorization');
    assert.equal(closed.state, 'closed'); assert.equal(closed.events.at(-1)!.data.reviewMode, 'self');
    assert.deepEqual(f.drain('a'), []); assert.deepEqual(f.store.reconcileResume('a', 'consumer-a').queued, []);
    assert.equal(f.store.list('a', { activeOnly: true }).tasks.length, 0);
    assert.deepEqual(f.drain('b'), []);
  } finally { f.close(); }
});

test('independent review can be delegated separately without moving implementation ownership', () => {
  const f = fixture(); try {
    const implementation = f.create();
    const review = f.store.create({ to: 'b', subject: 'review only', body: 'Review the implementation range; do not implement it again', items: ['review'], refs: ['local task #' + implementation.id], requiresIntegration: false }, 'a');
    assert.equal(f.store.read(implementation.id, 'a').assignee.id, 'a');
    assert.throws(() => f.store.read(implementation.id, 'b'), /not found or not visible/);
    f.store.check(review.id, 'b', 1, true); f.store.complete(review.id, 'b', commit, 'reviewed exact range');
    const closed = f.store.closeTask(review.id, 'a', commit, 'review received');
    assert.equal(closed.events.at(-1)!.data.reviewMode, 'peer');
    assert.equal(f.store.read(implementation.id, 'a').state, 'open');
  } finally { f.close(); }
});

test('cancellation is creator-only, idempotent, terminal and visible in retained history', () => {
  const f = fixture(); try {
    const t = f.create('b');
    assert.throws(() => f.store.cancel(t.id, 'b', 'decline'), /Only the creator/);
    assert.throws(() => f.store.cancel(t.id, 'c', 'intrude'), /not found or not visible/);
    assert.throws(() => f.store.cancel(t.id, 'a', ''), /Cancellation reason/);
    const snapshot = f.store.listForHumanUi({ actor: 'a' }).snapshot;
    const cancelled = f.store.cancel(t.id, 'a', 'mistaken delegation; owner will implement');
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.block, null);
    const revision = cancelled.events.length;
    assert.equal(f.store.cancel(t.id, 'a', cancelled.cancellation!.reason).events.length, revision);
    assert.throws(() => f.store.cancel(t.id, 'a', 'overwrite reason'), /different reason/);
    const operations = [
      () => f.store.check(t.id, 'b', 1, true), () => f.store.complete(t.id, 'b', commit, 'done'),
      () => f.store.reopen(t.id, 'a', 'resume'), () => f.store.closeTask(t.id, 'a', commit, 'pretend done'),
      () => f.store.block(t.id, 'b', 'wait', 'a'), () => f.store.unblock(t.id, 'b', 'go'),
      () => f.store.reply(t.id, 'a', 'continue', 'key'), () => f.store.setPriority(t.id, 'a', 'urgent'),
    ];
    for (const op of operations) assert.throws(op, /cancelled|open|completed/i);
    assert.equal(f.store.list('a', { activeOnly: true }).tasks.length, 0);
    assert.equal(f.store.sideForHumanUi('a', 'b').openTasks, 0);
    assert.equal(f.store.listForHumanUi({ actor: 'a', snapshot }).tasks[0].state, 'open', 'old snapshot remains immutable');
    const theme = { fg: (_: string, s: string) => s, strikethrough: (s: string) => s };
    const display = taskLines(f.store.read(t.id, 'a'), true, theme as any, 180).join('\n');
    assert.match(display, /已取消|取消原因/); assert.doesNotMatch(display, /下一步/);
    const raw = new DatabaseSync(f.store.dbPath);
    try {
      assert.throws(() => raw.prepare("INSERT INTO handoff_task_events(task_id,actor,kind,data_json,at) VALUES(?,?,'complete',?,?)").run(t.id, 'b', JSON.stringify({ commit, summary: 'legacy writer' }), new Date().toISOString()), /Cancelled tasks are terminal/);
    } finally { raw.close(); }
    const reopened = new HandoffStore(f.root); try { assert.equal(reopened.read(t.id, 'b').state, 'cancelled'); } finally { reopened.close(); }
  } finally { f.close(); }
});

test('cancel supersedes stale created/reply events; assignee and blocked dependents recheck exactly once', () => {
  const f = fixture(); try {
    const source = f.create('b');
    const dependent = f.store.create({ subject: 'needs input', body: 'needs source', items: ['done'], requiresIntegration: false }, 'b');
    f.store.block(dependent.id, 'b', 'need source', 'a', [source.id]);
    f.store.reply(source.id, 'a', 'old input', 'before-cancel');
    f.store.cancel(source.id, 'a', 'wrong task; no artifact delivered');
    assert.deepEqual(f.drain('b').map(e => [e.taskId, e.kind]).sort(), [[source.id, 'cancel'], [dependent.id, 'dependency']].sort());
    assert.deepEqual(f.drain('b'), []); assert.deepEqual(f.drain('c'), []);
    assert.equal(f.store.read(dependent.id, 'b').block!.needsReview, true);
    assert.equal(f.store.read(dependent.id, 'b').state, 'open');
    f.store.cancel(dependent.id, 'b', 'also superseded');
    assert.equal(f.store.read(dependent.id, 'b').block, null);
    assert.deepEqual(f.drain('b'), []);
    assert.deepEqual(f.store.reconcileResume('b', 'consumer-b').queued, []);
    assert.deepEqual(f.drain('a'), []);
  } finally { f.close(); }
});

test('cancelled local work does not self-notify and never claims delivery success', () => {
  const f = fixture(); try {
    const t = f.create(); f.store.cancel(t.id, 'a', 'no longer needed');
    assert.deepEqual(f.drain('a'), []); assert.equal(f.store.read(t.id, 'a').commit, null);
    assert.equal(f.store.listForHumanUi({ sort: 'pending' }).tasks[0].state, 'cancelled');
    assert.deepEqual(f.store.reconcileResume('a', 'consumer-a').queued, []);
  } finally { f.close(); }
});
