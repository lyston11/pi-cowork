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

test('frozen C2 delivery never includes C3; closing its task cannot hide new code or files',async()=>{
 const f=fixture();try{
  await f.ledger.configure(f.repo,'a',f.base,f.checks,'Reviewed existing main and project checks');
  const path=f.branch('feature'),t=f.task(),c2=f.commit(path,'C2'),d=await f.deliver(path,t.id,c2);
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

test('safe local main synchronization fast-forwards only; dirty, occupied or divergent main stays untouched',async()=>{
 const f=fixture();let child:ReturnType<typeof spawn>|undefined;try{
  const p=f.branch('feature'),tip=f.commit(p,'one');f.git(p,'push','origin',`${tip}:main`);
  writeFileSync(join(f.repo,'uncommitted'),'preserve');assert.equal((await f.ledger.syncMain(p)).state,'blocked');assert.equal(f.git(f.repo,'rev-parse','main'),f.base);rmSync(join(f.repo,'uncommitted'));
  const occupancy=workspaceOccupancy(f.repo);
  if (occupancy) {
    assert.equal((await f.ledger.syncMain(p)).state,'blocked');
    assert.equal(f.git(f.repo,'rev-parse','main'),f.base);
    // Even without process inspection, an unchecked-out main ref can use compare-and-swap.
    f.git(f.repo,'switch','--detach',f.base);
    assert.equal((await f.ledger.syncMain(p)).state,'synced');
    f.git(f.repo,'switch','main');
  } else {
    const synced=await f.ledger.syncMain(p);assert.equal(synced.state,'synced',JSON.stringify(synced));
  }
  assert.equal(f.git(f.repo,'rev-parse','main'),tip);assert.equal(readFileSync(join(f.repo,'one'),'utf8'),'one\n');
  child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{cwd:f.repo,stdio:'ignore'});
  await new Promise<void>(resolve=>child!.once('spawn',resolve));const newer=f.commit(p,'two');f.git(p,'push','origin',`${newer}:main`);
  assert.equal((await f.ledger.syncMain(p)).state,'blocked');child.kill();await new Promise<void>(resolve=>child!.once('exit',()=>resolve()));child=undefined;
  f.commit(f.repo,'local-only');const diverged=await f.ledger.syncMain(p);assert.equal(diverged.state,'blocked');assert.match(diverged.reason!,/diverged/);assert.equal(readFileSync(join(f.repo,'local-only'),'utf8'),'local-only\n');
 }finally{child?.kill();f.close();}
});

test('a verified in-flight push can synchronize an idle local main before finalizing the job',async()=>{
 const f=fixture();try{
  await f.ledger.configure(f.repo,'a',f.base,f.checks,'reviewed baseline');
  const p=f.branch('feature'),t=f.task(),tip=f.commit(p,'included'),d=await f.deliver(p,t.id,tip);
  f.git(f.repo,'switch','--detach',f.base);
  const job=f.enqueue(t.id,d);await f.consume();
  const result=f.queue.read(job.jobId);assert.equal(result.state,'pushed',result.note);
  assert.match(result.note,/"state":"synced"/);
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
  else { const retired=await f.ledger.retire(f.repo,'b',w.id,true);assert.equal(retired.state,'retired');assert.equal(existsSync(p),false);assert.equal(f.git(f.repo,'rev-parse',`refs/pi-handoff/retired/${w.id}`),tip);assert.throws(()=>f.git(f.repo,'rev-parse','--verify','refs/heads/feature')); }
 }finally{f.close();}
});
