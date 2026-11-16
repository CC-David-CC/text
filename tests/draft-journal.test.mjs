import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDraftJournal} from '../webos/drafts.mjs';
const record = text => ({text, path:null, revision:null, format:{bom:false, mixed:false, lineEnding:'\n'}});
function store() {
  const rows = new Map(), writes = [];
  return {rows, writes, async get(id) { return structuredClone(rows.get(id)); },
    async put(id, value) { const generation = crypto.randomUUID(); rows.set(id, {...structuredClone(value), id, generation}); writes.push([id, value.text]); return generation; },
    async remove(id, generation) { if (generation && rows.get(id)?.generation !== generation) return false; return rows.delete(id); }};
}

test('immutable queued snapshots and a final clear cannot resurrect discarded text', async () => {
  const s=store(), journal=createDraftJournal({store:s});
  const value=record('first'), a=journal.write(value); value.text='mutated';
  const b=journal.write(record('second')), c=journal.clear();
  await Promise.all([a,b,c]); assert.deepEqual(s.writes.map(x=>x[1]),['first','second']); assert.equal(s.rows.size,0);
});
test('edits after a saved snapshot clears retain their newer recovery draft', async () => {
  const s=store(), journal=createDraftJournal({store:s});
  await journal.write(record('saved snapshot')); const clear=journal.clear(), next=journal.write(record('newer unsaved edit'));
  await Promise.all([clear,next]); assert.equal([...s.rows.values()][0].text,'newer unsaved edit');
});
test('a rejected checkpoint does not prevent explicit discard cleanup', async () => {
  const s=store(); s.put=async()=>{throw Error('Storage quota reached');};
  const journal=createDraftJournal({store:s}); await assert.rejects(journal.write(record('draft')),/quota/);
  await journal.clear(); assert.equal(s.rows.size,0);
});
test('recovery forks live writer identity and preserves a concurrently updated source', async () => {
  const s=store(), sourceId=crypto.randomUUID(); await s.put(sourceId,record('old draft'));
  let identity; const journal=createDraftJournal({store:s,sourceId,onIdentity:id=>{identity=id;}});
  assert.equal((await journal.load()).text,'old draft'); await s.put(sourceId,record('other live tab'));
  await journal.write(record('recovered copy')); assert.notEqual(identity,sourceId);
  assert.equal(s.rows.get(sourceId).text,'other live tab'); assert.equal(s.rows.get(identity).text,'recovered copy');
});
test('closed or invalidated views cannot enqueue new writes or read recovery bodies', async () => {
  const s=store();let valid=true;const journal=createDraftJournal({store:s,valid:()=>valid});
  valid=false; await assert.rejects(journal.load(),/closed/); await assert.rejects(journal.write(record('denied')),/closed/);
  // An already approved teardown may remove this captured account's draft
  // after server logout, without reading data or using another account.
  await journal.clear(); journal.close(); await assert.rejects(journal.write(record('late')),/closed/);
});
