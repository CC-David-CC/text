import {browserEditorContent} from './browser.mjs';
export function mount(host){
const {desktop,w}=host;const {make,textButton,appInput}=host.ui;const {guestFiles,serverFilesAvailable,serverFileContext,fileVolumeBar,serverFilesChanged,openGuestEditor,openServerEditor,downloadGuestFile,signedInSubject,browserFileContext,browserFilesScope,openBrowserEditor}=host.storage;const currentSession=host.session();
// Launch context is navigation only. Read document contents through the current
// authorized storage client, never from a caller-supplied document or grant.
if(w.launchContext&&!w.editor){
  const c=w.launchContext;
  if(!Object.isFrozen(c)||c.version!==1||!['guest','server','browser'].includes(c.storage)||typeof c.path!=='string'||!c.path||c.path.length>2048)throw Error('Invalid document context');
  if(c.storage==='browser'){
    if(c.owner!==browserFilesScope()||w.browserOwner!==c.owner||!c.path.startsWith('/')||c.path.split('/').slice(1).some(p=>!p||p==='.'||p==='..')||/[\\\x00-\x1f\x7f]/.test(c.path))throw Error('Invalid browser document context');
    w.editor={storage:'browser',path:c.path,text:'',loaded:false,dirty:false,version:null};
  }else if(c.storage==='server'){
    if(c.owner!==signedInSubject()||w.ownerSub!==c.owner||c.path.startsWith('/')||c.path.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.'))||/[\\%?#\x00-\x1f\x7f]/.test(c.path))throw Error('Invalid private document context');
    w.editor={storage:'server',path:c.path,text:'',loaded:false,dirty:false,sha256:null};
  }else{
    if(c.owner!==''||guestFiles.path(c.path)!==c.path)throw Error('Invalid guest document context');
    w.editor={path:c.path,text:'',loaded:false,dirty:false};
  }
}
function editorContent(desktop,w){
  if(w.editor?.storage==='browser')return browserEditorContent(host);
  if(w.editor?.storage==='server')return serverEditorContent(desktop,w);
  const body=make('div','window-content editor-content');const state=w.editor||(w.editor={path:'/Documents/Untitled.txt',text:'',loaded:true,dirty:false});
  const bar=make('form','app-toolbar'),path=appInput('File path','/home/guest'+state.path),area=make('textarea','guest-editor'),status=make('div','app-status');area.setAttribute('aria-label','Text document');area.spellcheck=false;area.value=state.text;
  let saving=false,loadRevision=0;
  const update=()=>{status.textContent=(state.dirty?'Unsaved changes · ':'')+state.text.length+' characters · temporary guest file';};update();
  const save=async()=>{if(saving)return;saving=true;++loadRevision;try{if(area.disabled)throw Error('This file is not open for text editing. Use Download in Files.');const p=guestFiles.path(path.value),text=area.value;if(p==='/')throw Error('Enter a filename.');await guestFiles.write(p,text);if(host.signal.aborted)return;state.path=p;state.text=area.value;state.dirty=area.value!==text;w.title=p.split('/').pop()+' — Text Editor';update();status.textContent=state.dirty?'Saved earlier text; newer edits are unsaved.':'Saved '+p+' in the guest. Download to keep it after this session.';}catch(e){if(!host.signal.aborted)status.textContent=e.message;}finally{saving=false;}};
  const saveBrowserCopy=async()=>{try{if(area.disabled)throw Error('Load an editable text file first.');const requested=prompt('Save a browser copy (absolute path on this device):','/'+state.path.split('/').pop());if(requested===null)return;const text=area.value,c=await browserFileContext({signal:host.signal});if(host.signal.aborted||!c.valid())return;await c.files.write(requested,text);if(host.signal.aborted||!c.valid())return;openBrowserEditor(desktop,c.owner,requested);status.textContent='Saved a copy in this browser. The Linux file remains temporary.';}catch(e){if(!host.signal.aborted)status.textContent=e.message;}};
  async function load(){if(saving)return;const request=++loadRevision,file=state.path,initial=area.value;try{if((await guestFiles.stat(file)).size>2*1024*1024)throw Error('File is too large for text editing.');if(host.signal.aborted||request!==loadRevision)return;const bytes=await guestFiles.read(file);if(host.signal.aborted||request!==loadRevision||state.path!==file)return;if(area.value!==initial){status.textContent='Newer edits kept; reload cancelled.';return;}if(bytes.slice(0,1024).includes(0))throw Error('This appears to be a binary file. Use Download.');state.loaded=true;area.disabled=false;state.text=new TextDecoder().decode(bytes);area.value=state.text;state.dirty=false;update();}catch(e){if(!host.signal.aborted&&request===loadRevision)status.textContent=e.message;}}
  bar.append(path,textButton('Save',save),textButton('Save browser copy…',saveBrowserCopy),textButton('Reload',()=>{if(!state.dirty||confirm('Discard unsaved edits and reload this file?'))load();}),textButton('Download',async()=>{try{const bytes=area.disabled?await guestFiles.read(state.path):new TextEncoder().encode(area.value);if(!host.signal.aborted)downloadGuestFile(state.path.split('/').pop(),bytes);}catch(e){if(!host.signal.aborted)status.textContent=e.message;}}));bar.addEventListener('submit',e=>{e.preventDefault();save();});
  area.addEventListener('input',()=>{state.text=area.value;state.dirty=true;update();});area.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();save();}if(e.key==='Tab'){e.preventDefault();const a=area.selectionStart,b=area.selectionEnd;area.setRangeText('    ',a,b,'end');state.text=area.value;state.dirty=true;update();}});
  if(!state.loaded){area.disabled=true;load();}
  body.append(bar,area,status);return body;
}

function serverEditorContent(desktop,w){
  const state=w.editor,body=make('div','window-content editor-content'),bar=make('form','app-toolbar');
  const path=appInput('Server file path',state.path),area=make('textarea','guest-editor'),status=make('div','app-status');
  body.dataset.serverEditor='true';area.setAttribute('aria-label','Server text document');area.spellcheck=false;area.value=state.text;
  const session=currentSession,valid=()=>!host.signal.aborted&&body.isConnected&&currentSession===session&&w.ownerSub===signedInSubject();let busy=false;
  const update=()=>{status.textContent=(state.dirty?'Unsaved changes · ':'')+state.text.length+' characters · private server file';};update();
  async function load(){
    if(busy)return;busy=true;area.disabled=true;status.textContent='Loading server file…';
    try{
      const c=await serverFileContext();if(!valid()||!c.valid())return;const result=await c.files.read(state.path);if(!valid())return;
      if(result.data.length>2*1024*1024||result.data.slice(0,1024).includes(0))throw Error('Use Download in Files for binary files or text larger than 2 MiB.');
      const text=new TextDecoder('utf-8',{fatal:true}).decode(result.data);state.text=text;state.sha256=result.sha256;state.loaded=true;state.dirty=false;area.value=text;area.disabled=false;update();
    }catch(error){if(valid())status.textContent=error.message;}
    finally{busy=false;if(valid()&&state.loaded)area.disabled=false;}
  }
  async function save(){
    if(busy)return;
    if(area.disabled||!state.loaded){status.textContent='Load a text file before saving.';return;}
    busy=true;const target=path.value,text=area.value;status.textContent='Saving on server…';
    try{
      const c=await serverFileContext();if(!valid()||!c.valid())return;const result=await c.files.write(target,text,target===state.path?state.sha256:null);if(!valid())return;
      state.path=target;state.sha256=result.sha256;state.dirty=state.text!==text;w.title=target.split('/').pop()+' — Server Text Editor';update();
      status.textContent=state.dirty?'Saved earlier text; newer edits are unsaved.':'Saved on the server.';serverFilesChanged();desktop.render();
    }catch(error){if(valid())status.textContent=error.message;}
    finally{busy=false;}
  }
  bar.append(path,textButton('Save',save),textButton('Reload',()=>{if(!state.dirty||confirm('Discard unsaved edits and reload this server file?'))load();}),textButton('Download',()=>{if(state.loaded)downloadGuestFile(state.path.split('/').pop(),new TextEncoder().encode(area.value));}));
  bar.addEventListener('submit',e=>{e.preventDefault();save();});
  area.addEventListener('input',()=>{state.text=area.value;state.dirty=true;update();});
  area.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();save();}if(e.key==='Tab'){e.preventDefault();area.setRangeText('    ',area.selectionStart,area.selectionEnd,'end');area.dispatchEvent(new Event('input',{bubbles:true}));}});
  body.append(bar,area,status);if(!state.loaded)queueMicrotask(load);return body;
}

return {element:editorContent(desktop,w),dispose(){}};
}
