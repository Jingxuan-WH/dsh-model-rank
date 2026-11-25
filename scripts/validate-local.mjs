// npm install --no-save --package-lock=false react@18.3.1 react-test-renderer@18.3.1
// node scripts/validate-local.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const models = Array.from({ length: 500 }, (_, i) => ({ id: `id-${i}`, name: `Model ${i}` }));
const metrics = { totalTokens: 500, calls: 500 };
const byModel = models.map((m) => ({ model: m.id, display: m.name, provider: 'demo', totalTokens: 1 }));
const bucket = { metrics, byModel, byProvider: [] };
const usage = { totals: metrics, ranges: { d7: bucket }, byDay: [], accounts: [] };
const inventory = { userModelsCount: 500, userProviders: [
  { name: 'demo', display: '演示渠道', models },
  { name: 'empty', display: '空渠道', models: [] },
] };
const ranked = { model: 'Public name', rank: 1, local: { id: 'id-499', provider: 'demo', providerDisplay: '演示渠道' } };
const snapshot = { version: 1, arena: { rows: [ranked] }, usage: {} };
const cache = new Map();
globalThis.localStorage = { getItem: (k) => cache.get(k) ?? null, setItem: (k, v) => cache.set(k, v) };
globalThis.document = { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} },
  addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
globalThis.fetch = async () => { throw new Error('offline fixture'); };
let Panel;
let registration;
globalThis.window = { __ModuleLoader__: { load(plugin) { registration = plugin; } } };
new Function('window', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(window);
await registration.factory(() => React).apply({
  slots: { inject(name, register) { register(); }, register({ name }, component) { if (name === 'main') Panel = component; } },
  effect: (start) => start(),
});

function mount(data) {
  cache.set('dsh-model-rank:tab', 'local');
  cache.set('dsh-model-rank:snapshot', JSON.stringify({ snapshot, inventory, meta: {}, at: Date.now() }));
  cache.set('dsh-model-rank:usage', JSON.stringify({ usage: data, at: Date.now() }));
  let tree;
  act(() => { tree = TestRenderer.create(React.createElement(Panel)); });
  return tree;
}
function buttons(root, text) {
  return root.findAllByType('button').filter((node) => node.children.join('').includes(text));
}
function click(node) { act(() => node.props.onClick()); }
function chips(root) { return root.findAllByProps({ className: 'mrr-modelchip' }); }

const tree = mount(usage);
try {
  const root = tree.root;
  const card = () => root.findAllByType('article')[0];
  const table = () => root.findByProps({ className: 'mrr-table mrr-usage-modeltable' });
  const input = root.findByType('input');
  const search = (value) => act(() => input.props.onChange({ target: { value } }));
  assert.equal(chips(card()).length, 3);
  assert.equal(table().findAllByType('tbody')[0].findAllByType('tr').length, 10);
  assert.match(JSON.stringify(tree.toJSON()), /0 个模型/);
  click(buttons(card(), '展开模型')[0]);
  assert.equal(chips(card()).length, 12);
  click(buttons(card(), '下一页')[0]);
  assert.equal(chips(card())[0].children[0], 'Model 12');
  search('unique missing result');
  assert.equal(root.findByType('input'), input);
  assert.equal(chips(root).length, 0);
  search('id-499');
  assert.equal(chips(root).length, 1);
  assert.match(JSON.stringify(tree.toJSON()), /Model 499/);
  assert.equal(buttons(root, '已接入模型的榜单位置').length, 1);
  search('演示渠道');
  assert.equal(table().findAllByType('tbody')[0].findAllByType('tr').length, 10);
  search('');
  assert.equal(chips(card())[0].children[0], 'Model 12');
  click(buttons(card(), '收起模型')[0]);
  assert.equal(chips(card()).length, 3);
  const pager = root.findByProps({ 'aria-label': '模型用量排行翻页' });
  click(buttons(pager, '下一页')[0]);
  assert.match(table().findByType('tbody').findAllByType('tr')[0].findByProps({className:'mrr-usage-modelname'}).findByType('b').children.join(''), /Model 10/);
} finally { act(() => tree.unmount()); }

const empty = mount({ totals: {}, ranges: {} });
try { assert.equal(chips(empty.root).length, 3); }
finally { act(() => empty.unmount()); }
console.log('Local inventory, exact matches, disclosure restoration, pagination and empty usage passed.');
