import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { HandoffStore } from '../store.ts';
import { WorkspaceLedger, workspaceOccupancy } from '../workspaces.ts';
import { IntegrationQueue } from '../integration-store.ts';
import { IntegrationWorker, integrationRepository } from '../integration.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-reconcile-')), repo = join(root, 'project'), remote = join(root, 'remote.git');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(root,'init','--bare','--initial-branch=main',remote);git(root,'clone',remote,repo);
  git(repo,'config','user.name','test');git(repo,'config','user.email','test@example.invalid');
  writeFileSync(join(repo,'base'),'base\n');git(repo,'add','.');git(repo,'commit','-m','base');git(repo,'push','origin','main');
  const base=git(repo,'rev-parse','HEAD'), store=new HandoffStore(join(root,'state')), ledger=new WorkspaceLedger(store), queue=new IntegrationQueue(store);
  for(const id of ['a','b','c'])store.register({id,name:id,sessionId:id,pid:2147483000,worktree:repo,branch:'main'});
  const checks=[{command:process.execPath,args:['-e',"require('node:assert').ok(require('node:fs').existsSync('base'))"]}];
  const branch=(name:string)=>{const path=join(root,name);git(repo,'worktree','add','-b',name,path,base);return path;};
  const commit=(path:string,name:string)=>{writeFileSync(join(path,name),name+'\n');git(path,'add',name);git(path,'commit','-m',name);return git(path,'rev-parse','HEAD');};
  const task=()=>store.create({to:'b',subject:'deliver exact range',body:'authorized implementation',items:['done'],requiresIntegration:true},'a');
  const deliver=async(path:string,id:number,tip:string)=>{store.check(id,'b',1,true);const d=await ledger.snapshot(path,'b',id,tip);store.complete(id,'b',tip,'implemented',d.id);return d;};
  const enqueue=(id:number,d:Awaited<ReturnType<typeof deliver>>,path=repo)=>{
    const t=integrationRepository(path),policy=ledger.policy(t.targetKey)!;
    return queue.enqueue({taskId:id,actor:'a',commit:d.tip,repo:t.repo,remoteFingerprint:t.fingerprint,targetKey:t.targetKey,reviewedBase:d.base,checks,policyRevision:policy.revision,deliveryId:d.id,approvedCommits:d.commits,note:'Reviewed whole frozen range; integration authorized'});
  };
  return {root,repo,remote,base,store,ledger,queue,git,checks,branch,commit,task,deliver,enqueue,
    async consume(){const w=new IntegrationWorker(store,integrationRepository(repo).repo);try{await w.tick();}finally{await w.stop();}},
    close(){queue.close();ledger.close();store.close();rmSync(root,{recursive:true,force:true});}};
}

test('audit uses one remote snapshot, one file scan per worktree and one material ref enumeration', async () => {
 const f=fixture(), previous=process.env.GIT_TRACE2_EVENT;try{
  const path=f.branch('registered');await f.ledger.register(path,'b');
  for(let i=0;i<8;i++)f.git(f.repo,'branch',`same-tip-${i}`,f.base);
  for(let i=0;i<40;i++){
   const t=f.store.create({to:'b',subject:'historic material',body:'evidence',items:['done'],requiresIntegration:false},'a');
   f.store.check(t.id,'b',1,true);f.store.complete(t.id,'b',f.base,'material');f.store.closeTask(t.id,'a',f.base,'accepted');
   if(i===0)await f.ledger.preserveMaterial(f.repo,'b',t.id,f.base);
  }
  const trace=join(f.root,'trace.jsonl');process.env.GIT_TRACE2_EVENT=trace;
  const report=await f.ledger.reconcile(f.repo,'b');
  assert.equal(report.complete,true,JSON.stringify(report.errors));
  const commands=readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(e=>e.event==='start').map(e=>e.argv as string[]);
  assert.equal(commands.filter(a=>a[1]==='fetch').length,1);
  assert.equal(commands.filter(a=>a[1]==='ls-remote').length,0);
  assert.equal(commands.filter(a=>a[1]==='status').length,2,'do not rescan registered worktrees');
  assert.equal(commands.filter(a=>a[1]==='ls-files').length,2);
  assert.equal(commands.filter(a=>a[1]==='rev-parse'&&a.includes('--verify')).length,0,'full material hashes need no per-task Git');
  assert.equal(commands.filter(a=>a[1]==='rev-list'&&a[2]===f.base&&a[3]==='--not').length,2,'one shared ref lookup plus one shared branch status');
 }finally{if(previous===undefined)delete process.env.GIT_TRACE2_EVENT;else process.env.GIT_TRACE2_EVENT=previous;f.close();}
});

test('atomic audit refresh drops deleted remote heads and refuses absent main or a failed refresh', async () => {
 const f=fixture();try{
  f.git(f.repo,'push','origin',`${f.base}:refs/heads/old`);
  assert.ok((await f.ledger.reconcile(f.repo)).remoteBranches.some(b=>b.branch==='refs/heads/old'));
  f.git(f.remote,'update-ref','-d','refs/heads/old',f.base);
  assert.ok(!(await f.ledger.reconcile(f.repo)).remoteBranches.some(b=>b.branch==='refs/heads/old'));
  f.git(f.remote,'update-ref','-d','refs/heads/main',f.base);
  const absent=await f.ledger.reconcile(f.repo);assert.equal(absent.complete,false);assert.equal(absent.remote,null);
  assert.match(absent.errors.join(),/Remote main is missing/);
  f.git(f.remote,'update-ref','refs/heads/main',f.base);
  assert.equal((await f.ledger.reconcile(f.repo)).complete,true);
  f.git(f.repo,'remote','set-url','origin','https://127.0.0.1:1/missing.git');
  const failed=await f.ledger.reconcile(f.repo);assert.equal(failed.remote,null);assert.equal(failed.complete,false);
  assert.deepEqual(failed.remoteBranches,[],'never treat cached audit refs as a fresh remote result');
 }finally{f.close();}
});

test('batched material lookup still validates task access, acceptance, object type and exact commit', async () => {
 const f=fixture();try{
  const p=f.branch('materials'),tip=f.commit(p,'accepted.md');
  const t=f.store.create({to:'b',subject:'material',body:'private',items:['done'],requiresIntegration:false},'a');
  f.store.check(t.id,'b',1,true);f.store.complete(t.id,'b',tip,'material');f.store.closeTask(t.id,'a',tip,'accepted');
  const material=await f.ledger.preserveMaterial(f.repo,'b',t.id,tip);
  const state=async(actor:string)=>(await f.ledger.reconcile(f.repo,actor)).branches.find(b=>b.branch==='refs/heads/materials')!.state;
  assert.equal(await state('b'),'materials-preserved');assert.equal(await state('c'),'unaccounted');
  f.git(f.repo,'update-ref',material.ref,f.base,tip);assert.equal(await state('b'),'unaccounted');
  const blob=f.git(p,'rev-parse',`${tip}:accepted.md`);f.git(f.repo,'update-ref',material.ref,blob,f.base);assert.equal(await state('b'),'unaccounted');
  f.git(f.repo,'update-ref',material.ref,tip,blob);assert.equal(await state('b'),'materials-preserved');
  f.git(f.repo,'update-ref','-d',material.ref,tip);assert.equal(await state('b'),'unaccounted');
 }finally{f.close();}
});

test('unified cleanup separates accepted archives, eligible branches and retained obligations', async () => {
 const f=fixture();try{
  const material=f.branch('material'),tip=f.commit(material,'accepted.md');
  const t=f.store.create({to:'b',subject:'material',body:'private evidence',items:['review'],requiresIntegration:false},'a');
  await f.ledger.register(material,'b',[t.id]);
  f.store.check(t.id,'b',1,true);f.store.complete(t.id,'b',tip,'material');f.store.closeTask(t.id,'a',tip,'accepted');
  const preserved=await f.ledger.preserveMaterial(f.repo,'b',t.id,tip);
  f.git(f.repo,'worktree','remove',material);
  const open=f.branch('open'),pending=f.task();await f.ledger.register(open,'b',[pending.id]);f.git(f.repo,'worktree','remove',open);
  const other=f.branch('other');await f.ledger.register(other,'c');f.git(f.repo,'worktree','remove',other);
  f.git(f.repo,'branch','unregistered',f.base);
  f.git(f.repo,'push','origin','refs/heads/material');
  const plan=await f.ledger.cleanupPlan(f.repo,'b');
  assert.equal(plan.summary.eligible,1);assert.equal(plan.summary.retained,3);
  assert.equal(plan.branches.find(b=>b.branch==='refs/heads/material')!.state,'materials-preserved');
  assert.match(plan.branches.find(b=>b.branch==='refs/heads/open')!.reasons.join(),/尚未关闭/);
  assert.match(plan.branches.find(b=>b.branch==='refs/heads/other')!.reasons.join(),/归属其他侧/);
  assert.match(plan.branches.find(b=>b.branch==='refs/heads/unregistered')!.reasons.join(),/未登记归属/);
  assert.equal(plan.archives.find(a=>a.ref===preserved.ref)!.acceptedMaterial,true);
  assert.equal(plan.summary.remote,1);
  const result=await f.ledger.cleanup(f.repo,'b',plan.branches.map(b=>({branch:b.branch,expectedTip:b.tip})),'Reviewed exact tips; retire accepted material only');
  assert.equal(result.retired,1);assert.equal(result.retained,3);assert.equal(result.remoteBranchesRemoved,false);
  assert.throws(()=>f.git(f.repo,'rev-parse','--verify','refs/heads/material'));
  assert.equal(f.git(f.repo,'rev-parse','refs/heads/open'),f.base);
  assert.equal(f.git(f.remote,'rev-parse','refs/heads/material'),tip,'remote is explicitly retained');
  const after=await f.ledger.cleanupPlan(f.repo,'b');
  assert.equal(after.branches.length,3);assert.equal(after.summary.eligible,0);assert.equal(after.archives.length,2);
  assert.equal(f.git(f.repo,'show',`${preserved.ref}:accepted.md`),'accepted.md');
  assert.equal(f.git(f.repo,'rev-parse','main'),f.base);
  assert.doesNotMatch(JSON.stringify(after),/private evidence/);
 }finally{f.close();}
});

test('cleanup rechecks exact tips and continues safe items without expanding a reviewed batch',async()=>{
 const f=fixture();try{
  for(const name of ['advanced','safe','unselected']){const p=f.branch(name);await f.ledger.register(p,'b');f.git(f.repo,'worktree','remove',p);}
  const plan=await f.ledger.cleanupPlan(f.repo,'b');
  const newTip=f.commit(f.repo,'new-main');f.git(f.repo,'push','origin','main');
  f.git(f.repo,'update-ref','refs/heads/advanced',newTip,f.base);
  const targets=plan.branches.filter(b=>b.branch!=='refs/heads/unselected').map(b=>({branch:b.branch,expectedTip:b.tip}));
  const result=await f.ledger.cleanup(f.repo,'b',targets,'Reviewed two tips only');
  assert.equal(result.retired,1);assert.equal(result.retained,1);assert.match(result.results[0].reason!,/changed/);
  assert.equal(f.git(f.repo,'rev-parse','refs/heads/advanced'),newTip);
  assert.equal(f.git(f.repo,'rev-parse','refs/heads/unselected'),f.base);
  await assert.rejects(f.ledger.cleanup(f.repo,'b',[targets[0],targets[0]],'duplicate'),/unique/);
  await assert.rejects(f.ledger.cleanup(f.repo,'b',[{branch:'refs/heads/main',expectedTip:newTip}],'protected'),/main is protected/);
  f.git(f.repo,'remote','set-url','origin','https://127.0.0.1:1/missing.git');
  const unavailable=await f.ledger.cleanup(f.repo,'b',[{branch:'refs/heads/unselected',expectedTip:f.base}],'remote down');
  assert.equal(unavailable.retired,0);assert.equal(unavailable.retained,1);
 }finally{f.close();}
});

test('checked-out cleanup preserves code, dirty files, occupancy and changed workspace bindings',async()=>{
 const f=fixture();try{
  const code=f.branch('code'),tip=f.commit(code,'implementation.ts');await f.ledger.register(code,'b');
  const dirty=f.branch('dirty');await f.ledger.register(dirty,'b');writeFileSync(join(dirty,'untracked'),'keep');
  const busy=f.branch('busy'),w=await f.ledger.register(busy,'b');
  f.store.register({id:'live',name:'live',sessionId:'live',pid:process.pid,worktree:busy,branch:'busy'});
  const plan=await f.ledger.cleanupPlan(f.repo,'b');
  assert.match(plan.branches.find(b=>b.branch==='refs/heads/code')!.reasons.join(),/未交付/);
  assert.match(plan.branches.find(b=>b.branch==='refs/heads/dirty')!.reasons.join(),/uncommitted-files/);
  assert.match(plan.branches.find(b=>b.branch==='refs/heads/busy')!.reasons.join(),/存活/);
  const result=await f.ledger.cleanup(f.repo,'b',plan.branches.map(b=>({branch:b.branch,expectedTip:b.tip})),'must preserve these');
  assert.equal(result.retired,0);assert.equal(result.retained,3);
  assert.equal(readFileSync(join(dirty,'untracked'),'utf8'),'keep');assert.equal(f.git(code,'rev-parse','HEAD'),tip);
  f.git(busy,'switch','-c','changed');
  await f.ledger.register(busy,'b');
  await assert.rejects(f.ledger.retire(f.repo,'b',w.id,true,undefined,{branch:'refs/heads/busy',tip:f.base}),/changed since cleanup/);
  assert(existsSync(busy));
 }finally{f.close();}
});

test('closed material commits are preserved separately from main and their idle branch can retire', async () => {
 const f=fixture();try{
  const p=f.branch('material'),tip=f.commit(p,'acceptance.md');
  const t=f.store.create({to:'b',subject:'acceptance evidence',body:'materials only',items:['review'],requiresIntegration:false},'a');
  f.store.check(t.id,'b',1,true);f.store.complete(t.id,'b',tip,'evidence');f.store.closeTask(t.id,'a',tip,'accepted without code integration');
  assert.equal((await f.ledger.reconcile(f.repo,'b')).branches.find(b=>b.branch==='refs/heads/material')!.state,'unaccounted');
  const material=await f.ledger.preserveMaterial(f.repo,'b',t.id,tip);
  assert.equal(f.git(f.repo,'rev-parse',material.ref),tip);
  const report=await f.ledger.reconcile(f.repo,'b');assert.equal(report.branches.find(b=>b.branch==='refs/heads/material')!.state,'materials-preserved');
  assert.equal(f.git(f.repo,'rev-parse','main'),f.base,'material preservation never changes main');
  await assert.rejects(f.ledger.retireBranch(f.repo,'b','refs/heads/material',tip,'accepted evidence'),/still checked out/);
  f.git(f.repo,'worktree','remove',p);
  const retired=await f.ledger.retireBranch(f.repo,'b','refs/heads/material',tip,'Reviewed accepted evidence; preserve its commit');
  assert.equal(f.git(f.repo,'rev-parse',retired.ref),tip);assert.throws(()=>f.git(f.repo,'rev-parse','--verify','refs/heads/material'));
  assert.equal(f.git(f.repo,'show',`${retired.ref}:acceptance.md`),'acceptance.md');
  assert.equal((await f.ledger.reconcile(f.repo,'b')).archivedBranches.length,1);
 }finally{f.close();}
});

test('archiving a material tip never covers an unrelated code ancestor or an unaccepted task',async()=>{
 const f=fixture();try{
  const p=f.branch('mixed'),code=f.commit(p,'implementation.ts'),tip=f.commit(p,'evidence.md');
  const t=f.store.create({to:'b',subject:'evidence',body:'only the final evidence commit',items:['review'],requiresIntegration:false},'a');
  f.store.check(t.id,'b',1,true);f.store.complete(t.id,'b',tip,'evidence');
  f.git(f.repo,'worktree','remove',p);
  await assert.rejects(f.ledger.retireBranch(f.repo,'b','refs/heads/mixed',tip,'premature',[t.id]),/accepted, closed/);
  f.store.closeTask(t.id,'a',tip,'accept just the evidence');
  await assert.rejects(f.ledger.retireBranch(f.repo,'b','refs/heads/mixed',tip,'must retain code',[t.id]),/unaccounted/);
  const report=await f.ledger.reconcile(f.repo,'b'),branch=report.branches.find(b=>b.branch==='refs/heads/mixed')!;
  assert.equal(branch.state,'unaccounted');assert.equal(branch.unaccountedCommits,1);
  assert.equal(f.git(f.repo,'rev-parse','refs/heads/mixed'),tip);
  assert.equal(f.git(f.repo,'show',`${code}:implementation.ts`),'implementation.ts');
  await assert.rejects(f.ledger.preserveMaterial(f.repo,'b',f.task().id,tip),/Code deliveries/);
 }finally{f.close();}
});

test('equivalent patches are reported distinctly and retired with the original commits preserved',async()=>{
 const f=fixture();try{
  const p=f.branch('old-code'),tip=f.commit(p,'implementation');
  f.git(f.repo,'cherry-pick','--no-commit',tip);f.git(f.repo,'commit','-m','replacement delivery');
  const replacement=f.git(f.repo,'rev-parse','HEAD');assert.notEqual(replacement,tip);f.git(f.repo,'push','origin','main');
  const report=await f.ledger.reconcile(f.repo,'b');assert.equal(report.branches.find(b=>b.branch==='refs/heads/old-code')!.state,'patches-present');
  f.git(f.repo,'worktree','remove',p);
  const result=await f.ledger.retireBranch(f.repo,'b','refs/heads/old-code',tip,`Reviewed equivalent patch on main ${replacement}`);
  assert.equal(result.disposition,'patches-present');assert.equal(f.git(f.repo,'rev-parse',result.ref),tip);
  assert.equal(f.git(f.repo,'rev-parse','main'),replacement);
 }finally{f.close();}
});

test('branch retirement checks ownership, open tasks, exact tips and remote availability',async()=>{
 const f=fixture();try{
  const p=f.branch('owned'),t=f.task();await f.ledger.register(p,'b',[t.id]);f.git(f.repo,'worktree','remove',p);
  await assert.rejects(f.ledger.retireBranch(f.repo,'a','refs/heads/owned',f.base,'another owner'),/Another side owns/);
  await assert.rejects(f.ledger.retireBranch(f.repo,'b','refs/heads/owned',f.base,'not done'),/open tasks/);
  f.store.cancel(t.id,'a','unused branch');
  f.git(f.repo,'remote','set-url','origin','https://127.0.0.1:1/missing.git');
  await assert.rejects(f.ledger.retireBranch(f.repo,'b','refs/heads/owned',f.base,'remote unavailable'));
  assert.equal((await f.ledger.reconcile(f.repo,'b')).branches.find(b=>b.branch==='refs/heads/owned')!.state,'unknown');
  f.git(f.repo,'remote','set-url','origin',f.remote);
  await assert.rejects(f.ledger.retireBranch(f.repo,'b','refs/heads/owned','f'.repeat(40),'stale tip'),/Branch advanced/);
  const retired=await f.ledger.retireBranch(f.repo,'b','refs/heads/owned',f.base,'All task obligations cancelled; main covers this tip');
  assert.equal(retired.state,'retired');assert.equal((await f.ledger.reconcile(f.repo,'b')).workspaces.length,0);
  await assert.rejects(f.ledger.retireBranch(f.repo,'b','refs/heads/main',f.base,'main protected'),/main is protected/);
 }finally{f.close();}
});

test('one owner can freeze its own range, queue, push and close without another implementer', async () => {
 const f=fixture();try{
  const p=f.branch('local-owner'),t=f.store.create({subject:'own implementation',body:'authorized by user',items:['done'],requiresIntegration:true},'a');
  await f.ledger.configure(f.repo,'a',f.base,f.checks,'Reviewed current main and checks');
  const tip=f.commit(p,'own-code');f.store.check(t.id,'a',1,true);
  const d=await f.ledger.snapshot(p,'a',t.id,tip);f.store.complete(t.id,'a',tip,'implemented locally',d.id);
  assert.throws(()=>f.store.closeTask(t.id,'a',tip,'too early'),/Integrate and push/);
  const job=f.enqueue(t.id,d);assert.equal(job.reviewMode,'self');
  assert.throws(()=>f.store.cancel(t.id,'a','race queue'),/queued\/running/);
  await f.consume();const pushed=f.queue.read(job.jobId);assert.equal(pushed.state,'pushed',pushed.note);
  assert.equal(pushed.reviewMode,'self');assert.equal(f.store.read(t.id,'a').integration!.reviewMode,'self');
  assert.throws(()=>f.store.cancel(t.id,'a','hide pushed code'),/pushed/);
  const closed=f.store.closeTask(t.id,'a',tip,'Self-verified; no independent review was claimed');
  assert.equal(closed.state,'closed');assert.equal(closed.events.at(-1)!.data.reviewMode,'self');
  assert.equal(f.git(f.repo,'show',pushed.mainCommit!+':own-code'),'own-code');
  const report=await f.ledger.reconcile(f.repo,'a');assert.equal(report.workspaces[0].eligibleForRetirement,true);
  assert.throws(()=>f.store.read(t.id,'b'),/not found or not visible/);
 }finally{f.close();}
});

test('cancellation retires empty task obligations but cannot hide abandoned code or files', async () => {
 const f=fixture();try{
  const p=f.branch('cancelled-code'),t=f.task(),tip=f.commit(p,'keep-code'),d=await f.deliver(p,t.id,tip);
  f.store.cancel(t.id,'a','mistaken delegation');
  const report=await f.ledger.reconcile(f.repo,'b'),w=report.workspaces[0];
  assert.ok(w.blockers!.includes('branch-not-integrated'));assert.ok(!w.blockers!.includes('open-tasks'));
  assert.ok(w.undelivered!.includes(tip));assert.deepEqual(w.pendingDeliveries,[]);
  assert.equal(f.git(p,'rev-parse',d.ref),tip,'cancel keeps the immutable code snapshot');
  await assert.rejects(f.ledger.retire(f.repo,'b',w.workspace.id,true),/still has/);
  assert.equal(existsSync(p),true);
  const empty=f.branch('cancelled-empty'),local=f.store.create({subject:'unused',body:'withdrawn',items:['done'],requiresIntegration:true},'a');
  const registration=await f.ledger.register(empty,'a',[local.id]);f.store.cancel(local.id,'a','not needed');
  const clean=(await f.ledger.reconcile(f.repo,'a')).workspaces.find(x=>x.workspace.id===registration.id)!;
  assert.equal(clean.eligibleForRetirement,true);
 }finally{f.close();}
});

test('frozen C2 delivery never includes C3; closing its task cannot hide new code or files',async()=>{
 const f=fixture();try{
  await f.ledger.configure(f.repo,'a',f.base,f.checks,'Reviewed existing main and project checks');
  const path=f.branch('feature'),t=f.task(),c2=f.commit(path,'C2'),d=await f.deliver(path,t.id,c2);
  assert.match(d.ref,/^refs\/pi-cowork\/deliveries\//);
  const job=f.enqueue(t.id,d),c3=f.commit(path,'C3');
  await f.consume();const done=f.queue.read(job.jobId);assert.equal(done.state,'pushed',done.note);
  f.git(f.repo,'merge-base','--is-ancestor',c2,done.mainCommit!);
  assert.throws(()=>f.git(f.repo,'merge-base','--is-ancestor',c3,done.mainCommit!));
  f.store.closeTask(t.id,'a',c2,'reviewed and pushed');
  writeFileSync(join(path,'untracked'),'keep');writeFileSync(join(path,'.gitignore'),'ignored\n');writeFileSync(join(path,'ignored'),'keep too');
  const r=await f.ledger.reconcile(f.repo,'b'),w=r.workspaces[0];assert.ok('undelivered' in w);assert.deepEqual(w.undelivered,[c3]);assert.equal(w.eligibleForRetirement,false);assert.ok(w.ignored!.includes('ignored'));
  await assert.rejects(f.ledger.retire(f.repo,'b',w.workspace.id,true),/still has/);assert.equal(readFileSync(join(path,'ignored'),'utf8'),'keep too');
  assert.equal((await f.ledger.reconcile(f.repo,'c')).workspaces.length,0);
 }finally{f.close();}
});

test('an interrupted legacy integration retains its candidate when new CoWork refs are used',async()=>{
 const f=fixture();try{
  await f.ledger.configure(f.repo,'a',f.base,f.checks,'reviewed existing main');
  const p=f.branch('legacy'),t=f.task(),tip=f.commit(p,'ready'),d=await f.deliver(p,t.id,tip),job=f.enqueue(t.id,d);
  const legacy=`refs/pi-handoff/integrations/${job.jobId}/candidate`;
  f.git(f.repo,'update-ref',legacy,tip);f.git(p,'push','origin',`${tip}:main`);
  await f.consume();const result=f.queue.read(job.jobId);assert.equal(result.state,'pushed',result.note);
  assert.equal(f.git(f.repo,'rev-parse',legacy),tip);
  assert.equal(f.git(f.repo,'rev-parse',`refs/pi-cowork/integrations/${job.jobId}/candidate`),tip);
  assert.deepEqual(await f.ledger.outsideQueue(f.repo,tip),[]);
 }finally{f.close();}
});

test('workspace ownership, switched branches, immutable delivery range and unauthorized subranges are rejected',async()=>{
 const f=fixture();try{
  const p=f.branch('feature'),t=f.task(),c1=f.commit(p,'first'),c2=f.commit(p,'second');
  const w=await f.ledger.register(p,'b',[t.id]);await assert.rejects(f.ledger.register(p,'a'),/another owner/);
  const d=await f.deliver(p,t.id,c2);const raw=new DatabaseSync(f.store.dbPath);
  assert.throws(()=>raw.prepare('UPDATE handoff_deliveries SET tip=? WHERE id=?').run(c1,d.id),/append-only/);raw.close();
  await f.ledger.configure(f.repo,'a',f.base,f.checks,'reviewed checks');
  const target=integrationRepository(f.repo),policy=f.ledger.policy(target.targetKey)!;
  assert.throws(()=>f.queue.enqueue({taskId:t.id,actor:'a',commit:c2,repo:target.repo,remoteFingerprint:target.fingerprint,targetKey:target.targetKey,reviewedBase:c1,checks:f.checks,policyRevision:policy.revision,deliveryId:d.id,approvedCommits:[c2],note:'skipped earlier range'}),/entire immutable/);
  f.git(p,'switch','-c','unexpected');const r=await f.ledger.reconcile(f.repo,'b');assert.equal(r.complete,false);assert.equal(r.workspaces[0].eligibleForRetirement,false);
  await assert.rejects(f.ledger.retire(f.repo,'a',w.id),/not owned/);
 }finally{f.close();}
});

test('the owner can register a new branch in the same clean worktree without losing deliveries or ignored data',async()=>{
 const f=fixture();try{
  await f.ledger.configure(f.repo,'a',f.base,f.checks,'reviewed existing main');
  const p=f.branch('old-task'),t=f.task(),tip=f.commit(p,'old-code'),d=await f.deliver(p,t.id,tip);
  const job=f.enqueue(t.id,d);await f.consume();assert.equal(f.queue.read(job.jobId).state,'pushed');
  f.store.closeTask(t.id,'a',tip,'reviewed and integrated');
  const next=f.task();await f.ledger.register(p,'b',[next.id]);
  f.store.block(next.id,'b','stale branch registration','workspace tool');
  f.git(p,'switch','-c','new-task',f.queue.read(job.jobId).mainCommit!);f.git(p,'branch','-d','old-task');
  writeFileSync(join(f.repo,'.git','info','exclude'),'runtime\n');writeFileSync(join(p,'runtime'),'keep runtime data');
  const updated=await f.ledger.register(p,'b',[next.id]);
  assert.equal(updated.id,d.workspaceId);assert.equal(updated.branch,'refs/heads/new-task');assert.equal(updated.base,d.base);
  assert.deepEqual(updated.tasks,[t.id,next.id]);assert.deepEqual(f.ledger.delivery(d.id),d);
  assert.equal(f.git(p,'rev-parse',d.ref),tip);assert.equal(readFileSync(join(p,'runtime'),'utf8'),'keep runtime data');
  assert.ok(f.store.read(next.id,'b').block,'registration cannot waive task review');
  const raw=new DatabaseSync(f.store.dbPath);try{
   const events=raw.prepare("SELECT data_json FROM handoff_workspace_events WHERE workspace_id=? AND kind='register' ORDER BY seq").all(updated.id);
   assert.equal(events.length,2);assert.equal(JSON.parse(String(events[1].data_json)).previousBranch,'refs/heads/old-task');
  }finally{raw.close();}
  assert.deepEqual(await f.ledger.register(p,'b',[next.id]),updated,'retry is idempotent');
  const report=await f.ledger.reconcile(f.repo,'b');assert.ok(!report.workspaces[0].error);assert.ok(report.actualWorktrees.find(w=>w.path===p)!.registered);
  f.store.unblock(next.id,'b','verified refreshed registration');const nextTip=f.commit(p,'new-code');
  const nextDelivery=await f.deliver(p,next.id,nextTip);assert.equal(nextDelivery.workspaceId,d.workspaceId);assert.equal(nextDelivery.base,d.base);
 }finally{f.close();}
});

test('branch registration refresh refuses other owners, dirty files, lost commits and a checked-out previous branch',async()=>{
 const f=fixture();try{
  const p=f.branch('previous'),tip=f.commit(p,'unsubmitted'),w=await f.ledger.register(p,'b');
  f.git(p,'switch','-c','replacement',f.base);
  await assert.rejects(f.ledger.register(p,'a'),/another owner/);
  await assert.rejects(f.ledger.register(p,'b'),/all previous branch commits/);
  assert.equal(f.ledger.read(w.id).branch,'refs/heads/previous');assert.equal(f.git(p,'rev-parse','previous'),tip);
  f.git(p,'merge','--ff-only','previous');writeFileSync(join(p,'untracked'),'preserve');
  await assert.rejects(f.ledger.register(p,'b'),/uncommitted files/);assert.equal(readFileSync(join(p,'untracked'),'utf8'),'preserve');
  rmSync(join(p,'untracked'));
  const other=join(f.root,'old-checkout');f.git(f.repo,'worktree','add',other,'previous');
  await assert.rejects(f.ledger.register(p,'b'),/still checked out/);f.git(f.repo,'worktree','remove',other);
  const refreshed=await f.ledger.register(p,'b');assert.equal(refreshed.id,w.id);assert.equal(refreshed.base,w.base);
  assert.equal(f.git(p,'rev-parse','previous'),tip,'old branch is preserved');
 }finally{f.close();}
});

test('branch registration refresh preserves missing-branch deliveries and refuses pending integrations',async()=>{
 const f=fixture();try{
  await f.ledger.configure(f.repo,'a',f.base,f.checks,'reviewed existing main');
  const p=f.branch('snapshot-branch'),t=f.task(),tip=f.commit(p,'snapshot'),d=await f.deliver(p,t.id,tip);
  f.git(p,'switch','-c','replacement',f.base);f.git(p,'branch','-D','snapshot-branch');
  await assert.rejects(f.ledger.register(p,'b'),/every preserved delivery/);
  f.git(p,'merge','--ff-only',tip);f.enqueue(t.id,d);
  await assert.rejects(f.ledger.register(p,'b'),/pending integrations/);
  assert.equal(f.ledger.read(d.workspaceId).branch,'refs/heads/snapshot-branch');assert.deepEqual(f.ledger.delivery(d.id),d);
 }finally{f.close();}
});

test('unregistered, detached and remote-only branches appear, and remote failure never reports a clean project',async()=>{
 const f=fixture();try{
  const p=f.branch('unknown'),tip=f.commit(p,'missing');f.git(p,'push','origin','unknown');
  f.git(f.repo,'worktree','add','--detach',join(f.root,'detached'),tip);
  const r=await f.ledger.reconcile(f.repo,'b');assert.equal(r.complete,true);assert.deepEqual(r.unregistered[0].unintegrated,[tip]);assert.deepEqual(r.detached[0].unintegrated,[tip]);assert.ok(r.remoteBranches.some(b=>b.branch==='refs/heads/unknown'&&b.unintegrated?.includes(tip)));
  f.git(f.repo,'remote','set-url','origin','https://127.0.0.1:1/missing.git');const failed=await f.ledger.reconcile(f.repo,'b');assert.equal(failed.complete,false);assert.equal(failed.remote,null);assert.equal(failed.unregistered[0].unintegrated,null);
 }finally{f.close();}
});

test('same target across clones shares one live lock; a worker can drain another local clone queue',async()=>{
 const f=fixture();try{
  await f.ledger.configure(f.repo,'a',f.base,f.checks,'reviewed main');
  const p=f.branch('feature'),t=f.task(),tip=f.commit(p,'one'),d=await f.deliver(p,t.id,tip),first=f.enqueue(t.id,d);
  const clone=join(f.root,'clone');f.git(f.root,'clone',f.remote,clone);const target=integrationRepository(clone);assert.equal(target.targetKey,integrationRepository(f.repo).targetKey);
  const other=new IntegrationQueue(f.store);try{
   assert.equal(f.queue.claim(integrationRepository(f.repo).repo,target.targetKey)?.jobId,first.jobId);
   assert.equal(other.claim(target.repo,target.targetKey),null);
   f.queue.release(integrationRepository(f.repo).repo);
   const worker=new IntegrationWorker(f.store,target.repo);try{await worker.tick();}finally{await worker.stop();}
   assert.equal(f.queue.read(first.jobId).state,'pushed');
  }finally{other.close();}
 }finally{f.close();}
});

test('a reviewer in an independent clone can enqueue the same frozen delivery after fetching its code',async()=>{
 const f=fixture();try{
  await f.ledger.configure(f.repo,'a',f.base,f.checks,'reviewed baseline');
  const p=f.branch('feature'),t=f.task(),tip=f.commit(p,'from-other-clone'),d=await f.deliver(p,t.id,tip);
  f.git(p,'push','origin','feature');
  const clone=join(f.root,'review-clone');f.git(f.root,'clone',f.remote,clone);
  const job=f.enqueue(t.id,d,clone);
  await f.consume();
  const done=f.queue.read(job.jobId);assert.equal(done.state,'pushed',done.note);
  assert.equal(done.repo,integrationRepository(clone).repo);
  f.git(clone,'merge-base','--is-ancestor',tip,done.mainCommit!);
 }finally{f.close();}
});

test('approved project checks cannot weaken and external main updates block until explicitly reviewed',async()=>{
 const f=fixture();try{
  const policy=await f.ledger.configure(f.repo,'a',f.base,f.checks,'reviewed baseline');
  const p=f.branch('feature'),t=f.task(),tip=f.commit(p,'one'),d=await f.deliver(p,t.id,tip),target=integrationRepository(f.repo);
  assert.throws(()=>f.queue.enqueue({taskId:t.id,actor:'a',commit:tip,repo:target.repo,remoteFingerprint:target.fingerprint,targetKey:target.targetKey,reviewedBase:f.base,checks:[{command:process.execPath,args:['-e','0']}],policyRevision:policy!.revision,deliveryId:d.id,approvedCommits:d.commits,note:'skip tests'}),/without weakening/);
  const job=f.enqueue(t.id,d);await assert.rejects(f.ledger.configure(f.repo,'a',f.base,f.checks,'change pending policy'),/pending/);
  const outsider=f.commit(f.repo,'outside');f.git(f.repo,'push','origin','main');
  await f.consume();assert.equal(f.queue.read(job.jobId).state,'blocked');assert.match(f.queue.read(job.jobId).note,/Queue-external/);
  const r=await f.ledger.reconcile(f.repo,'a');assert.deepEqual(r.outsideQueue,[outsider]);assert.equal(r.policy!.baseline,f.base);
  await f.ledger.configure(f.repo,'a',outsider,f.checks,'Reviewed outsider diff explicitly');assert.deepEqual((await f.ledger.reconcile(f.repo,'a')).outsideQueue,[]);
 }finally{f.close();}
});

test('local main fast-forwards beside a live reader and preserves unrelated edits, untracked and ignored data',async()=>{
 const f=fixture();let child:ReturnType<typeof spawn>|undefined;try{
  const p=f.branch('feature'),tip=f.commit(p,'one');f.git(p,'push','origin',`${tip}:main`);
  writeFileSync(join(f.repo,'base'),'uncommitted local edit\n');
  writeFileSync(join(f.repo,'untracked'),'preserve');
  writeFileSync(join(f.repo,'.git','info','exclude'),'cache.tmp\n');writeFileSync(join(f.repo,'cache.tmp'),'ignored runtime data');
  f.git(f.repo,'config','merge.autoStash','true');
  child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:f.repo,stdio:'ignore'});
  await new Promise<void>(resolve=>child!.once('spawn',resolve));
  const synced=await f.ledger.syncMain(p);assert.equal(synced.state,'synced',JSON.stringify(synced));
  assert.equal(f.git(f.repo,'rev-parse','main'),tip);assert.equal(child.exitCode,null);
  assert.equal(readFileSync(join(f.repo,'one'),'utf8'),'one\n');
  assert.equal(readFileSync(join(f.repo,'base'),'utf8'),'uncommitted local edit\n');
  assert.equal(readFileSync(join(f.repo,'untracked'),'utf8'),'preserve');assert.equal(readFileSync(join(f.repo,'cache.tmp'),'utf8'),'ignored runtime data');
  assert.equal(f.git(f.repo,'stash','list'),'');
  f.commit(f.repo,'local-only');const newer=f.commit(p,'two');f.git(p,'push','origin',`${newer}:main`);
  const diverged=await f.ledger.syncMain(p);assert.equal(diverged.state,'blocked');assert.match(diverged.reason!,/diverged/);
 }finally{if(child){child.kill();await new Promise<void>(resolve=>child!.once('exit',()=>resolve()));}f.close();}
});

for(const kind of ['modified','untracked','ignored','git-operation'])test(`main synchronization preserves a conflicting ${kind} file and reports the actual Git blocker`,async()=>{
 const f=fixture();try{
  const p=f.branch('feature');
  const file=kind==='modified'?'base':'one';
  writeFileSync(join(p,file),'remote change\n');f.git(p,'add',file);f.git(p,'commit','-m','remote change');const tip=f.git(p,'rev-parse','HEAD');f.git(p,'push','origin',`${tip}:main`);
  if(kind==='ignored')writeFileSync(join(f.repo,'.git','info','exclude'),'one\n');
  const path=kind==='git-operation'?join(f.repo,'.git','MERGE_HEAD'):join(f.repo,file);
  writeFileSync(path,kind==='git-operation'?f.base:'local data must survive\n');
  const before=readFileSync(path,'utf8'),r=await f.ledger.syncMain(p);
  assert.equal(r.state,'blocked',JSON.stringify(r));assert.match(r.reason!,kind==='git-operation'?/unfinished Git operation/:/Git refused safe/);
  assert.equal(readFileSync(path,'utf8'),before);assert.equal(f.git(f.repo,'rev-parse','main'),f.base);
  assert.equal(f.git(f.repo,'stash','list'),'');
  const audit=await f.ledger.reconcile(p,'b');assert.equal(audit.localMainStatus.state,'blocked');
 }finally{f.close();}
});

test('concurrent local synchronizations return busy instead of holding up other sides',async()=>{
 const f=fixture(),other=new WorkspaceLedger(f.store);try{
  const p=f.branch('feature'),tip=f.commit(p,'one');f.git(p,'push','origin',`${tip}:main`);
  const [a,b]=await Promise.all([f.ledger.syncMain(p),other.syncMain(p)]);
  assert.equal(a.state,'synced');assert.equal(b.state,'busy');assert.equal(f.git(f.repo,'rev-parse','main'),tip);
 }finally{other.close();f.close();}
});

test('an idle local main synchronizes independently after the pushed job is recorded',async()=>{
 const f=fixture();try{
  await f.ledger.configure(f.repo,'a',f.base,f.checks,'reviewed baseline');
  const p=f.branch('feature'),t=f.task(),tip=f.commit(p,'included'),d=await f.deliver(p,t.id,tip);
  f.git(f.repo,'switch','--detach',f.base);
  const job=f.enqueue(t.id,d);await f.consume();
  const result=f.queue.read(job.jobId);assert.equal(result.state,'pushed',result.note);
  assert.match(result.note,/本地 main 独立同步/);
  assert.equal(f.git(f.repo,'rev-parse','main'),result.mainCommit);
  assert.deepEqual(await f.ledger.outsideQueue(f.repo,result.mainCommit!),[]);
 }finally{f.close();}
});

test('retirement preserves a pinned ref and removes only clean fully integrated, closed, unoccupied owned worktrees',async()=>{
 const f=fixture();try{
  await f.ledger.configure(f.repo,'a',f.base,f.checks,'reviewed');const p=f.branch('feature'),t=f.task(),tip=f.commit(p,'one'),d=await f.deliver(p,t.id,tip);const j=f.enqueue(t.id,d);await f.consume();assert.equal(f.queue.read(j.jobId).state,'pushed');f.store.closeTask(t.id,'a',tip,'integrated');
  const w=f.ledger.read(d.workspaceId,'b');assert.equal((await f.ledger.reconcile(f.repo,'b')).workspaces[0].eligibleForRetirement,true);
  const occupied=workspaceOccupancy(p);
  if (occupied) { await assert.rejects(f.ledger.retire(f.repo,'b',w.id,true),/occupancy/);assert.ok(existsSync(p));assert.equal(f.ledger.read(w.id).state,'active'); }
  else { const retired=await f.ledger.retire(f.repo,'b',w.id,true);assert.equal(retired.state,'retired');assert.equal(existsSync(p),false);assert.equal(f.git(f.repo,'rev-parse',`refs/pi-cowork/retired/${w.id}`),tip);assert.throws(()=>f.git(f.repo,'rev-parse','--verify','refs/heads/feature')); }
 }finally{f.close();}
});


test('missing integrated worktrees can retire metadata without deleting unrelated Git state',async()=>{
 const f=fixture();try{
  await f.ledger.configure(f.repo,'a',f.base,f.checks,'Reviewed current main and checks');
  const p=f.branch('missing-integrated'),t=f.task(),tip=f.commit(p,'missing-code'),d=await f.deliver(p,t.id,tip);const job=f.enqueue(t.id,d);await f.consume();assert.equal(f.queue.read(job.jobId).state,'pushed');f.store.closeTask(t.id,'a',tip,'Integrated before worktree removal');
  const w=f.ledger.read(d.workspaceId,'b');f.git(f.repo,'worktree','remove','--force',p);f.git(f.repo,'branch','-D','missing-integrated');assert.equal(existsSync(p),false);
  const retired=await f.ledger.retire(f.repo,'b',w.id,false,tip);assert.equal(retired.state,'retired');assert.equal(f.git(f.repo,'rev-parse',`refs/pi-cowork/retired/${w.id}`),tip);assert.throws(()=>f.git(f.repo,'rev-parse','--verify','refs/heads/missing-integrated'));
 }finally{f.close();}
});

test('missing worktree retirement refuses an open task even when its commit is integrated',async()=>{
 const f=fixture();try{
  const p=f.branch('missing-open-task'),task=f.store.create({subject:'still open',body:'must remain actionable',items:['done'],requiresIntegration:false},'a');
  const tip=f.commit(p,'open-task-code'),w=await f.ledger.register(p,'a',[task.id]);
  f.git(f.repo,'push','origin',`${tip}:refs/heads/main`);f.git(f.repo,'fetch','origin');f.git(f.repo,'worktree','remove','--force',p);f.git(f.repo,'branch','-D','missing-open-task');
  await assert.rejects(f.ledger.retire(f.repo,'a',w.id,false,tip),/open tasks/);assert.equal(f.ledger.read(w.id,'a').state,'active');
 }finally{f.close();}
});


test('missing worktree retirement refuses a commit that is not integrated',async()=>{
 const f=fixture();try{
  const p=f.branch('missing-unintegrated'),t=f.task(),tip=f.commit(p,'unintegrated-code'),d=await f.deliver(p,t.id,tip);const w=f.ledger.read(d.workspaceId,'b');f.git(f.repo,'worktree','remove','--force',p);f.git(f.repo,'branch','-D','missing-unintegrated');
  await assert.rejects(f.ledger.retire(f.repo,'b',w.id,false,tip),/already be integrated/);assert.equal(f.ledger.read(w.id,'b').state,'active');
 }finally{f.close();}
});
