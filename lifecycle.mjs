// Text lifecycle shared by the active view and desktop integration.
export function createTextLifecycle({readState, pause, resume}) {
  let revision=0, closed=false, lease=null;
  const listeners=new Set();
  const snapshot=()=>{if(closed)throw Error('Text window is closed.');return Object.freeze({revision,...readState()});};
  const changed=()=>{if(closed)return;revision++;for(const listener of [...listeners])try{listener();}catch(error){console.error('Text lifecycle listener failed',error);}};
  const subscribe=listener=>{if(closed)throw Error('Text window is closed.');if(typeof listener!=='function')throw TypeError('Listener required.');listeners.add(listener);let active=true;return()=>{if(active){active=false;listeners.delete(listener);}};};
  const quiesce=async({signal}={})=>{if(closed)throw Error('Text window is closed.');if(signal?.aborted)throw Error('Text pause cancelled.');if(lease)throw Error('Text is already paused.');if(readState().pending)throw Error('Finish the pending Text operation first.');pause();let active=true;const release=()=>{if(!active)return;active=false;signal?.removeEventListener('abort',release);if(lease===release)lease=null;if(!closed)resume();};lease=release;signal?.addEventListener('abort',release,{once:true});if(signal?.aborted){release();throw Error('Text pause cancelled.');}return Object.freeze({release});};
  const close=()=>{if(closed)return;closed=true;lease?.();listeners.clear();};
  return Object.freeze({snapshot,subscribe,quiesce,changed,close});
}
