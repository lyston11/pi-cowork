import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HandoffStore } from '../store.ts';
import { taskLines } from '../ui.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cowork-user-boundary-'));
  const store = new HandoffStore(root);
  for (const id of ['a','b','c']) store.register({ id, name: id, sessionId: id, pid: process.pid, worktree: root, branch: 'main' });
  const create = (to = 'b') => store.create({ to, subject: 'existing authorized work', body: 'read local input and validate it', items: ['validated'], requiresIntegration: false }, 'a');
  const legacy = (id: number, actor: string, request = 'Please approve continuing read-only validation') => {
    const db = new DatabaseSync(store.dbPath);
    try {
      const seq = Number(db.prepare("INSERT INTO handoff_task_events(task_id,actor,kind,data_json,at) VALUES(?,?,'block',?,?)")
        .run(id, actor, JSON.stringify({ reason:'Waiting for approval', waitingFor:'user', userRequest:request, dependencies:[] }), new Date().toISOString()).lastInsertRowid);
      for (const side of new Set(['a',actor])) db.prepare('INSERT INTO handoff_user_request_notifications(task_id,block_seq,side_id) VALUES(?,?,?)').run(id,seq,side);
      return seq;
    } finally { db.close(); }
  };
  return { root, store, create, legacy, close() { store.close(); rmSync(root, {recursive:true,force:true}); } };
}

test('a user request cannot become a durable blocker or notification without capability or authority evidence', () => {
 const f=fixture();try{
  const t=f.create(),events=f.store.read(t.id,'b').events;
  assert.throws(()=>f.store.block(t.id,'b','Routine validation','user'),/userRequest is required/);
  assert.throws(()=>f.store.block(t.id,'b','Routine validation','user',[],'Approve read-only validation'),/userAction is required/);
  assert.throws(()=>f.store.block(t.id,'b','Routine validation','user',[],'Approve read-only validation',{kind:'authorization',limitation:'Needs approval'}),/userAction.authority/);
  assert.throws(()=>f.store.block(t.id,'b','Routine validation','user',[],'Do it',{kind:'manual',limitation:' '}),/limitation/);
  assert.deepEqual(f.store.read(t.id,'b').events,events);
  assert.deepEqual(f.store.pendingUserRequestNotifications('b'),[]);
  assert.equal(f.store.listForHumanUi().snapshot.userRequestCount,0);
  f.store.check(t.id,'b',1,true);f.store.complete(t.id,'b','a'.repeat(40),'Validated within original authorization');
  assert.equal(f.store.read(t.id,'b').state,'completed');
 }finally{f.close();}
});

test('genuine manual input and explicit authorization limits retain guards and distinct presentation', () => {
 const f=fixture();try{
  const t=f.create();
  const action={kind:'authorization' as const,limitation:'Restarting production exceeds the read-only investigation',authority:'User: do not stop or restart this service without asking me'};
  const blocked=f.store.block(t.id,'b','Production restart requires explicit authorization','user',[],'Allow restarting service X, affecting active requests?',action);
  assert.deepEqual(blocked.block?.userAction,action);
  f.store.check(t.id,'b',1,true);
  assert.throws(()=>f.store.complete(t.id,'b','a'.repeat(40),'skip'),/unblock/);
  assert.throws(()=>f.store.unblock(t.id,'a','override'),/assignee/);
  const theme:any={fg:(_:string,v:string)=>v,strikethrough:(v:string)=>v};
  const view=taskLines(blocked,true,theme,160).join('\n');assert.match(view,/需要你决定/);assert.match(view,/User: do not stop/);
  assert.equal(f.store.listForHumanUi().snapshot.userRequestCount,1);
  assert.equal(f.store.listForHumanUi().snapshot.userDecisionCount,1);
  const input=f.create();f.store.block(input.id,'b','Missing external source','user',[],'Provide the source document through the private input channel',{kind:'input',limitation:'The source exists only on the user device; all available project inputs have been checked'});
  assert.equal(f.store.listForHumanUi().snapshot.userRequestCount,2);
  assert.equal(f.store.listForHumanUi().snapshot.userDecisionCount,1);
 }finally{f.close();}
});

test('upgrade returns legacy requests to both Agents once, without notifying user, granting permission or reviving paused sides', () => {
 const f=fixture();let upgraded:HandoffStore|undefined;try{
  const t=f.create(),seq=f.legacy(t.id,'b');
  f.store.setResumeEnabled('a',false,'user paused');
  upgraded=new HandoffStore(f.root);
  const task=upgraded.read(t.id,'b');
  assert.equal(task.state,'open');assert.equal(task.block?.userRequestNeedsReview,true);assert.equal(task.block?.needsReview,true);
  assert.deepEqual(upgraded.pendingUserRequestNotifications('b'),[]);
  assert.equal(upgraded.claimUserRequestNotification('b',t.id,seq),undefined);
  assert.equal(upgraded.listForHumanUi().snapshot.userRequestCount,0);
  assert.equal(upgraded.resumeStatus('a').enabled,false);
  assert.equal(upgraded.acquireResume('a','a','paused'),false);
  assert.deepEqual(upgraded.reconcileResume('a','paused'),{queued:[],stalled:[]});
  assert(upgraded.acquireResume('b','b','running'));
  assert.deepEqual(upgraded.reconcileResume('b','running'),{queued:[t.id],stalled:[]});
  let batch=upgraded.pendingResume('b','running')!;
  assert.deepEqual(batch.events.map(e=>[e.taskId,e.kind]),[[t.id,'checkpoint']]);
  upgraded.acknowledgeResume('b','running',batch.throughSeq);
  assert.deepEqual(upgraded.reconcileResume('b','running'),{queued:[],stalled:[t.id]},'same version cannot schedule a second review');
  upgraded.close();upgraded=new HandoffStore(f.root);
  assert.equal(upgraded.pendingResume('b','running'),null,'reload does not replay the migration');
  // Creator upgrades later; its review must not have been queued to the old reader.
  const db=new DatabaseSync(f.store.dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM handoff_resume_events WHERE recipient='a' AND source LIKE 'user-action-review:%'").get()!.n,0);db.close();
  upgraded.setResumeEnabled('a',true);assert(upgraded.acquireResume('a','a','creator'));
  assert.deepEqual(upgraded.reconcileResume('a','creator'),{queued:[t.id],stalled:[]});
  assert.equal(upgraded.pendingResume('a','creator')!.events.at(-1)!.kind,'checkpoint');
  assert.throws(()=>upgraded!.read(t.id,'c'),/not found or not visible/);
  // An Agent must read the user's original scope and explicitly remove a false blocker.
  upgraded.unblock(t.id,'b','Original user instruction already authorizes read-only validation');
  assert.equal(upgraded.read(t.id,'b').block,null);
  assert.equal(upgraded.read(t.id,'b').events.some(e=>e.seq===seq),true,'original request remains auditable');
 }finally{upgraded?.close();f.close();}
});

test('legacy manual requests can be re-established with evidence and cancelled requests are not revived', () => {
 const f=fixture();let upgraded:HandoffStore|undefined;try{
  const t=f.create(),seq=f.legacy(t.id,'b','Operate the physical device and report the screen');
  const cancelled=f.create('a');f.legacy(cancelled.id,'a');f.store.cancel(cancelled.id,'a','obsolete');
  upgraded=new HandoffStore(f.root);
  const action={kind:'manual' as const,limitation:'Only the user has the physical device and no remote access is available'};
  const fixed=upgraded.block(t.id,'b','Physical device validation','user',[],'Operate the physical device and report the screen',action);
  assert.equal(fixed.block?.userRequestNeedsReview,undefined);assert.equal(fixed.block?.needsReview,false);
  const latest=fixed.events.at(-1)!.seq;assert(latest>seq);
  assert.deepEqual(upgraded.pendingUserRequestNotifications('b'),[{taskId:t.id,blockSeq:latest}]);
  assert(upgraded.claimUserRequestNotification('b',t.id,latest));
  assert.equal(upgraded.claimUserRequestNotification('b',t.id,latest),undefined);
  assert.equal(upgraded.acquireResume('b','b','consumer'),true);
  assert.equal(upgraded.pendingResume('b','consumer')!.events.length,0,'obsolete migration review is discarded');
  assert.equal(upgraded.read(cancelled.id,'a').state,'cancelled');
 }finally{upgraded?.close();f.close();}
});
