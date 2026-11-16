/** Real Text command boundary with a synthetic editor; no formatting-fidelity claim. */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

class Element extends EventTarget {
  children = [];
  append(...values) { this.children.push(...values); }
  setAttribute() {}
  remove() {}
}

async function fixture(policy, {resource = {path: 'first.txt', sha256: 'a'.repeat(64)}, read, write, waitReady = true} = {}) {
  const authority = {}, writes = [];
  let text = '', snapshot = {toString: () => ''}, saved = snapshot;
  const setText = value => { text = value; snapshot = {toString: () => value}; };
  const editor = {setReadOnly() {}, setPath() {}, destroy() {}, undo() {}, redo() {},
    replaceDocument(value) {setText(value); saved = snapshot;}, getText: () => text, snapshot: () => snapshot,
    isClean: () => snapshot === saved, markSaved: value => { saved = value; },
    replace(from, to, value) { setText(text.slice(0, from) + value + text.slice(to)); }};
  const document = Object.assign(new EventTarget(), {createElement: () => new Element()});
  const context = vm.createContext({document, crypto: {randomUUID}, setTimeout, clearTimeout,
    AbortController, DOMException, structuredClone, Blob, Uint8Array, TextDecoder, TextEncoder});
  const module = new vm.SourceTextModule(await readFile(new URL('../webos/index.mjs', import.meta.url), 'utf8'), {context});
  await module.link(async name => {
    if (name === '@webos/codemirror') return new vm.SyntheticModule(['createEditor'], function () { this.setExport('createEditor', () => editor); }, {context});
    if (name === './style.css') return new vm.SyntheticModule([], () => {}, {context});
    assert(['./text-format.mjs', '../lifecycle.mjs'].includes(name));
    const url = name === './text-format.mjs' ? '../webos/text-format.mjs' : '../lifecycle.mjs';
    return new vm.SourceTextModule(await readFile(new URL(url, import.meta.url), 'utf8'), {context});
  });
  await module.evaluate();
  const view = module.namespace.mount({instanceId: 'text-1', sessionId: 'session-1', authority,
    resource,
    authorize: policy,
    files: {check() {}, async read(...args) {return read ? read(...args) : {data: new TextEncoder().encode('original'), sha256: 'a'.repeat(64)};},
      async write(...args) {writes.push(args); return write ? write(...args) : {sha256: 'b'.repeat(64)};}}});
  if (waitReady) await view.ready;
  const run = (operation, args = {}) => view.execute({instanceId: 'text-1', sessionId: 'session-1', documentId: view.inspect().documentId, operation, args}, authority);
  return {view, run, editor, writes};
}

test('a pending save cannot inherit a different file binding from Save As', async t => {
  let entered, approve;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = await fixture(async (_, request) => {
    if (request.operation === 'save' && request.destination === null) { entered(); return new Promise(resolve => { approve = resolve; }); }
    return true;
  });
  t.after(() => f.view.dispose());
  const pending = f.run('save'); await waiting;
  await f.run('save', {destination: 'second.txt'}); approve(true);
  await assert.rejects(pending, /changed while authorization/i);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0][0], 'second.txt');
});

test('a pending range edit cannot use positions from an older live document', async t => {
  let entered, approve;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = await fixture(async () => { entered(); return new Promise(resolve => { approve = resolve; }); });
  t.after(() => f.view.dispose());
  const pending = f.run('replace', {from: 0, to: 4, text: 'agent'}); await waiting;
  f.editor.replace(0, 0, 'human '); approve(true);
  await assert.rejects(pending, /changed while authorization/i);
  assert.equal(f.editor.getText(), 'human original'); assert.equal(f.writes.length, 0);
});

test('an unchanged authorized save still confirms the exact account file', async t => {
  const f = await fixture(() => true); t.after(() => f.view.dispose());
  const result = await f.run('save');
  assert.equal(result.status, 'saved'); assert.equal(result.path, 'first.txt');
  assert.equal(f.writes[0][2], 'a'.repeat(64));
});

test('file binding publishes confirmed Save As and ordinary Save revisions without document bytes', async t => {
  let count = 0;
  const f = await fixture(() => true, {write: () => ({sha256: (++count === 1 ? 'b' : 'c').repeat(64)})}); t.after(() => f.view.dispose());
  const updates = [], off = f.view.fileBinding.subscribe(value => updates.push(value)); t.after(off);
  assert(Object.isFrozen(f.view.fileBinding.snapshot()));
  await f.run('save', {destination:'second.txt'}); await f.run('save');
  assert.deepEqual(updates.map(x => [x.path,x.revision]), [['second.txt','b'.repeat(64)],['second.txt','c'.repeat(64)]]);
  assert(updates.every(x => Object.keys(x).sort().join(',') === 'documentId,loaded,path,revision'));
});

test('rejected Save As retains the previous binding and unsaved text', async t => {
  const f = await fixture(() => true, {write: () => {throw Error('Destination exists');}}); t.after(() => f.view.dispose());
  const before = f.view.fileBinding.snapshot(), updates=[]; f.view.fileBinding.subscribe(v=>updates.push(v));
  f.editor.replace(0,0,'unsaved '); await assert.rejects(f.run('save',{destination:'collision.txt'}),/exists/);
  assert.equal(f.view.fileBinding.snapshot().path,before.path); assert.equal(f.view.fileBinding.snapshot().revision,before.revision);
  assert.equal(updates.length,0); assert.equal(f.editor.getText(),'unsaved original'); assert(f.view.inspect().dirty);
});

test('a delayed save publishes its confirmed file identity while newer edits remain dirty', async t => {
  let approve, entered;const waiting=new Promise(resolve=>{entered=resolve;});
  const f = await fixture(() => true,{write:()=>{entered();return new Promise(resolve=>{approve=resolve;});}});t.after(()=>f.view.dispose());
  const pending=f.run('save',{destination:'copy.txt'});await waiting;f.editor.replace(0,0,'newer ');approve({sha256:'b'.repeat(64)});await pending;
  assert.equal(new TextDecoder().decode(f.writes[0][1]),'original');assert(f.view.inspect().dirty);
  assert.equal(f.view.fileBinding.snapshot().path,'copy.txt');assert.equal(f.view.fileBinding.snapshot().revision,'b'.repeat(64));
});

test('layout restoration reads current bytes while an explicit selected revision stays exact', async t => {
  const read=()=>({data:new TextEncoder().encode('current server text'),sha256:'c'.repeat(64)});
  const restored=await fixture(()=>true,{resource:{path:'first.txt',sha256:'a'.repeat(64),restore:true},read});t.after(()=>restored.view.dispose());
  assert.equal(restored.view.inspect().revision,'c'.repeat(64));assert.equal(restored.editor.getText(),'current server text');
  const exact=await fixture(()=>true,{read,waitReady:false});t.after(()=>exact.view.dispose());
  await assert.rejects(exact.view.ready,/changed before opening/);assert.equal(exact.view.inspect().loaded,false);
});

test('missing file retains its identity and retries in the same document when it returns', async t => {
  let available=false;const f=await fixture(()=>true,{resource:{path:'missing.txt',restore:true},waitReady:false,
    read:()=>{if(!available)throw Error('File not found');return {data:new TextEncoder().encode('restored'),sha256:'c'.repeat(64)};}});t.after(()=>f.view.dispose());
  await assert.rejects(f.view.ready,/not found/);const before=f.view.inspect();assert.equal(before.path,'missing.txt');assert.equal(before.loaded,false);assert.match(before.loadError,/not found/);
  available=true;await f.run('retry');const after=f.view.inspect();assert.equal(after.documentId,before.documentId);assert.equal(after.loaded,true);assert.equal(after.loadError,'');assert.equal(after.revision,'c'.repeat(64));
});
