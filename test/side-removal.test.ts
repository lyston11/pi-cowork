import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { HandoffStore } from '../store.ts';
import type { Side } from '../types.ts';

const owner: Side = { id: 'owner', sessionId: 'owner-session', name: 'owner', pid: process.pid, worktree: '/owner', branch: 'task/owner' };
const old: Side = { ...owner, id: 'old', sessionId: 'old-session', name: 'old', pid: 2147483647 };
const commit = 'a'.repeat(40);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-cowork-removal-')), store = new HandoffStore(root);
  store.register(owner); store.register(old);
  return { root, store, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('removing a stopped side hides discovery, preserves closed history and survives reload without resurrection', () => {
  const f = fixture();
  try {
    const task = f.store.create({ to: old.id, subject: 'completed task', body: 'preserve history', items: ['done'] }, owner.id);
    f.store.check(task.id, old.id, 1, true); f.store.complete(task.id, old.id, commit, 'delivered'); f.store.closeTask(task.id, owner.id, commit, 'reviewed');
    const before = f.store.read(task.id, owner.id);
    assert(f.store.removeSide(owner, old.id, old.sessionId, 'User requested deletion').removedAt);
    assert.equal(f.store.sides().some(side => side.id === old.id), false);
    assert.equal(f.store.sidePage({ query: old.id }).sides.length, 0);
    assert.deepEqual(f.store.read(task.id, owner.id).events, before.events);
    assert.equal(f.store.read(task.id, owner.id).assignee.name, old.name);
    const snapshot = f.store.listForHumanUi();
    assert.equal(snapshot.tasks[0].assignee.name, old.name);
    assert.throws(() => f.store.create({ to: old.id, subject: 'new', body: 'no', items: ['no'] }, owner.id), /Assignee not found/);
    assert.throws(() => f.store.setResumeEnabled(old.id, true), /removed/);
    assert.equal(f.store.acquireResume(old.id, old.sessionId, 'new-consumer'), false);
    assert.throws(() => f.store.register(old), /removed/);
    assert.throws(() => f.store.reopen(task.id, owner.id, 'must not reopen a closed task'), /completed task/);
    f.store.close();
    const restarted = new HandoffStore(f.root);
    try {
      assert(restarted.sessionSide(old.sessionId)?.removedAt);
      assert.equal(restarted.sides().length, 1);
      assert.equal(restarted.sidePage().sides.length, 1);
      assert.equal(restarted.read(task.id, old.id).state, 'closed');
      const legacy = new DatabaseSync(restarted.dbPath);
      try {
        assert.throws(() => legacy.prepare('UPDATE handoff_sides SET name=? WHERE id=?').run('resurrect', old.id), /removed/);
        assert.throws(() => legacy.exec('DELETE FROM handoff_side_removals'), /append-only/);
      } finally { legacy.close(); }
    } finally { restarted.close(); }
  } finally { f.close(); }
});

test('removal refuses unclosed tasks, active workspaces, live peers, stale ownership and duplicate requests', () => {
  const f = fixture();
  try {
    const task = f.store.create({ to: old.id, subject: 'not done', body: 'keep', items: ['done'] }, owner.id);
    assert.throws(() => f.store.removeSide(owner, old.id, old.sessionId, 'delete'), /unclosed/);
    f.store.check(task.id, old.id, 1, true); f.store.complete(task.id, old.id, commit, 'delivered');
    assert.throws(() => f.store.removeSide(owner, old.id, old.sessionId, 'delete'), /unclosed/);
    f.store.closeTask(task.id, owner.id, commit, 'reviewed');
    assert.throws(() => f.store.removeSide(owner, old.id, 'outdated-session', 'delete'), /ownership changed/);
    const sql = new DatabaseSync(f.store.dbPath);
    try {
      sql.prepare("INSERT INTO handoff_workspaces(id,repo,target_key,owner,path,branch,base,tasks_json,at) VALUES('w','repo','target',?,'/workspace','task/w',?,'[]','now')").run(old.id, commit);
      assert.throws(() => f.store.removeSide(owner, old.id, old.sessionId, 'delete'), /active workspace/);
      sql.exec("UPDATE handoff_workspaces SET state='retired' WHERE id='w'");
    } finally { sql.close(); }
    f.store.register({ ...old, pid: process.pid });
    assert.throws(() => f.store.removeSide(owner, old.id, old.sessionId, 'delete'), /still running/);
    f.store.register(old);
    f.store.removeSide(owner, old.id, old.sessionId, 'delete');
    assert.throws(() => f.store.removeSide(owner, old.id, old.sessionId, 'duplicate'), /not found/);
  } finally { f.close(); }
});

test('a live current side must pause and release its consumer before deleting itself', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.removeSide(owner, owner.id, owner.sessionId, 'delete me'), /Pause/);
    f.store.acquireResume(owner.id, owner.sessionId, 'consumer'); f.store.setResumeEnabled(owner.id, false);
    assert.throws(() => f.store.removeSide(owner, owner.id, owner.sessionId, 'delete me'), /consumer/);
    f.store.releaseResume(owner.id, 'consumer');
    assert(f.store.removeSide(owner, owner.id, owner.sessionId, 'delete me').removedAt);
    assert.equal(f.store.resumeStatus(owner.id).enabled, false);
    assert.equal(f.store.sessionSide(owner.sessionId)?.id, owner.id);
    assert.throws(() => f.store.register(owner), /removed/);
  } finally { f.close(); }
});
