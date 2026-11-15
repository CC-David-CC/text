import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeText, encodeText} from '../webos/text-format.mjs';
test('round-trip UTF-8 text preserves BOM, Unicode and uniform line endings', () => {
 for (const source of ['hello\nworld\n', '\ufeffhello\r\nworld\r\n', 'naïve\r文書\r', 'plain text']) {
  const bytes = new TextEncoder().encode(source), format = decodeText(bytes);
  assert.deepEqual(encodeText(format.text, format), bytes);
 }
});
test('refuse invalid UTF-8 and unconfirmed mixed-line-ending conversion', () => {
 assert.throws(() => decodeText(new Uint8Array([0xff,0xfe])));
 const format = decodeText(new TextEncoder().encode('one\r\ntwo\n'));
 assert.equal(format.mixed, true); assert.throws(() => encodeText(format.text, format), /Mixed line endings/);
});
