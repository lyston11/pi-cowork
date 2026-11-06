import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('opening a legacy directory with many side rows counts only recorded active bindings as current',()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-cowork-side-migration-'));
 const initial=new HandoffStore(root);
 const current={...self,id:'current',sessionId:'current-session'};
 const released={...old,id:'released',sessionId:'released-session'};
 initial.register(current);initial.register(released);initial.release(released);
 const legacy=new DatabaseSync(initial.dbPath);
 try {
  for(let i=0;i<1200;i++) legacy.prepare('INSERT INTO handoff_sides(id,name,session_id,pid,worktree,branch) VALUES(?,?,?,?,?,?)').run(`legacy-${i}`,`旧会话 ${i}`,`legacy-session-${i}`,2147483647,`/old/${i}`,'main');
 }finally{legacy.close();initial.close();}
 const upgraded=new HandoffStore(root);
 try{
  assert.equal(upgraded.sidePage().total,1);
  assert.equal(upgraded.sidePage({scope:'history'}).total,1201);
  assert.equal(upgraded.sidePage({scope:'all',limit:100}).total,1202);
  assert.equal(upgraded.sessionSide('legacy-session-0'),undefined);
  assert.equal(upgraded.historicalSessionSide('legacy-session-0')?.id,'legacy-0');
  upgraded.register({id:'legacy-0',name:'恢复会话',sessionId:'legacy-session-0',pid:process.pid,worktree:'/restored',branch:'main'});
  assert.equal(upgraded.sidePage().total,2);
  assert.equal(upgraded.sidePage({scope:'history'}).total,1200);
 }finally{upgraded.close();rmSync(root,{recursive:true,force:true});}
});

test('side manager counts all pages, searches names/ids and fits small terminals',async()=>{
  const f=fixture();try{
    for(let i=0;i<220;i++) f.store.register({...old,id:`s${String(i).padStart(3,'0')}`,sessionId:`ss${i}`,name:`工具 ${i}`,worktree:`/workspace/${i}`});
    await panel(f.store,(p,terminal)=>{
      const render=()=>p.render(130).join('\n');
      assert.match(render(),/当前绑定 222 侧 · 历史登记 0 侧/);assert.match(render(),/进程存活/);
      p.handleInput('\x1b[F');assert.match(render(),/工具 219/);assert.match(render(),/已载 222\/222/);
      p.handleInput('/');p.handleInput('工具 75');p.handleInput('\r');
      assert.match(render(),/匹配 1 侧/);assert.match(render(),/工具 75/);
      p.handleInput('\r');assert.match(render(),/侧详情/);assert.match(render(),/s075/);assert.match(render(),/已退出/);
      p.handleInput('\x1b[F');assert.match(render(),/未关闭交接: 0/);assert.match(render(),/自动续跑设置: 开启/);
      p.handleInput('\x1b');assert.match(render(),/历史登记 0 侧/);
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

test('current view excludes released sessions and history toggle exposes them without inflating current count',async()=>{
  const f=fixture();try{
    f.store.release(old);
    assert.equal(f.store.sessionSide(old.sessionId), undefined);
    assert.equal(f.store.sidePage().total,1);
    assert.equal(f.store.sidePage({scope:'history'}).total,1);
    await panel(f.store,p=>{
      const render=()=>p.render(140).join('\n');
      assert.match(render(),/当前绑定 1 侧 · 历史登记 1 侧/);
      assert.match(render(),/本侧/);assert.doesNotMatch(render(),/旧工具侧/);
      p.handleInput('h');
      assert.match(render(),/历史登记 1 侧 · 当前绑定 1 侧/);
      assert.match(render(),/旧工具侧/);
      p.handleInput('\r');assert.match(render(),/侧详情/);
      assert.equal(f.store.sidePage().total,1);
      p.handleInput('\x1b');p.handleInput('h');assert.match(render(),/当前绑定 1 侧/);
    });
    f.store.register(old);
    assert.equal(f.store.sessionSide(old.sessionId)?.id, old.id);
    assert.equal(f.store.sidePage().total,2);
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
      p.handleInput('d');p.handleInput('y');assert.match(render(),/当前绑定 1 侧/);assert.match(render(),/已删除 旧工具侧/);
      assert.equal(f.store.sidePage({query:'old'}).matched,0); // filter remains old, but the project total is one
    },'old');
    assert.deepEqual(f.store.read(t.id,self.id).events,before);
    assert.equal(f.store.db.prepare('SELECT session_id FROM handoff_side_bindings WHERE side_id=?').get(old.id)?.session_id, null);
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
      p.handleInput('d');f.store.register({...old,pid:2147483647});const successor:Side={id:'successor',sessionId:'successor-session',name:'接任者',pid:process.pid,worktree:'/successor',branch:'main'};f.store.register(successor);f.store.takeover(successor,old.id,old.sessionId,'replace during stale confirmation');p.handleInput('y');
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
    assert.equal(f.store.db.prepare('SELECT session_id FROM handoff_side_bindings WHERE side_id=?').get(self.id)?.session_id, null);
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
