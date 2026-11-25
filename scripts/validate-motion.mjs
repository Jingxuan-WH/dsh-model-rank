// Run: node scripts/validate-motion.mjs
// Real React lifecycle/state tests; DOM/WAAPI boundaries use deterministic node mocks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const React = require('react');
const { create, act } = require('react-test-renderer');
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const css = source.match(/const CSS = `([\s\S]*?)`;/)[1];
let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch(error) { failures++; console.error('FAIL', name, error.message); }
}
await test('shared motion tokens and keyed tab content', () => {
  for(const token of ['fast','normal','exit','ease']) assert.ok(css.includes('--mrr-motion-' + token), token);
  assert.match(source, /h\('div', \{ key: tab, id: 'mrr-panel-'/);
  assert.match(source, /'aria-pressed': onlyLocal/);
});
await test('reduced motion fully stops DOM and pseudo-element motion', () => {
  const last = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(last, /\.mrr-root::before/);
  assert.match(last, /\.mrr-root \*::after/);
  assert.match(last, /animation:none !important/);
  assert.match(last, /transition:none !important/);
  assert.match(last, /scroll-behavior:auto !important/);
});
await test('bar widths do not transition; no row stagger or layout animation added', () => {
  assert.match(css, /\.mrr-root \.mrr-share \.mrr-sharebar i\s*\{\s*transition:none/);
  assert.doesNotMatch(css, /animation-delay|transition:\s*all/);
  assert.match(css, /\.mrr-tabpanel\s*\{[^}]*animation:mrr-tab-enter/);
  const motion = css.slice(css.indexOf('/* Unified motion'));
  assert.doesNotMatch(motion, /transition:[^;}]*\b(?:width|height|margin|padding)\b/);
});
const start = source.indexOf('  function useDrawerPresence(');
const end = source.indexOf('\n  /**', source.indexOf('  function RowDetailDrawer('));
await test('drawer presence helper exists rather than immediate unmount', () => assert.ok(start >= 0, 'missing retained exit presence'));
if (start >= 0) {
  const listeners = new Map();
  const animations = [];
  const timers = new Map();
  let timerId = 0;
  let mediaHandler;
  const media = {matches:false,addEventListener:(_,fn)=>{mediaHandler=fn;},removeEventListener:()=>{mediaHandler=null;}};
  const opener = {isConnected:true,focus(){ doc.activeElement=this; }};
  const doc = {activeElement:opener,body:{},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn) listeners.delete(name);}};
  const nodes = new Map();
  function nodeMock(element) {
    const node = {isConnected:true,style:{},focus(){doc.activeElement=this;},contains(el){return el===this || el===nodes.get('mrr-drawer-close');},querySelectorAll(){return [nodes.get('mrr-drawer-close')];},
      animate(frames,options){let resolve,reject;const finished=new Promise((a,b)=>{resolve=a;reject=b;});const animation={frames,options,finished,finish:resolve,cancel(){this.cancelled=true;reject(new Error('cancelled'));}};animations.push(animation);return animation;}};
    nodes.set(element.props.className,node);return node;
  }
  const context = { React, document:doc, window:{matchMedia:()=>media}, matchMedia:()=>media,
    getComputedStyle:node=>({opacity:'0.55',transform:node===nodes.get('mrr-drawer')?'matrix(1, 0, 0, 1, 9, 0)':'none',getPropertyValue:name=>name.endsWith('ease')?'cubic-bezier(.2,.8,.2,1)':name.endsWith('exit')?'140ms':'200ms'}),
    setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),
    buildRowDetail:detail=>detail?{title:detail.title,ariaLabel:detail.title+' 明细',subtitleBits:[],sections:[]}:null };
  vm.createContext(context);
  vm.runInContext(`const {useState,useEffect,useMemo,useRef,useCallback}=React; const h=React.createElement; ${source.slice(start,end)}; this.Drawer=RowDetailDrawer;`,context);
  let tree;
  let detail = null;
  const render = () => React.createElement(context.Drawer,{detail,onClose:close});
  function close(){detail=null;tree.update(render());}
  const mask = () => tree.root.findByProps({className:'mrr-drawer-mask'});
  async function update(next){await act(async()=>{detail=next;if(!tree)tree=create(render(),{createNodeMock:nodeMock});else tree.update(render());});}
  async function finish(){await act(async()=>{animations.forEach(a=>a.finish());});}
  async function focus(){await act(async()=>{for(const [id,fn] of timers){timers.delete(id);fn();}});}
  for(const method of ['escape','mask','button']) await test(method+' close retains inert exit, restores focus, then unmounts',async()=>{
    await update({title:'Demo'});await focus();
    assert.equal(doc.activeElement,nodes.get('mrr-drawer-close'));
    assert.ok(animations.length>0,'real WAAPI boundary must be used');
    await act(async()=>{
      if(method==='escape')listeners.get('keydown')({key:'Escape',preventDefault(){},stopPropagation(){}});
      if(method==='mask')mask().props.onClick();
      if(method==='button')tree.root.findByProps({className:'mrr-drawer-close'}).props.onClick();
    });
    assert.equal(mask().props['data-state'],'closing');
    assert.notEqual(mask().props.inert,undefined);
    assert.equal(mask().props['aria-hidden'],true);
    assert.equal(doc.activeElement,opener);
    assert.equal(listeners.has('keydown'),false,'closed drawer must not trap keys');
    await finish();assert.equal(tree.toJSON(),null);
  });
  await test('close/reopen interrupts animation and ignores stale exit completion',async()=>{
    await update({title:'First'});await focus();
    await update(null);const exits=animations.slice(-2);
    await update({title:'Reopened'});
    assert.ok(exits.every(a=>a.cancelled));
    await act(async()=>{exits.forEach(a=>a.finish());});
    assert.equal(mask().props['data-state'],'open');
    assert.equal(mask().props.inert,undefined);
    assert.equal(tree.root.findByProps({className:'mrr-drawer-title'}).children.join(''),'Reopened');
    assert.ok(animations.some(a=>a.frames[0].opacity==='0.55'),'reversal starts at current presentation');
    await finish();
  });
  await test('detail refresh does not restart motion or steal focus',async()=>{
    await focus(); // Flush the preceding reopen's intentional initial-focus timer first.
    const count=animations.length;
    const external={isConnected:true,focus(){doc.activeElement=this;}};
    doc.activeElement=external;
    await update({title:'Refreshed'});await focus();
    assert.equal(animations.length,count);
    assert.equal(doc.activeElement,external);
    assert.equal(tree.root.findByProps({className:'mrr-drawer-title'}).children.join(''),'Refreshed');
    await update(null);
    assert.equal(doc.activeElement,external,'closing must not override caller focus');
    await finish();doc.activeElement=opener;
  });
  await test('unsupported WAAPI falls back without a stranded drawer',async()=>{
    await update({title:'Fallback'});await focus();
    nodes.get('mrr-drawer-mask').animate=undefined;
    await update(null);assert.equal(tree.toJSON(),null);
    doc.activeElement=opener;
  });
  await test('reduced motion cancels an in-flight transition and skips future WAAPI',async()=>{
    await update({title:'Before preference change'});await focus();
    await update(null);
    media.matches=true;
    await act(async()=>mediaHandler?.({matches:true}));
    assert.equal(tree.toJSON(),null);
    const count=animations.length;
    await update({title:'Reduced'});await focus();
    assert.equal(animations.length,count);
    await update(null);assert.equal(tree.toJSON(),null);
    await act(async()=>tree.unmount());
    assert.equal(timers.size,0);assert.equal(listeners.size,0);
  });
}
if(failures)process.exitCode=1;else console.log('Motion validation passed.');
