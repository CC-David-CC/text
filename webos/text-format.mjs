/** Preserve UTF-8 BOM and uniform line endings; mixed endings require explicit handling. */
export function decodeText(bytes) {
  if (!(bytes instanceof Uint8Array)) throw TypeError('Text file bytes required.');
  const text = new TextDecoder('utf-8', {fatal:true}).decode(bytes), endings = text.match(/\r\n|\r|\n/g) || [];
  return {text: text.replace(/\r\n|\r/g, '\n'), bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    lineEnding: endings[0] || '\n', mixed: new Set(endings).size > 1};
}
export function encodeText(text, format) {
  if (format.mixed) throw Error('Mixed line endings require explicit normalization before saving.');
  return new TextEncoder().encode((format.bom ? '\ufeff' : '') + text.replace(/\n/g, format.lineEnding));
}
