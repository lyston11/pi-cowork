import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HandoffStore } from '../store.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-cowork-replies-'));
  const store = new HandoffStore(root), peer = new HandoffStore(root);
  for (const id of ['a', 'b', 'c']) store.register({ id, name: id, sessionId: id, pid: process.pid, worktree: root, branch: 'test' });
  const create = (creator = 'a', assignee = 'b') => store.create({ to: assignee, subject: 'deliver input', body: 'authorized work', items: ['deliver code'], refs: [], requiresIntegration: false }, creator);
  const acquire = (actor: string) => assert(store.acquireResume(actor, actor, 'test-' + actor));
  const drain = (actor: string) => {
    acquire(actor);
    const events = [];
    for (let batch; (batch = store.pendingResume(actor, 'test-' + actor));) {
      events.push(...batch.events);
      store.acknowledgeResume(actor, 'test-' + actor, batch.throughSeq);
    }
    return events;
  };
  const reconcile = (actor: string) => { acquire(actor); return store.reconcileResume(actor, 'test-' + actor); };
  const close = () => { peer.close(); store.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, store, peer, create, acquire, drain, reconcile, close };
}

test('multiple rounds are appended on one task and notify only the opposite participant', () => {
  const f = fixture();
  try {
    const task = f.create(); f.drain('b');
    f.store.block(task.id, 'b', 'need owner input', 'a'); f.drain('a');
    let previous: number | undefined;
    for (let round = 0; round < 4; round++) {
      const from = round % 2 === 0 ? 'b' : 'a', to = from === 'b' ? 'a' : 'b';
      const reply = f.peer.reply(task.id, from, 'substantive new material ' + round, 'round-' + round, previous);
      previous = reply.lastReply!.seq;
      assert.deepEqual(f.drain(to).map(e => [e.taskId, e.kind]), [[task.id, 'reply']]);
      assert.deepEqual(f.drain(from), []);
      assert.deepEqual(f.drain('c'), []);
      assert.equal(reply.state, 'open');
      assert.equal(reply.items[0].checked, false);
    }
    const final = f.store.read(task.id, 'b');
    assert.equal(final.events.filter(e => e.kind === 'reply').length, 4);
    assert.equal(final.block?.needsReview, true);
    assert.equal(f.store.list('a').tasks.length, 1);
    assert.equal(f.store.list('c').tasks.length, 0);
  } finally { f.close(); }
});

test('reply retries are idempotent, changed payloads cannot reuse a key', () => {
  const f = fixture();
  try {
    const task = f.create(); f.drain('b');
    const first = f.store.reply(task.id, 'a', 'exact input provided', 'key');
    const retry = f.peer.reply(task.id, 'a', 'exact input provided', 'key');
    assert.deepEqual(retry, first);
    assert.equal(f.drain('b').length, 1);
    assert.throws(() => f.store.reply(task.id, 'a', 'different content', 'key'), /different content/);
    assert.throws(() => f.store.reply(task.id, 'a', ' ', 'empty'), /non-empty/);
    assert.throws(() => f.store.reply(task.id, 'a', 'x'.repeat(4001), 'large'), /4000/);
    assert.throws(() => f.store.reply(task.id, 'a', 'content', ''), /idempotency/);
  } finally { f.close(); }
});

test('third sides, other-task references and self replies cannot bypass task visibility', () => {
  const f = fixture();
  try {
    const task = f.create(), another = f.create();
    const own = f.store.reply(task.id, 'b', 'specific question', 'question');
    const foreign = f.store.reply(another.id, 'a', 'other task answer', 'other');
    assert.throws(() => f.store.reply(task.id, 'c', 'not authorized', 'private'));
    assert.throws(() => f.store.reply(task.id, 'b', 'self reference', 'self', own.lastReply!.seq), /peer reply/);
    assert.throws(() => f.store.reply(task.id, 'b', 'other task reference', 'cross', foreign.lastReply!.seq), /peer reply/);
    assert.throws(() => f.store.reply(task.id, 'a', 'invalid reference', 'bad', 0), /Invalid/);
    assert.equal(f.store.read(task.id, 'a').events.filter(e => e.kind === 'reply').length, 1);
  } finally { f.close(); }
});

test('new input on a dependency wakes affected blockers without completing or unblocking anything', () => {
  const f = fixture();
  try {
    const parent = f.create(), code = f.create('b', 'a'), stable = f.create();
    f.store.block(parent.id, 'b', 'need input from this code task', 'a', [code.id]);
    const manual = { kind: 'manual' as const, limitation: 'Only the user has the physical device; no remote interface' };
    f.store.block(stable.id, 'b', 'device result missing', 'user', [], 'Run the device test and report the result', manual);
    f.drain('a'); f.drain('b');
    const snapshot = f.store.listForHumanUi({ actor: 'a', limit: 100 }).snapshot;
    f.peer.reply(code.id, 'a', 'replacement delivery is ready, see authorized code receipt', 'delivery');
    const events = f.drain('b');
    assert.deepEqual(events.map(e => [e.taskId, e.kind]).sort(), [[parent.id, 'dependency'], [code.id, 'reply']].sort());
    assert.equal(f.store.read(parent.id, 'b').block?.needsReview, true);
    assert.equal(f.store.read(stable.id, 'b').block?.needsReview, false);
    const frozen = f.store.listForHumanUi({ actor: 'a', snapshot, limit: 100 }).tasks.find(t => t.id === parent.id)!;
    assert.equal(frozen.block?.needsReview, false, 'list snapshots do not absorb later replies');
    assert.throws(() => f.store.complete(parent.id, 'b', 'a'.repeat(40), 'not actually done'), /Check every item/);
    f.store.block(parent.id, 'b', 'new input inspected; still missing device result', 'user', [code.id], 'Run the device test and report the result', manual);
    assert.equal(f.store.read(parent.id, 'b').block?.needsReview, false);
    f.drain('b');
    f.peer.reply(code.id, 'a', 'device result now attached to the same code task', 'device-result');
    assert.equal(f.store.read(parent.id, 'b').block?.needsReview, true);
    assert.equal(f.drain('b').filter(e => e.taskId === parent.id).length, 1);
  } finally { f.close(); }
});

test('unanswered input gets one checkpoint, an explicit response settles that obligation', () => {
  const f = fixture();
  try {
    const task = f.create(); f.drain('b');
    f.store.block(task.id, 'b', 'owner needs to clarify stage', 'a'); f.drain('a');
    const request = f.store.reply(task.id, 'b', 'which stage must precede delivery?', 'question');
    f.drain('a');
    assert.deepEqual(f.reconcile('a').queued, [task.id]);
    f.drain('a');
    assert.deepEqual(f.reconcile('a').stalled, [task.id]);
    f.store.reply(task.id, 'a', 'split authorized delivery and post-deployment verification formally', 'answer', request.lastReply!.seq);
    assert.deepEqual(f.reconcile('a'), { queued: [], stalled: [] });
    assert.equal(f.store.read(task.id, 'b').block?.needsReview, true);
    f.store.block(task.id, 'b', 'clarification reviewed; waiting formal stage correction', 'a');
    assert.equal(f.store.read(task.id, 'b').block?.needsReview, false);
    f.drain('b');
    assert.deepEqual(f.reconcile('b'), { queued: [], stalled: [] });
  } finally { f.close(); }
});

test('simultaneous unreferenced messages cannot suppress each other', () => {
  const f = fixture();
  try {
    const task = f.create(); f.drain('b');
    const first = f.store.reply(task.id, 'a', 'new input A', 'a');
    f.peer.reply(task.id, 'b', 'independent question B', 'b');
    assert.equal(f.drain('b')[0].kind, 'reply');
    assert.equal(f.drain('a')[0].kind, 'reply');
    f.peer.reply(task.id, 'b', 'response to input A', 'response', first.lastReply!.seq);
    assert.deepEqual(f.reconcile('b').queued, [task.id], 'own open work remains actionable');
    assert.equal(f.store.read(task.id, 'a').events.filter(e => e.kind === 'reply').length, 3);
  } finally { f.close(); }
});

test('paused side retains new rounds across restart and only resumes with explicit enable', () => {
  const f = fixture();
  try {
    const task = f.create(); f.drain('b');
    f.store.setResumeEnabled('a', false, 'Stopped by user');
    f.peer.reply(task.id, 'b', 'requires concrete creator input', 'new-round');
    const restarted = new HandoffStore(f.root);
    try {
      assert.equal(restarted.acquireResume('a', 'a', 'restart'), false);
      assert.equal(restarted.resumeStatus('a').enabled, false);
      restarted.setResumeEnabled('a', true);
      assert(restarted.acquireResume('a', 'a', 'restart'));
      const batch = restarted.pendingResume('a', 'restart')!;
      assert.deepEqual(batch.events.map(e => e.kind), ['reply']);
    } finally { restarted.close(); }
  } finally { f.close(); }
});

test('replies to completed work preserve delivery; new replies to closed work are rejected', () => {
  const f = fixture();
  try {
    const task = f.create(); f.store.check(task.id, 'b', 1, true); f.store.complete(task.id, 'b', 'a'.repeat(40), 'done'); f.drain('a');
    f.store.reply(task.id, 'a', 'review requests specific evidence', 'evidence');
    assert.equal(f.store.read(task.id, 'b').state, 'completed');
    assert.deepEqual(f.drain('b').map(e => e.kind), ['reply']);
    f.store.closeTask(task.id, 'a', 'a'.repeat(40), 'reviewed');
    assert.throws(() => f.store.reply(task.id, 'b', 'late update', 'late'), /closed task/);
    assert.deepEqual(f.drain('b').filter(e => e.kind === 'reply'), []);
  } finally { f.close(); }
});
