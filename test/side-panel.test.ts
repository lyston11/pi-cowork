import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { HandoffStore } from '../store.ts';
import { showSides } from '../side-panel.ts';
import type { Side } from '../types.ts';

const self: Side = { id:'owner', sessionId:'owner-session', name:'本侧', pid:process.pid, worktree:'/owner', branch:'main' };
const old: Side = { ...self, id:'old', sessionId:'old-session', name:'旧工具侧', pid:2147483647, worktree:'/old', branch:'task/old' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(),'pi-cowork-sides-')), store = new HandoffStore(root);
  store.register(self);store.register(old);
  return {store, close(){store.close();rmSync(root,{recursive:true,force:true});}};
}
async function panel(store: HandoffStore, run: (component:any, terminal:{rows:number}, outcome:{value?:boolean})=>void, query='') {
  const terminal = {rows:40}, outcome: {value?:boolean} = {};
  const ctx = {mode:'tui', ui:{custom:async (factory:Function, options:any)=>{
    assert.equal(options.overlay,true);assert.equal(options.overlayOptions.width,'100%');
    const component = factory({terminal,requestRender(){}},{fg:(_color:string,text:string)=>text},{},(value:boolean)=>{outcome.value=value;});
    component.focused=true;
    run(component,terminal,outcome);
    assert.doesNotThrow(()=>component.invalidate());
    return outcome.value ?? false;
  }}};
  return showSides(ctx as any,store,self,query);
}

test('side manager counts all pages, searches names/ids and fits small terminals',async()=>{
  const f=fixture();try{
    for(let i=0;i<220;i++) f.store.register({...old,id:`s${String(i).padStart(3,'0')}`,sessionId:`ss${i}`,name:`工具 ${i}`,worktree:`/workspace/${i}`});
    await panel(f.store,(p,terminal)=>{
      const render=()=>p.render(130).join('\n');
      assert.match(render(),/已登记 222 侧/);assert.match(render(),/进程存活不代表/);
      p.handleInput('\x1b[F');assert.match(render(),/工具 219/);assert.match(render(),/已载 222\/222/);
      p.handleInput('/');p.handleInput('工具 75');p.handleInput('\r');
      assert.match(render(),/匹配 1 侧/);assert.match(render(),/工具 75/);
      p.handleInput('\r');assert.match(render(),/侧详情/);assert.match(render(),/s075/);assert.match(render(),/已退出/);
      p.handleInput('\x1b[F');assert.match(render(),/未关闭交接: 0/);assert.match(render(),/自动续跑设置: 开启/);
      p.handleInput('\x1b');assert.match(render(),/项目侧管理/);
      p.handleInput('/');p.handleInput('unused');p.handleInput('\x1b');assert.match(render(),/筛选: 工具 75/);
      terminal.rows=12;
      const small=p.render(50);assert.equal(small.length,7);assert(small.every((s:string)=>visibleWidth(s)===50));
      assert.match(small.join('\n'),/工具 75/);assert.match(small.at(-2),/d删除/);
      p.handleInput('/');p.handleInput('\x15');p.handleInput('missing');p.handleInput('\r');
      assert.match(p.render(100).join('\n'),/匹配 0 侧/);
      p.handleInput('d');assert.equal(f.store.sides().length,222);
      p.handleInput('\x1b');
    });
  }finally{f.close();}
});

test('deletion is explicit, cancellable and preserves closed task history',async()=>{
  const f=fixture();try{
    const t=f.store.create({to:old.id,subject:'history',body:'secret',items:['done']},self.id);
    f.store.check(t.id,old.id,1,true);f.store.complete(t.id,old.id,'a'.repeat(40),'done');f.store.closeTask(t.id,self.id,'a'.repeat(40),'reviewed');
    const before=f.store.read(t.id,self.id).events;
    await panel(f.store,p=>{
      const render=()=>p.render(160).join('\n');
      p.handleInput('d');assert.match(render(),/确认删除侧/);assert.match(render(),/old-session/);
      p.handleInput('\r');assert.equal(f.store.sidePage().total,2,'Enter does not confirm deletion');
      p.handleInput('\x1b');assert.match(render(),/侧详情/);assert.equal(f.store.sidePage().total,2);
      p.handleInput('d');p.handleInput('y');assert.match(render(),/已登记 1 侧/);assert.match(render(),/已删除 旧工具侧/);
      assert.equal(f.store.sidePage({query:'old'}).matched,0); // filter remains old, but the project total is one
    },'old');
    assert.deepEqual(f.store.read(t.id,self.id).events,before);
    assert(f.store.sessionSide(old.sessionId)?.removedAt);
    assert.throws(()=>f.store.register(old),/removed/);
  }finally{f.close();}
});

test('side panel refuses unclosed work, live peers and stale session confirmation without stopping anyone',async()=>{
  const f=fixture();try{
    const t=f.store.create({to:old.id,subject:'open',body:'keep',items:['done']},self.id);
    assert.equal(f.store.sideForHumanUi(old.id).openTasks,1);
    await panel(f.store,p=>{
      p.handleInput('d');p.handleInput('y');assert.match(p.render(150).join('\n'),/unclosed/);
      assert.equal(f.store.resumeStatus(old.id).enabled,true);
    },'old');
    f.store.check(t.id,old.id,1,true);f.store.complete(t.id,old.id,'a'.repeat(40),'done');
    assert.equal(f.store.sideForHumanUi(old.id).openTasks,1,'completed still waits for acceptance');
    f.store.closeTask(t.id,self.id,'a'.repeat(40),'reviewed');
    f.store.register({...old,pid:process.pid});
    await panel(f.store,p=>{p.handleInput('d');p.handleInput('y');assert.match(p.render(160).join('\n'),/still running/);},'old');
    f.store.register(old);
    await panel(f.store,p=>{
      p.handleInput('d');f.store.register({...old,sessionId:'new-session'});p.handleInput('y');
      assert.match(p.render(160).join('\n'),/ownership changed/);
    },'old');
    assert.equal(f.store.sidePage().total,2);
  }finally{f.close();}
});

test('self removal requires an explicitly paused side and signals its caller to stop the listener',async()=>{
  const f=fixture();try{
    await panel(f.store,(p,_terminal,outcome)=>{
      p.handleInput('d');p.handleInput('y');assert.match(p.render(180).join('\n'),/Pause this side/);
      assert.equal(outcome.value,undefined);assert.equal(f.store.resumeStatus(self.id).enabled,true);
      p.handleInput('\x1b');f.store.setResumeEnabled(self.id,false);
      p.handleInput('d');p.handleInput('y');assert.equal(outcome.value,true);
    },'owner');
    assert(f.store.sessionSide(self.sessionId)?.removedAt);
    assert.equal(f.store.sidePage().total,1);
  }finally{f.close();}
});

test('non-interactive side listing stays paginated and omits other sides task statistics',async()=>{
 const f=fixture();try{
  let output='';await showSides({mode:'rpc',ui:{notify:(value:string)=>{output=value;}}} as any,f.store,self);
  const data=JSON.parse(output);assert.equal(data.total,2);assert.equal(data.nextAfter,null);
  assert.equal(data.sides[0].openTasks,undefined);assert.equal(data.sides[0].autoResume,undefined);
 }finally{f.close();}
});
