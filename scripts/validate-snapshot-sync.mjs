// Real React hooks with a fake clock and controlled RPC promises. No browser/server.
// Run: node scripts/validate-snapshot-sync.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const React=require('react');
const {create,act}=require('react-test-renderer');
const source=readFileSync(new URL('../lib/client.js',import.meta.url),'utf8');
const start=source.indexOf('  function Panel(props) {');
const end=source.indexOf('    const changeTab =',start);
const hooks=source.slice(start,end);
const payload=(id,meta={})=>({snapshot:{version:1,id},meta,inventory:{}});
async function harness(cached=payload('cache')){
  let now=1000, nextTimer=0, state, tree;
  const timers=new Map(),listeners=new Map(),gets=[],posts=[],writes=[];
  const document={visibilityState:'visible',addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
  const deferred=(list)=>new Promise((resolve,reject)=>list.push({resolve,reject,at:now}));
  const context={React,document,localStorage:{getItem:()=>null},TAB_KEY:'tab',
    Date:{now:()=>now},setTimeout:(fn,ms)=>{timers.set(++nextTimer,{fn,at:now+ms});return nextTimer;},clearTimeout:id=>timers.delete(id),
    readCache:()=>cached,writeCache:p=>writes.push(p),useUsageData:()=>({reload(){}}),
    rpcGet:()=>deferred(gets),rpcPost:()=>deferred(posts),
    refreshFeedback:result=>result?.reason==='busy'?{type:'busy',message:'busy'}:result?.ok===false?{type:'error',message:'failed'}:{type:'ok',message:null},
    capture:value=>{state=value;}};
  vm.createContext(context);
  vm.runInContext(`const {useState,useEffect,useMemo,useRef,useCallback}=React; this.Probe=${hooks}capture({payload,meta,loading,refreshing,error,onRefresh});return null;}`,context);
  await act(async()=>{tree=create(React.createElement(context.Probe));});
  return {gets,posts,writes,timers,listeners,get state(){return state;},
    async resolve(request,value){await act(async()=>request.resolve(value));},
    async reject(request,error){await act(async()=>request.reject(error));},
    async refresh(){await act(async()=>{state.onRefresh();});},
    async advance(ms){const until=now+ms;let count=0;while(true){const next=[...timers].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;assert.ok(++count<1000,'timer loop');now=next[1].at;timers.delete(next[0]);await act(async()=>next[1].fn());}now=until;},
    async visible(value){document.visibilityState=value;await act(async()=>listeners.get('visibilitychange')?.());},
    async unmount(){await act(async()=>tree.unmount());}};
}
let failures=0;
async function test(name,run){try{await run();console.log('PASS',name);}catch(error){failures++;console.error('FAIL',name,error.message);}}
await test('bundled startup follows the host automatic refresh without another POST',async()=>{
  const app=await harness(payload('bundle',{bundled:true}));
  try{
    assert.equal(app.gets.length,1);
    await app.resolve(app.gets[0],payload('bundle',{bundled:true}));
    await app.advance(15000);assert.ok(app.gets.length>=2,'must poll while waiting for 15s host startup refresh');
    await app.resolve(app.gets.at(-1),payload('live',{refreshing:false}));
    assert.equal(app.state.payload.snapshot.id,'live');assert.equal(app.posts.length,0);
  }finally{await app.unmount();}
});
await test('busy response follows refresh completion with GET only',async()=>{
  const app=await harness();
  try{
    await app.resolve(app.gets[0],payload('initial'));
    await app.refresh();await app.resolve(app.posts[0],{started:false,reason:'busy',snapshot:payload('initial',{refreshing:true})});
    await app.advance(5000);assert.equal(app.gets.length,2);
    await app.resolve(app.gets[1],payload('done',{refreshing:false}));
    assert.equal(app.state.payload.snapshot.id,'done');assert.equal(app.state.error,null);assert.equal(app.posts.length,1);
    await app.advance(59999);assert.equal(app.gets.length,2);
    await app.advance(1);assert.equal(app.gets.length,3);
  }finally{await app.unmount();}
});
await test('busy feedback clears even after multiple still-refreshing responses',async()=>{
  const app=await harness();
  try{
    await app.resolve(app.gets[0],payload('initial'));
    await app.refresh();await app.resolve(app.posts[0],{started:false,reason:'busy',snapshot:payload('initial',{refreshing:true})});
    await app.advance(5000);await app.resolve(app.gets[1],payload('working',{refreshing:true}));
    assert.equal(app.state.error,'busy');
    await app.advance(5000);await app.resolve(app.gets[2],payload('done',{refreshing:false}));
    assert.equal(app.state.error,null);assert.equal(app.state.payload.snapshot.id,'done');
  }finally{await app.unmount();}
});
await test('initial old GET cannot overwrite successful manual refresh or its cache',async()=>{
  const app=await harness(null);
  try{
    await app.refresh();await app.resolve(app.posts[0],{ok:true,snapshot:payload('manual-new')});
    await app.resolve(app.gets[0],payload('initial-old'));
    assert.equal(app.state.payload.snapshot.id,'manual-new');
    assert.equal(app.writes.at(-1).snapshot.id,'manual-new');assert.equal(app.state.loading,false);
  }finally{await app.unmount();}
});
await test('manual refresh is deduplicated and polls never overlap a pending request',async()=>{
  const app=await harness();
  try{
    await app.refresh();await app.refresh();assert.equal(app.posts.length,1);
    await app.advance(180000);assert.equal(app.gets.length,1,'pending initial GET must not multiply');
    await app.resolve(app.posts[0],{ok:true,snapshot:payload('manual')});
    await app.resolve(app.gets[0],payload('old'));
    await app.advance(60000);assert.equal(app.gets.length,2);
    await app.advance(180000);assert.equal(app.gets.length,2,'long GET must stay single flight');
  }finally{await app.unmount();}
});
await test('hidden documents skip polling and catch up once when visible',async()=>{
  const app=await harness();
  try{
    await app.resolve(app.gets[0],payload('initial'));
    await app.visible('hidden');await app.advance(180000);assert.equal(app.gets.length,1);
    await app.visible('visible');assert.equal(app.gets.length,2);
    await app.visible('visible');assert.equal(app.gets.length,2);
  }finally{await app.unmount();}
});
await test('fast tracking is capped at two minutes then returns to 60s cadence',async()=>{
  const app=await harness(payload('bundle',{bundled:true}));
  try{
    await app.resolve(app.gets[0],payload('bundle',{bundled:true}));
    for(let i=0;i<24;i++){await app.advance(5000);assert.equal(app.gets.length,i+2);await app.resolve(app.gets.at(-1),payload('bundle',{bundled:true}));}
    const count=app.gets.length;
    await app.advance(59999);assert.equal(app.gets.length,count);
    await app.advance(1);assert.equal(app.gets.length,count+1);
  }finally{await app.unmount();}
});
await test('unmount invalidates pending GET and POST without state/cache writes or timers',async()=>{
  const app=await harness();
  await app.refresh();await app.unmount();
  const writes=app.writes.length;
  await app.resolve(app.posts[0],{ok:true,snapshot:payload('late-post')});
  await app.resolve(app.gets[0],payload('late-get'));
  assert.equal(app.writes.length,writes);assert.equal(app.timers.size,0);assert.equal(app.listeners.size,0);
});
await test('old GET failure after manual success stays silent',async()=>{
  const app=await harness(null);
  try{
    await app.refresh();await app.resolve(app.posts[0],{ok:true,snapshot:payload('new')});
    await app.reject(app.gets[0],new Error('stale failure'));
    assert.equal(app.state.error,null);assert.equal(app.state.payload.snapshot.id,'new');
  }finally{await app.unmount();}
});
await test('manual POST rejection ends uncached loading despite the superseded initial GET',async()=>{
  const app=await harness(null);
  try{
    assert.equal(app.state.loading,true);
    await app.refresh();await app.reject(app.posts[0],new Error('offline'));
    await app.resolve(app.gets[0],payload('superseded'));
    assert.equal(app.state.loading,false,'error must not remain hidden behind the loading view');
    assert.match(app.state.error,/offline/);assert.equal(app.state.payload,null);
    assert.equal(app.state.refreshing,false);assert.equal(app.writes.length,0);
  }finally{await app.unmount();}
});
await test('manual POST without snapshot still ends uncached loading and exposes feedback',async()=>{
  for(const result of [{ok:false},{started:false,reason:'busy'},{ok:true}]){
    const app=await harness(null);
    try{
      await app.refresh();await app.resolve(app.posts[0],result);
      await app.resolve(app.gets[0],payload('superseded'));
      assert.equal(app.state.loading,false,'settled POST cannot leave the initial loading state alive');
      assert.equal(app.state.payload,null);assert.equal(app.state.refreshing,false);
      if(result.ok===false)assert.equal(app.state.error,'failed');
      if(result.reason==='busy')assert.equal(app.state.error,'busy');
    }finally{await app.unmount();}
  }
});
if(failures)process.exitCode=1;else console.log('Snapshot synchronization validation passed.');
