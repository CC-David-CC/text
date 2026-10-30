/** Browser text editor. The host supplies the shared persistent file client. */
export function browserEditorContent(host){
 const {desktop,w}=host,{make,textButton,appInput}=host.ui,{browserFileContext,browserFilesScope,browserFilesChanged,downloadGuestFile}=host.storage;
 const state=w.editor,owner=w.browserOwner,session=host.session(),body=make('div','window-content editor-content'),bar=make('form','app-toolbar'),path=appInput('Browser file path',state.path),area=make('textarea','guest-editor'),status=make('div','app-status');body.dataset.browserEditor='';area.setAttribute('aria-label','Browser text document');area.spellcheck=false;area.value=state.text;let busy=false;
 const valid=()=>!host.signal.aborted&&body.isConnected&&host.session()===session&&browserFilesScope()===owner;
 const update=()=>status.textContent=(state.dirty?'Unsaved changes · ':'')+state.text.length+' characters · saved browser file';update();
 async function load(){if(busy||!valid())return;busy=true;area.disabled=true;status.textContent='Loading browser file…';try{
  const c=await browserFileContext({signal:host.signal});if(!valid()||!c.valid())return;const result=await c.files.read(state.path);if(!valid()||!c.valid())return;needText(result.data);state.text=new TextDecoder('utf-8',{fatal:true}).decode(result.data);state.version=result.version;state.loaded=true;state.dirty=false;area.value=state.text;area.disabled=false;update();
 }catch(e){if(valid())status.textContent=e.message;}finally{busy=false;if(valid()&&state.loaded)area.disabled=false;}}
 function needText(bytes){if(bytes.length>2*1024*1024||bytes.slice(0,1024).includes(0))throw Error('Use Download in Files for binary files or text larger than 2 MiB.');}
 async function save(){if(busy||!valid())return;if(area.disabled||!state.loaded){status.textContent='Load a text file before saving.';return;}const target=path.value,text=area.value;busy=true;status.textContent='Saving in this browser…';try{
  const c=await browserFileContext({signal:host.signal});if(!valid()||!c.valid())return;const result=await c.files.write(target,text,target===state.path?state.version:null);if(!valid()||!c.valid())return;state.path=target;state.version=result.version;state.dirty=state.text!==text;w.title=target.split('/').pop()+' — Browser Text Editor';update();status.textContent=state.dirty?'Saved earlier text; newer edits are unsaved.':'Saved in this browser. Download a backup before clearing site data.';browserFilesChanged();desktop.render();
 }catch(e){if(valid())status.textContent=e.message;}finally{busy=false;}}
 bar.append(path,textButton('Save',save),textButton('Reload',()=>{if(!state.dirty||confirm('Discard unsaved edits and reload this browser file?'))load();}),textButton('Download',()=>{if(state.loaded&&valid())downloadGuestFile(state.path.split('/').pop(),new TextEncoder().encode(area.value));}));bar.addEventListener('submit',e=>{e.preventDefault();save();});
 area.addEventListener('input',()=>{state.text=area.value;state.dirty=true;update();});area.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();save();}if(e.key==='Tab'){e.preventDefault();area.setRangeText('    ',area.selectionStart,area.selectionEnd,'end');area.dispatchEvent(new Event('input',{bubbles:true}));}});
 body.append(bar,area,status);if(!state.loaded)queueMicrotask(load);return body;
}
