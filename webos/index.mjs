import {createEditor} from '@webos/codemirror';
import {createTextLifecycle} from '../lifecycle.mjs';
import './style.css';
import {decodeText, encodeText} from './text-format.mjs';

/** One live CodeMirror document; local recovery never claims an account save. */
export function mount({instanceId, sessionId, resource = null, files, authority, authorize, signal, recovery = null, temporary = false}) {
  if (!instanceId || !sessionId || !files || typeof authorize !== 'function') throw TypeError('Explicit Text instance, session, Storage and authorization required.');
  const documentId = crypto.randomUUID(), element = document.createElement('div'); element.className = 'webos-text';
  const toolbar = document.createElement('nav'), title = document.createElement('span'), status = document.createElement('div'), recoveryStatus = document.createElement('div'), surface = document.createElement('div');
  toolbar.setAttribute('aria-label', 'Text commands'); status.className = 'webos-text-status'; status.setAttribute('role', 'status'); recoveryStatus.className = 'webos-text-recovery'; surface.className = 'webos-text-editor';
  const events = new AbortController();
  let disposed = false, loaded = false, busy = false, loading = false, loadError = '', paused = false, path = resource?.path ?? null, revision = null, dialog = null,
    format = {bom:false, lineEnding:'\n', mixed:false}, lifecycle, timer, checkpointSequence = 0, recoveryState = recovery ? 'ready' : 'unavailable', closeIntent = null, needsCopy = false, recoveryDeferred = false;
  const editor = createEditor({parent: surface, path: path || 'Untitled.txt', onChange: () => {
    if (disposed) return; closeIntent = null; lifecycle?.changed();
    if (loaded) { render(); clearTimeout(timer); timer = setTimeout(() => { void checkpoint().catch(() => {}); }, 250); }
  }}); editor.setReadOnly(true);
  function check() { if (disposed || signal?.aborted) throw new DOMException('Text view closed.', 'AbortError'); files.check(); }
  const inspect = () => Object.freeze({instanceId, sessionId, documentId, path, revision, dirty: loaded && !editor.isClean(), loaded, busy, loading, loadError, disposed, recovery: recoveryState, needsCopy});
  function render() {
    title.textContent = (path || 'Untitled.txt') + (editor.isClean() ? '' : ' *');
    save.disabled = saveAs.disabled = busy || loading || !loaded; save.disabled ||= needsCopy;
    recover.hidden = !recoveryDeferred; recover.disabled = loading;
    retry.hidden = !loadError || loaded; retry.disabled = loading;
  }
  lifecycle = createTextLifecycle({readState: () => ({dirty: loaded && !editor.isClean(), pending: busy}),
    pause() { paused = true; editor.setReadOnly(true); }, resume() { paused = false; editor.setReadOnly(!loaded); }});
  function recoveryNotice(state, message) { if (disposed) return; recoveryState = state; recoveryStatus.textContent = message; }
  function checkpoint() {
    clearTimeout(timer); if (!loaded || !recovery || disposed) return Promise.resolve();
    const sequence = ++checkpointSequence, dirty = !editor.isClean();
    recoveryNotice('writing', 'Updating local recovery…');
    const work = dirty ? recovery.write({text: editor.getText(), path, revision, format}) : recovery.clear();
    return work.then(() => {
      if (sequence === checkpointSequence) recoveryNotice(dirty ? 'stored' : 'ready', dirty ? 'Local recovery draft updated on this browser. Not saved to your account.' : '');
    }, error => {
      if (sequence === checkpointSequence) recoveryNotice('failed', 'Local recovery unavailable: ' + error.message + ' Keep this window open and save your work.');
      throw error;
    });
  }
  function ask({kind, initial = ''}) {
    check(); if (dialog) throw Error('Finish the current Text dialog first.');
    const node = document.createElement('dialog'), form = document.createElement('form'), heading = document.createElement('h2'); node.className = 'webos-text-dialog'; node.dataset.kind = kind;
    heading.textContent = kind === 'path' ? 'Save As' : kind === 'recovery' ? 'Recover unsaved Text?' : 'Unsaved changes';
    heading.id = 'text-dialog-' + crypto.randomUUID(); node.setAttribute('aria-labelledby', heading.id); form.append(heading);
    let input;
    if (kind === 'path') { const label = document.createElement('label'); label.textContent = temporary ? 'Temporary file path' : 'Account file path'; input = document.createElement('input'); input.value = initial; input.required = true; label.append(input); form.append(label); }
    else { const message = document.createElement('p'); message.textContent = kind === 'recovery' ? 'A local recovery draft for ' + (initial || 'an untitled document') + ' is available in this browser. It is not a confirmed account save.' : 'Save changes before closing this document?'; form.append(message); }
    node.append(form); element.append(node);
    return new Promise(resolve => {
      const finish = value => { if (dialog !== cancel) return; dialog = null; signal?.removeEventListener('abort', cancel); node.close(); node.remove(); resolve(value); };
      const cancel = () => finish(null); dialog = cancel;
      const choices = kind === 'path' ? [['save', 'Save'], ['cancel', 'Cancel']] : kind === 'recovery' ? [['recover', 'Recover draft'], ['discard', 'Discard draft'], ['cancel', 'Later']] : [['save', 'Save'], ['discard', 'Discard'], ['cancel', 'Cancel']];
      for (const [value, text] of choices) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
        button.addEventListener('click', () => { if (value === 'save' && input && !input.reportValidity()) return; finish(value === 'cancel' ? null : input ? input.value : value); }); form.append(button);
      }
      form.addEventListener('submit', event => { event.preventDefault(); if (input?.reportValidity()) finish(input.value); });
      node.addEventListener('cancel', event => {event.preventDefault(); cancel();}); signal?.addEventListener('abort', cancel, {once:true}); node.showModal(); input?.focus();
    });
  }
  const operations = {
    retry: () => initialize(),
    inspect: () => ({...inspect(), text: editor.getText()}),
    replace({from, to, text}) { if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > editor.getText().length || typeof text !== 'string') throw TypeError('Valid text range required.'); editor.replace(from, to, text); return {status:'edited'}; },
    undo() {editor.undo(); return {status:'undone'};},
    redo() {editor.redo(); return {status:'redone'};},
    async save({destination = null} = {}) {
      if (busy) throw Error('A save is already running.');
      if (destination !== null && (typeof destination !== 'string' || !destination || destination.startsWith('/') || destination.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[\0\\]/.test(part)))) throw TypeError('Relative file path required.');
      const target = destination || path; if (!target) throw Error('Choose Save As for a new document.');
      if (needsCopy && target === path) throw Error('The server file changed or could not be verified. Use Save As to keep this recovered draft.');
      const previous = destination && destination !== path ? null : revision;
      const snapshot = editor.snapshot(), text = snapshot.toString(); busy = true; closeIntent = null; lifecycle.changed(); render(); status.textContent = temporary ? 'Saving to temporary Files…' : 'Saving to your account…';
      try {
        const result = await files.write(target, encodeText(text, format), previous, {signal}); check();
        if (!/^[0-9a-f]{64}$/.test(result.sha256 || '')) throw Error('Invalid save confirmation.');
        path = target; revision = result.sha256; needsCopy = false; editor.setPath(path); editor.markSaved(snapshot);
        lifecycle.changed();
        status.textContent = editor.isClean()
          ? (temporary ? 'Saved to temporary Files. Download a copy before reloading.' : 'Saved to your account.')
          : 'Saved revision. Newer edits remain unsaved.';
        await checkpoint().catch(() => {});
        return {status:'saved', path, revision, dirty: !editor.isClean()};
      } catch (error) {
        notifySave(error, target);
        throw error;
      }
      finally { busy = false; if (!disposed) { lifecycle.changed(); render(); } }
    }
  };
  async function execute(request, candidate) {
    check(); if (!loaded && request?.operation !== 'retry') throw Error('Document is not ready.');
    if (request?.instanceId !== instanceId || request.sessionId !== sessionId || request.documentId !== documentId || !Object.hasOwn(operations, request.operation)) throw Error('Explicit current Text instance, session and document required.');
    const args = structuredClone(request.args || {}), operation = request.operation;
    const capturedPath = path, capturedRevision = revision, capturedDocument = editor.snapshot();
    if (await authorize(candidate, {instanceId, sessionId, documentId, operation, path: capturedPath, destination: args.destination ?? null}) !== true) throw Error('Text operation denied.');
    check();
    if (paused && operation !== 'inspect') throw Error('Text is paused while the desktop closes this view.');
    if (path !== capturedPath || revision !== capturedRevision || editor.snapshot() !== capturedDocument) throw Error('Text document changed while authorization was pending.');
    return operations[operation](args);
  }
  const run = (operation, args = {}) => execute({instanceId, sessionId, documentId, operation, args}, authority);
  function notify(error) { if (!disposed && error.name !== 'AbortError' && !loadError) status.textContent = error.message; }
  function notifySave(error, target = path) {
    if (disposed || error.name === 'AbortError' || loadError) return;
    if (error.outcome === 'unknown') {
      status.textContent = 'Save outcome unknown. Check Files before retrying.';
    } else if (error.status === 401) {
      status.textContent = 'Not saved. Your session ended. Copy any unsaved edits, then reload WebOS and sign in again.';
    } else if (error.status === 409) {
      status.textContent = target === path
        ? 'Not saved. The saved file changed. Use Save As to keep your edits in a separate file.'
        : 'Not saved. That path already exists. Choose a different name or folder in Save As.';
    } else {
      status.textContent = 'Not saved: ' + error.message;
    }
  }
  async function saveDocument(asCopy = false) {
    let destination;
    try {
      destination = asCopy || !path ? await ask({kind:'path',initial:path || 'Untitled.txt'}) : undefined;
      if (destination === null) return false;
      await run('save', destination === undefined ? {} : {destination});
      return editor.isClean();
    } catch (error) {
      notifySave(error, destination);
      return false;
    }
  }
  function button(text, callback) { const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.addEventListener('click', () => Promise.resolve().then(callback).catch(notify), {signal: events.signal}); toolbar.append(node); return node; }
  const save = button('Save', () => saveDocument()), saveAs = button('Save As', () => saveDocument(true)); button('Undo', () => run('undo')); button('Redo', () => run('redo'));
  const recover = button('Recover draft', () => run('retry')), retry = button('Retry', () => run('retry')); recover.hidden = retry.hidden = true; toolbar.append(title); element.append(toolbar, surface, status, recoveryStatus);
  element.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveDocument(event.shiftKey).catch(notify); } }, {signal: events.signal});
  async function initialize() {
    check(); if (loaded) throw Error('The document is already open.'); if (loading) throw Error('The document is still loading.');
    loading = true; loadError = ''; render();
    try {
      let draft;
      if (recovery) { try { draft = await recovery.load(); check(); } catch (error) { check(); recoveryNotice('failed', 'Local recovery unavailable: ' + error.message); } }
      if (draft) {
        const choice = await ask({kind:'recovery', initial: draft.path}); check();
        if (!choice) { recoveryDeferred = true; status.textContent = 'Local draft retained. Choose Recover draft to review it.'; render(); return; }
        recoveryDeferred = false;
        if (choice === 'recover') {
          path = draft.path; revision = draft.revision; format = draft.format;
          if (path) { try { needsCopy = (await files.version(path)).sha256 !== revision; } catch { needsCopy = true; } check(); }
          editor.replaceDocument(draft.text, path || 'Untitled.txt'); editor.markSaved(null);
          loaded = true; editor.setReadOnly(false); lifecycle.changed();
          status.textContent = needsCopy ? 'Recovered local draft. The server file changed or is unavailable; use Save As to keep this copy.' : 'Recovered local draft. Changes are not saved to your account.';
          await checkpoint().catch(() => {}); render(); return;
        }
        await recovery.clear(); check();
      }
      if (path) {
        const result = await files.read(path); check();
        if (!resource.restore && resource.sha256 && result.sha256 !== resource.sha256) throw Error('File changed before opening. Close this view, refresh Files and open the current file.');
        const bytes = result.data instanceof Blob ? new Uint8Array(await result.data.arrayBuffer()) : result.data; check(); format = decodeText(bytes); editor.replaceDocument(format.text, path); revision = result.sha256;
      }
      check(); loaded = true; editor.setReadOnly(false);
      status.textContent = temporary
        ? 'Temporary Files. Download a copy before reloading.'
        : path ? 'Account document ready.' : 'New document. Save it to your account.';
      lifecycle.changed(); render();
    } catch(error) {
      if (!disposed && error.name !== 'AbortError') { loadError = error.message; status.textContent = 'Could not open ' + (path || 'this document') + ': ' + error.message + ' Retry when it is available.'; }
      throw error;
    } finally { loading = false; if (!disposed) render(); }
  }
  const ready = initialize(); ready.catch(() => {});
  const persist = () => { if (!disposed && loaded) void checkpoint().catch(() => {}); };
  const visibility = () => { if (document.hidden) persist(); };
  document.addEventListener('visibilitychange', visibility); globalThis.addEventListener?.('pagehide', persist);
  function dispose() { if (disposed) return; disposed = true; clearTimeout(timer); dialog?.(); events.abort(); recovery?.close(); lifecycle.close(); document.removeEventListener('visibilitychange', visibility); globalThis.removeEventListener?.('pagehide', persist); signal?.removeEventListener('abort', dispose); editor.destroy(); element.remove(); }
  signal?.addEventListener('abort', dispose, {once:true}); if (signal?.aborted) dispose(); render();
  const publicLifecycle = Object.freeze({...lifecycle, async commitClose() {
    if (disposed) return true;
    if (busy) throw Error('Wait for the current save before closing.');
    if (loaded && !editor.isClean() && closeIntent !== editor.snapshot()) throw Error('Text changed after close confirmation.');
    const wasPaused = paused; paused = true; editor.setReadOnly(true); clearTimeout(timer);
    try { if (loaded) await recovery?.clear(); recovery?.close(); return true; }
    catch (error) { paused = wasPaused; editor.setReadOnly(paused || !loaded); notify(error); throw error; }
  }});
  const bindingSnapshot = () => Object.freeze({documentId, path, revision, loaded});
  const fileBinding = Object.freeze({snapshot: bindingSnapshot, subscribe(listener) {
    if (typeof listener !== 'function') throw TypeError('File binding listener required.');
    let previous = bindingSnapshot();
    return lifecycle.subscribe(() => { const next = bindingSnapshot();
      if (next.path === previous.path && next.revision === previous.revision && next.loaded === previous.loaded) return;
      previous = next; listener(next);
    });
  }});
  return Object.freeze({element, ready, inspect, execute, fileBinding, retry: () => run('retry'), focus() {check(); if (!loaded || dialog) return false; editor.focus(); return true;}, lifecycle: publicLifecycle, dispose, async requestClose() {
    check(); closeIntent = null;
    if (busy) {status.textContent = 'Wait for the current save before closing.'; return false;}
    if (!loaded || editor.isClean()) return true;
    await checkpoint().catch(() => {});
    const snapshot = editor.snapshot(), choice = await ask({kind:'close'});
    if (choice === 'discard') { if (editor.snapshot() !== snapshot) { status.textContent = 'Document changed during confirmation. Review the newer edits.'; return false; } closeIntent = snapshot; return true; }
    if (choice === 'save') {try {return await saveDocument();}catch(error) {notify(error);}}
    return false;
  }});
}
