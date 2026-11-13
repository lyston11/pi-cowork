import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HandoffStore } from '../store.ts';
import { taskLines } from '../ui.ts';
import type { UserAction } from '../types.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cowork-user-boundary-'));
  const store = new HandoffStore(root);
  for (const id of ['a','b','c']) store.register({ id, name: id, sessionId: id, pid: process.pid, worktree: root, branch: 'main' });
  const create = (to = 'b') => store.create({ to, subject: 'existing authorized work', body: 'read local input and validate it', items: ['validated'], requiresIntegration: false }, 'a');
  const legacy = (id: number, actor: string, request = 'Please approve continuing read-only validation', userAction?: UserAction) => {
    const db = new DatabaseSync(store.dbPath);
    try {
      const seq = Number(db.prepare("INSERT INTO handoff_task_events(task_id,actor,kind,data_json,at) VALUES(?,?,'block',?,?)")
        .run(id, actor, JSON.stringify({ reason:'Waiting for approval', waitingFor:'user', userRequest:request, userAction, dependencies:[] }), new Date().toISOString()).lastInsertRowid);
      for (const side of new Set(['a',actor])) db.prepare('INSERT INTO handoff_user_request_notifications(task_id,block_seq,side_id) VALUES(?,?,?)').run(id,seq,side);
      return seq;
    } finally { db.close(); }
  };
  return { root, store, create, legacy, close() { store.close(); rmSync(root, {recursive:true,force:true}); } };
}

test('a user request requires a real capability gap and never accepts approval work', () => {
 const f=fixture();try{
  const t=f.create(),events=f.store.read(t.id,'b').events;
  assert.throws(()=>f.store.block(t.id,'b','Routine validation','user'),/userRequest is required/);
  assert.throws(()=>f.store.block(t.id,'b','Routine validation','user',[],'Approve read-only validation'),/userAction is required/);
  assert.throws(()=>f.store.block(t.id,'b','Routine validation','user',[],'Approve read-only validation',{kind:'authorization',limitation:'Needs approval'} as any),/Approvals belong to Agents/);
  assert.throws(()=>f.store.block(t.id,'b','Routine validation','user',[],'Do it',{kind:'manual',limitation:' '}),/limitation/);
  assert.deepEqual(f.store.read(t.id,'b').events,events);
  assert.deepEqual(f.store.pendingUserRequestNotifications('b'),[]);
  assert.equal(f.store.listForHumanUi().snapshot.userRequestCount,0);
  f.store.check(t.id,'b',1,true);f.store.complete(t.id,'b','a'.repeat(40),'Validated within original authorization');
  assert.equal(f.store.read(t.id,'b').state,'completed');
 }finally{f.close();}
});

test('explicitly unnecessary user actions cannot create a blocker or notification', () => {
 const f=fixture();try{
  const t=f.create(),before=f.store.read(t.id,'b');
  const action:UserAction={kind:'input',limitation:'Missing an input not available to any Agent'};
  for(const request of ['无用户操作；等待3侧沿#16/#189交修后证据。','无需用户配合。','不需要你协作；等待交付。','No user action is required. Waiting for another Agent.']) {
   assert.throws(()=>f.store.block(t.id,'b','Internal dependency','side 3',[],request,action),/No user action/);
  }
  assert.throws(()=>f.store.block(t.id,'b','Internal dependency','side 3',[],'Provide input',{kind:'input',limitation:'本阻塞为3侧工程依赖，无需用户输入。'}),/No user action/);
  assert.deepEqual(f.store.read(t.id,'b').events,before.events);
  assert.deepEqual(f.store.pendingUserRequestNotifications('a'),[]);
  assert.deepEqual(f.store.pendingUserRequestNotifications('b'),[]);
  assert.equal(f.store.listForHumanUi().snapshot.userRequestCount,0);
  const legitimate=f.store.block(t.id,'b','User device inaccessible','user',[],'无需重装或重启；请在设备上扫码并回传结果。',{kind:'manual',limitation:'Agent没有用户操作权限，设备仅在本人手中且无远程接口。'});
  assert.equal(legitimate.block?.userRequestNeedsReview,undefined);
  assert.equal(f.store.pendingUserRequestNotifications('b').length,1);
 }finally{f.close();}
});

test('replacing a user request with an internal dependency withdraws queued notifications without unblocking', () => {
 const f=fixture();try{
  const t=f.create(),dep=f.create();
  const requested=f.store.block(t.id,'b','Need physical test','user',[],'Use the physical device and return the result',{kind:'manual',limitation:'The device has no remote interface'});
  const seq=requested.events.at(-1)!.seq, snapshot=f.store.listForHumanUi().snapshot;
  const updated=f.store.block(t.id,'b','User result received; waiting for peer fix','side 3',[dep.id]);
  assert(updated.block); assert.equal(updated.block.userRequest,undefined);
  assert.deepEqual(updated.block.dependencies,[dep.id]);assert.equal(updated.state,'open');
  for(const side of ['a','b']) {
   assert.deepEqual(f.store.pendingUserRequestNotifications(side),[]);
   assert.equal(f.store.claimUserRequestNotification(side,t.id,seq),undefined);
  }
  assert.equal(f.store.listForHumanUi().snapshot.userRequestCount,0);
  assert.equal(f.store.listForHumanUi({snapshot}).snapshot.userRequestCount,1);
  assert.equal(updated.events.find(e=>e.seq===seq)?.data.userRequest,requested.block?.userRequest);
  f.store.check(t.id,'b',1,true);
  assert.throws(()=>f.store.complete(t.id,'b','a'.repeat(40),'skip internal dependency'),/unblock/);
 }finally{f.close();}
});

test('old writers cannot surface contradictory requests or starve valid notifications', () => {
 const f=fixture();try{
  let first=0,seq=0;
  for(let i=0;i<51;i++) {
   const t=f.create(); const inserted=f.legacy(t.id,'b','无用户操作；等待3侧交证。',{kind:'input',limitation:'本阻塞为工程依赖，无需用户输入。'});
   if(!i){first=t.id;seq=inserted;}
  }
  const original=f.store.read(first,'b');
  assert.equal(original.block?.userRequestNeedsReview,true);
  assert.equal(f.store.claimUserRequestNotification('b',first,seq),undefined);
  const theme:any={fg:(_:string,v:string)=>v,strikethrough:(v:string)=>v};
  assert.match(taskLines(original,true,theme,160).join('\n'),/用户请求待 Agent 复核/);
  const valid=f.create();f.store.block(valid.id,'b','Physical test needed','user',[],'Operate the device and return the screen',{kind:'manual',limitation:'Only the user has the device; no remote interface'});
  const pending=f.store.pendingUserRequestNotifications('b',1);
  assert.equal(pending.length,1);assert.equal(pending[0].taskId,valid.id);
  assert.equal(f.store.listForHumanUi().snapshot.userRequestCount,1);
  assert(f.store.acquireResume('b','b','reviewer'));
  assert(f.store.reconcileResume('b','reviewer').queued.includes(first));
  assert.equal(f.store.read(first,'b').block?.userRequest,original.block?.userRequest,'history is not rewritten');
 }finally{f.close();}
});

test('approval work is rejected even with an authority quote or disguised as manual/input; actual user operations remain', () => {
 const f=fixture();try{
  const t=f.create();
  const action={kind:'authorization',limitation:'Needs approval',authority:'User: ask before restarting'} as any;
  assert.throws(()=>f.store.block(t.id,'b','Needs approval','user',[],'Approve restarting the service',action),/Approvals belong to Agents/);
  for (const kind of ['manual','input'] as const) {
   for (const request of ['请回复「批准仅更新并重启 46187 Mock」', 'Please approve deployment']) {
    assert.throws(()=>f.store.block(t.id,'b','Needs approval','user',[],request,{kind,limitation:'Only the user can approve'}),/Approvals belong to Agents/);
   }
  }
  assert.equal(f.store.read(t.id,'b').block,null);
  assert.deepEqual(f.store.pendingUserRequestNotifications('b'),[]);
  const blocked=f.store.block(t.id,'b','Physical test','user',[],'Operate the device and return the screen',{kind:'manual',limitation:'The physical device has no remote interface'});
  f.store.check(t.id,'b',1,true);
  assert.throws(()=>f.store.complete(t.id,'b','a'.repeat(40),'skip'),/unblock/);
  assert.throws(()=>f.store.unblock(t.id,'a','override'),/assignee/);
  const theme:any={fg:(_:string,v:string)=>v,strikethrough:(v:string)=>v};
  const view=taskLines(blocked,true,theme,160).join('\n');assert.match(view,/需要你配合/);assert.doesNotMatch(view,/需要你决定/);
  const input=f.create();f.store.block(input.id,'b','Missing external source','user',[],'Provide the source document through the private input channel',{kind:'input',limitation:'The source exists only on the user device; all available project inputs have been checked'});
  assert.equal(f.store.listForHumanUi().snapshot.userRequestCount,2);
 }finally{f.close();}
});

test('upgrade returns legacy requests to both Agents once, without notifying user, granting permission or reviving paused sides', () => {
 const f=fixture();let upgraded:HandoffStore|undefined;try{
  const t=f.create(),seq=f.legacy(t.id,'b','请回复「批准更新并重启46187」',{kind:'authorization',limitation:'Needs approval',authority:'Original user restriction'} as any);
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
