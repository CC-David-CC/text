/** Text owns its recovery schema; Runtime owns ordered local draft mechanics. */
import {createRecoveryStore, createRecoveryJournal} from '@webos/runtime/local-recovery';
function capture(value) {
  if (!value || typeof value.text !== 'string' || value.text.length > 128 * 1024 * 1024 ||
      !(value.path === null || typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 2048) ||
      !(value.revision === null || /^[0-9a-f]{64}$/.test(value.revision)) ||
      typeof value.format?.bom !== 'boolean' || typeof value.format.mixed !== 'boolean' || !['\n', '\r', '\r\n'].includes(value.format.lineEnding)) throw Error('Invalid Text recovery snapshot.');
  return {text: value.text, path: value.path, revision: value.revision,
    format: {bom: value.format.bom, mixed: value.format.mixed, lineEnding: value.format.lineEnding}};
}

export function createDraftStore(options) { return createRecoveryStore({...options, database:'webos-text-recovery-v1', capture}); }
export function createDraftJournal(options) { return createRecoveryJournal({...options, capture}); }
