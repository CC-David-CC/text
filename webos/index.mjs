import {createEditor} from '@webos/codemirror';
import './style.css';
import {decodeText, encodeText} from './text-format.mjs';

/** One live CodeMirror document per view, saved through the shared Storage service. */
export function mount({instanceId, sessionId, resource = null, files, authority, authorize, signal}) {
  if (!instanceId || !sessionId || !files || typeof authorize !== 'function') throw TypeError('Explicit Text instance, session, Storage and authorization required.');
  const documentId = crypto.randomUUID(), element = document.createElement('div'); element.className = 'webos-text';
  const toolbar = document.createElement('nav'), title = document.createElement('span'), status = document.createElement('div'), surface = document.createElement('div');
  toolbar.setAttribute('aria-label', 'Text commands'); status.className = 'webos-text-status'; status.setAttribute('role', 'status'); surface.className = 'webos-text-editor';
  const events = new AbortController(); let disposed = false, loaded = false, busy = false, path = resource?.path ?? null, revision = null, dialog = null, format = {bom:false, lineEnding:'\n', mixed:false};
  const editor = createEditor({parent: surface, path: path || 'Untitled.txt', onChange: () => { if (!disposed) render(); }}); editor.setReadOnly(true);
  function check() { if (disposed || signal?.aborted) throw new DOMException('Text view closed.', 'AbortError'); files.check(); }
  const inspect = () => Object.freeze({instanceId, sessionId, documentId, path, revision, dirty: !editor.isClean(), loaded, busy, disposed});
  function render() { title.textContent = (path || 'Untitled.txt') + (editor.isClean() ? '' : ' *'); save.disabled = saveAs.disabled = busy || !loaded; }
  function ask({kind, initial = ''}) {
    check(); if (dialog) throw Error('Finish the current Text dialog first.');
    const node = document.createElement('dialog'), form = document.createElement('form'), heading = document.createElement('h2'); node.className = 'webos-text-dialog';
    heading.textContent = kind === 'path' ? 'Save As' : 'Unsaved changes'; form.append(heading);
    let input;
    if (kind === 'path') { const label = document.createElement('label'); label.textContent = 'Account file path'; input = document.createElement('input'); input.value = initial; input.required = true; label.append(input); form.append(label); }
    else { const message = document.createElement('p'); message.textContent = 'Save changes before closing this document?'; form.append(message); }
    node.append(form); element.append(node);
    return new Promise(resolve => {
      const finish = value => { if (dialog !== cancel) return; dialog = null; signal?.removeEventListener('abort', cancel); node.close(); node.remove(); resolve(value); };
      const cancel = () => finish(null); dialog = cancel;
      for (const [value, text] of kind === 'path' ? [['save', 'Save'], ['cancel', 'Cancel']] : [['save', 'Save'], ['discard', 'Discard'], ['cancel', 'Cancel']]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
        button.addEventListener('click', () => { if (value === 'save' && input && !input.reportValidity()) return; finish(value === 'cancel' ? null : input ? input.value : value); }); form.append(button);
      }
      form.addEventListener('submit', event => { event.preventDefault(); if (input?.reportValidity()) finish(input.value); });
      node.addEventListener('cancel', event => {event.preventDefault(); cancel();}); signal?.addEventListener('abort', cancel, {once:true}); node.showModal(); input?.focus();
    });
  }
  const operations = {
    inspect: () => ({...inspect(), text: editor.getText()}),
    replace({from, to, text}) { if (busy && !loaded) throw Error('Document is loading.'); if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > editor.getText().length || typeof text !== 'string') throw TypeError('Valid text range required.'); editor.replace(from, to, text); return {status:'edited'}; },
    undo() {editor.undo(); return {status:'undone'};},
    redo() {editor.redo(); return {status:'redone'};},
    async save({destination = null} = {}) {
      if (busy) throw Error('A save is already running.');
      if (destination !== null && (typeof destination !== 'string' || !destination || destination.startsWith('/') || destination.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[\0\\]/.test(part)))) throw TypeError('Relative account file path required.');
      const target = destination || path; if (!target) throw Error('Choose Save As for a new document.');
      const previous = destination && destination !== path ? null : revision;
      const snapshot = editor.snapshot(), text = snapshot.toString(); busy = true; render(); status.textContent = 'Saving to your account…';
      try {
        const result = await files.write(target, encodeText(text, format), previous, {signal}); check();
        if (!/^[0-9a-f]{64}$/.test(result.sha256 || '')) throw Error('Invalid server save confirmation.');
        path = target; revision = result.sha256; editor.setPath(path); editor.markSaved(snapshot);
        status.textContent = editor.isClean() ? 'Saved to your account.' : 'Saved revision; newer edits remain unsaved.';
        return {status:'saved', path, revision, dirty: !editor.isClean()};
      } catch (error) { if (!disposed) status.textContent = error.outcome === 'unknown' ? 'Save outcome unknown. Check the account file before retrying.' : 'Not saved: ' + error.message; throw error; }
      finally { busy = false; if (!disposed) render(); }
    }
  };
  async function execute(request, candidate) {
    check(); if (!loaded) throw Error('Document is not ready.');
    if (request?.instanceId !== instanceId || request.sessionId !== sessionId || request.documentId !== documentId || !Object.hasOwn(operations, request.operation)) throw Error('Explicit current Text instance, session and document required.');
    const args = structuredClone(request.args || {}), operation = request.operation;
    const capturedPath = path, capturedRevision = revision, capturedDocument = editor.snapshot();
    if (await authorize(candidate, {instanceId, sessionId, documentId, operation, path: capturedPath, destination: args.destination ?? null}) !== true) throw Error('Text operation denied.');
    check();
    // A permission decision for an earlier binding or text range cannot be
    // applied to a file rebound by Save As or a newer live editor document.
    if (path !== capturedPath || revision !== capturedRevision || editor.snapshot() !== capturedDocument) throw Error('Text document changed while authorization was pending.');
    return operations[operation](args);
  }
  const run = (operation, args = {}) => execute({instanceId, sessionId, documentId, operation, args}, authority);
  function notify(error) { if (!disposed && error.name !== 'AbortError') status.textContent = error.message; }
  async function saveDocument(asCopy = false) { const destination = asCopy || !path ? await ask({kind:'path',initial:path || 'Untitled.txt'}) : undefined; if (destination === null) return false; await run('save', destination === undefined ? {} : {destination}); return editor.isClean(); }
  function button(text, callback) { const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.addEventListener('click', () => Promise.resolve().then(callback).catch(notify), {signal: events.signal}); toolbar.append(node); return node; }
  const save = button('Save', () => saveDocument()), saveAs = button('Save As', () => saveDocument(true)); button('Undo', () => run('undo')); button('Redo', () => run('redo')); toolbar.append(title); element.append(toolbar, surface, status);
  element.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveDocument(event.shiftKey).catch(notify); } }, {signal: events.signal});
  const ready = (async () => { try { if (path) { const result = await files.read(path); check(); if (resource.sha256 && result.sha256 !== resource.sha256) throw Error('Account file changed before opening. Refresh Files.'); const bytes = result.data instanceof Blob ? new Uint8Array(await result.data.arrayBuffer()) : result.data; check(); format = decodeText(bytes); editor.replaceDocument(format.text, path); revision = result.sha256; } check(); loaded = true; editor.setReadOnly(false); status.textContent = 'Account document ready.'; render(); } catch(error) { notify(error); throw error; } })();
  ready.catch(() => {});
  function dispose() { if (disposed) return; disposed = true; dialog?.(); events.abort(); signal?.removeEventListener('abort', dispose); editor.destroy(); element.remove(); }
  signal?.addEventListener('abort', dispose, {once:true}); if (signal?.aborted) dispose(); render();
  return Object.freeze({element, ready, inspect, execute, dispose, async requestClose() {check(); if (busy) {status.textContent = 'Wait for the current save before closing.'; return false;} if (!loaded || editor.isClean()) return true; const snapshot = editor.snapshot(), choice = await ask({kind:'close'}); if (choice === 'discard') { if (editor.snapshot() !== snapshot) { status.textContent = 'Document changed during confirmation. Review the newer edits.'; return false; } return true; } if (choice === 'save') {try {return await saveDocument();}catch(error) {notify(error);}} return false; }});
}
