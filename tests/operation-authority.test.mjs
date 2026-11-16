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

async function fixture(policy) {
  const authority = {}, writes = [];
  let text = '', snapshot = {toString: () => ''}, saved = snapshot;
  const setText = value => { text = value; snapshot = {toString: () => value}; };
  const editor = {setReadOnly() {}, setPath() {}, destroy() {}, undo() {}, redo() {},
    replaceDocument: setText, getText: () => text, snapshot: () => snapshot,
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
    resource: {path: 'first.txt', sha256: 'a'.repeat(64)},
    authorize: policy,
    files: {check() {}, async read() {return {data: new TextEncoder().encode('original'), sha256: 'a'.repeat(64)};},
      async write(...args) {writes.push(args); return {sha256: 'b'.repeat(64)};}}});
  await view.ready;
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
