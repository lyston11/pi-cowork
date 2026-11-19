import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HandoffStore } from '../store.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cowork-actions-'));
  const store = new HandoffStore(root);
  for (const id of ['two', 'three', 'five', 'other']) store.register({ id, name: id, sessionId: id, pid: process.pid, worktree: root, branch: 'main' });
  const task = (from: string, to: string, priority: 'urgent' | 'low' = 'low') => store.create({ to, subject: 'Fixture', body: 'isolated fixture', items: ['verify result'], priority, requiresIntegration: false }, from);
  const drain = (actor: string) => {
    assert(store.acquireResume(actor, actor, actor));
    const batch = store.pendingResume(actor, actor);
    if (batch) store.acknowledgeResume(actor, actor, batch.throughSeq);
    return batch?.events ?? [];
  };
  return { root, store, task, drain, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

const window = { owner: 'three', action: 'Check current occupancy', expectedResult: 'A drain window in the existing scope' };

test('a light prerequisite routes to its owner, inherits upstream priority, and wakes the original requester once per result', () => {
  const f = fixture();
  try {
    const outer = f.task('two', 'two', 'urgent'), middle = f.task('two', 'three'), inner = f.task('three', 'five');
    f.store.block(outer.id, 'two', 'need receipt', 'three', [middle.id]);
    f.store.block(middle.id, 'three', 'waiting for connection proof', 'five', [inner.id]);
    const blocked = f.store.block(inner.id, 'five', 'need safe window', 'three', [], undefined, undefined, window);
    const action = blocked.block!.action!;
    assert.equal(action.priority, 'urgent');
    assert.equal(f.store.read(inner.id, 'five').priority, 'low');
    assert.deepEqual(f.store.blockerActions('three').map(a => a.id), [action.id]);
    assert.deepEqual(f.store.blockerActions('other'), []);
    assert.throws(() => f.store.blockerAction(action.id, 'other'), /No active prerequisite action/);
    assert.throws(() => f.store.reportBlockerAction(action.id, 'five', 0, 'ready', 'No occupancy'), /Only the prerequisite action owner/);
    assert.throws(() => f.store.unblock(inner.id, 'five', 'skip pending result'), /current ready action/);
    assert.throws(() => f.store.block(inner.id, 'five', 'do not silently drop', 'scheduler', [], undefined, undefined, undefined, true), /explicitly withdraw/);
    assert.equal(f.drain('three').filter(e => e.kind === 'action-request' && e.actionId === action.id).length, 1);
    assert.equal(f.drain('three').length, 0);
    assert.equal(f.store.block(inner.id, 'five', 'same condition, new wording', 'three', [], undefined, undefined, window).block!.action!.id, action.id);
    assert.equal(f.drain('three').length, 0);
    const waiting = f.store.reportBlockerAction(action.id, 'three', 0, 'waiting', 'Two jobs in flight; wait for both receipts');
    assert.equal(f.drain('five').filter(e => e.kind === 'action-result').length, 1);
    assert.equal(f.store.read(inner.id, 'five').block!.needsReview, false);
    assert.equal(f.store.reportBlockerAction(action.id, 'three', 0, 'waiting', waiting.evidence!).revision, waiting.revision);
    assert.equal(f.drain('five').length, 0);
    f.store.setResumeEnabled('five', false, 'paused');
    const ready = f.store.reportBlockerAction(action.id, 'three', waiting.revision, 'ready', 'Jobs drained; source receipt is 23');
    assert.equal(f.store.acquireResume('five', 'five', 'five'), false);
    assert.equal(f.store.read(inner.id, 'five').block!.needsReview, true);
    assert.throws(() => f.store.unblock(inner.id, 'five', 'stale', waiting.revision), /current ready action/);
    f.store.setResumeEnabled('five', true, null, true);
    assert.equal(f.drain('five').filter(e => e.kind === 'action-result').length, 1);
    assert.equal(f.drain('five').length, 0);
    f.store.unblock(inner.id, 'five', 'Receipt independently verified', ready.revision);
    assert.equal(f.store.read(inner.id, 'five').block, null);
    assert.equal(f.store.read(inner.id, 'five').state, 'open');
    assert.deepEqual(f.store.blockerActions('three'), []);
  } finally { f.close(); }
});

test('waiting on an actual dependency is cycle-checked and wakes the action owner when the dependency changes', () => {
  const f = fixture();
  try {
    const base = f.task('three', 'five'), dependency = f.task('three', 'other'), reverse = f.task('three', 'five');
    const action = f.store.block(base.id, 'five', 'missing window', 'three', [], undefined, undefined, window).block!.action!;
    f.drain('three');
    f.store.block(reverse.id, 'five', 'depends on original', 'five', [base.id]);
    assert.throws(() => f.store.reportBlockerAction(action.id, 'three', 0, 'waiting', 'wait for base', base.id), /cannot depend on itself/);
    assert.throws(() => f.store.reportBlockerAction(action.id, 'three', 0, 'waiting', 'wait for reverse', reverse.id), /cycle/);
    const wait = f.store.reportBlockerAction(action.id, 'three', 0, 'waiting', 'waiting for an independent receipt', dependency.id);
    assert.equal(f.store.blockerAction(action.id, 'five').dependencyId, undefined);
    assert.equal(f.store.blockerAction(action.id, 'three').dependencyId, dependency.id);
    assert(!f.drain('three').some(e => e.kind === 'action-request'));
    f.store.reply(dependency.id, 'other', 'The window starts after the scheduled drain', 'independent-evidence');
    assert.equal(f.store.blockerAction(action.id, 'three').status, 'pending');
    assert.equal(f.drain('three').filter(e => e.kind === 'action-request').length, 1);
    assert.equal(f.drain('three').length, 0);
    f.store.reportBlockerAction(action.id, 'three', wait.revision, 'waiting', wait.evidence!, dependency.id);
    assert.equal(f.store.blockerAction(action.id, 'three').status, 'waiting');
    assert.equal(f.drain('three').length, 0);
  } finally { f.close(); }
});

test('old clients cannot silently erase an action; reassignment and cancellation stop all stale delivery', () => {
  const f = fixture();
  try {
    const task = f.task('two', 'five');
    assert.throws(() => f.store.block(task.id, 'five', 'missing', 'five', [], undefined, undefined, { ...window, owner: 'five' }), /your own/);
    assert.throws(() => f.store.block(task.id, 'five', 'missing', 'no-such-side', [], undefined, undefined, { ...window, owner: 'no-such-side' }), /Unknown or removed/);
    assert.throws(() => f.store.block(task.id, 'five', 'missing', 'three', [], undefined, undefined, undefined, true), /not an external dependency/);
    f.store.setResumeEnabled('three', false, 'paused');
    const a = f.store.block(task.id, 'five', 'missing window', 'three', [], undefined, undefined, window).block!.action!;
    assert.equal(a.ownerAvailability, 'paused');
    const db = new DatabaseSync(f.store.dbPath);
    try {
      const append = db.prepare("INSERT INTO handoff_task_events(task_id,actor,kind,data_json,at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)");
      assert.throws(() => append.run(task.id, 'five', 'block', '{"reason":"same","waitingFor":"three","dependencies":[]}'), /reload CoWork/);
      assert.throws(() => append.run(task.id, 'five', 'unblock', '{"note":"guess"}'), /current ready action/);
    } finally { db.close(); }
    assert.throws(() => f.store.block(task.id, 'five', 'no longer need window', 'external', [], undefined, undefined, undefined, true), /explicitly withdraw/);
    const b = f.store.block(task.id, 'five', 'reassign concrete check', 'other', [], undefined, undefined, { ...window, owner: 'other' }).block!.action!;
    assert.notEqual(b.id, a.id);
    assert.throws(() => f.store.blockerAction(a.id, 'three'), /No active/);
    assert(!f.store.blockerActions('three').length);
    f.store.cancel(task.id, 'two', 'fixture retained as history');
    assert.equal(f.drain('other').length, 0);
    assert.equal(f.store.blockerActions().length, 0);
    assert(f.store.read(task.id, 'five').events.some(event => event.data.actionId === a.id));
  } finally { f.close(); }
});
