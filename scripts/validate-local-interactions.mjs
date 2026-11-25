// Offline interaction regressions: real React state, not a browser/layout substitute.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const models = Array.from({length:500}, (_,i)=>({id:`model-${i}`,name:`Model ${i}`}));
const inventory = {userModelsCount:500,userProviders:[{name:'demo',display:'Demo Gateway',models}]};
const metrics = {totalTokens:500,calls:500,sessions:1};
const rows = models.map((m,i)=>({model:m.id,display:m.name,provider:'demo',totalTokens:1,calls:1,localRank:i+1}));
const bucket = {metrics,byModel:rows,byProvider:[]};
const usage = {totals:metrics,ranges:{today:bucket,d7:bucket,d30:bucket,all:bucket},byDay:[],accounts:[]};
const snapshot = {version:1,arena:{rows:[]},usage:{weekly:[],month:[],marketShare:[]}};
const store = new Map();
globalThis.localStorage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,String(v))};
globalThis.document={getElementById:()=>null,head:{appendChild(){}},createElement:()=>({}),addEventListener(){},removeEventListener(){},visibilityState:'visible'};
globalThis.window={__ModuleLoader__:{load(r){globalThis.registration=r;}}};
globalThis.fetch=()=>new Promise(()=>{}); // leave network pending; cached UI remains usable
new Function('window',code)(window);
const plugin=registration.factory(s=>{assert.equal(s,'react');return React;});
let Panel;
await plugin.apply({slots:{inject(n,f){f();},register(o,c){if(o.name==='main')Panel=c;}},get(){},effect(f){return f();}});
function mount(data=usage){
 store.set('dsh-model-rank:tab','local');
 store.set('dsh-model-rank:snapshot',JSON.stringify({snapshot,inventory,meta:{},at:Date.now()}));
 store.set('dsh-model-rank:usage',JSON.stringify({usage:data,at:Date.now()}));
 let tree; act(()=>{tree=TestRenderer.create(React.createElement(Panel));});return tree;
}
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
test('responsive query container excludes the fixed drawer',()=>{
 assert.ok(!/\.mrr-root\s*\{[^}]*container-type/.test(code), 'root containment would capture its fixed drawer');
 assert.match(code,/\.mrr-inner\s*\{[^}]*container-type/);
});
const cls=(tree,name)=>tree.root.findAll(n=>typeof n.type==='string'&&String(n.props.className||'').split(' ').includes(name));
const button=(tree,label)=>tree.root.findAllByType('button').find(n=>n.children.join('').includes(label));
test('500 model inventory mounts only a compact preview and can expand / collapse',()=>{
 const t=mount();try{
 assert.ok(cls(t,'mrr-modelchip').length<=8,'inventory must not mount all 500 chips');
 const more=button(t,'展开模型');assert.ok(more,'expansion control is discoverable');
 act(()=>more.props.onClick());assert.equal(more.props['aria-expanded'],true);
 assert.ok(cls(t,'mrr-modelchip').length<=50,'expanded inventory is paged');
 act(()=>button(t,'收起模型').props.onClick());assert.ok(cls(t,'mrr-modelchip').length<=8);
 }finally{act(()=>t.unmount());}
});
test('long model usage ranking is bounded and pagination is reversible',()=>{
 const t=mount();try{
 const table=cls(t,'mrr-usage-modeltable')[0];assert.ok(table.findAllByType('tr').length<=11,'show 10 model rows initially');
 act(()=>button(t,'下一页').props.onClick());assert.ok(JSON.stringify(t.toJSON()).includes('Model 10'));
 act(()=>button(t,'上一页').props.onClick());assert.ok(JSON.stringify(t.toJSON()).includes('Model 0'));
 }finally{act(()=>t.unmount());}
});
test('zero search results keep the same search field mounted and recover on clear',()=>{
 const t=mount();try{
 const input=t.root.findByType('input');act(()=>input.props.onChange({target:{value:'does-not-exist'}}));
 assert.equal(t.root.findByType('input'),input,'search must remain mounted');
 act(()=>t.root.findByType('input').props.onChange({target:{value:''}}));assert.ok(cls(t,'mrr-modelchip').length>0);
 }finally{act(()=>t.unmount());}
});
test('search finds a model beyond the preview without expanding manually',()=>{
 const t=mount();try{
 act(()=>t.root.findByType('input').props.onChange({target:{value:'Model 499'}}));
 assert.equal(cls(t,'mrr-modelchip').length,1);assert.ok(JSON.stringify(t.toJSON()).includes('Model 499'));
 }finally{act(()=>t.unmount());}
});
test('inventory remains available with no session usage',()=>{
 const t=mount({...usage,totals:{},ranges:{},byDay:[]});try{assert.ok(cls(t,'mrr-modelchip').length>0,'inventory is independent of usage');}finally{act(()=>t.unmount());}
});
test('each tab retains its own search without carrying a hidden filter into another view',()=>{
 const t=mount();try{
 act(()=>t.root.findByType('input').props.onChange({target:{value:'Model 499'}}));
 act(()=>t.root.findAllByType('button').find(n=>n.props['data-tab']==='arena').props.onClick());
 assert.equal(t.root.findByType('input').props.value,'');
 act(()=>t.root.findAllByType('button').find(n=>n.props['data-tab']==='local').props.onClick());
 assert.equal(t.root.findByType('input').props.value,'Model 499');
 }finally{act(()=>t.unmount());}
});
let failed=0;for(const [name,fn] of tests){try{fn();console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.message);}}
assert.equal(failed,0,`${failed} local interaction regressions`);
