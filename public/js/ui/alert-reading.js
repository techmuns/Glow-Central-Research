// Shared, viewport-only AI excerpt notes. Painting, searching and exporting cannot start AI work.
import { escapeHtml } from '../core/dom.js';
import { developmentOfRow } from '../data/alert-developments.js';
import { noteRequestFor, requestNotes, onNotes } from '../data/alert-notes.js';
import { noteBodyHtml, NOTE_DISCLOSURE } from './alert-note.js';
const requests = new Map();
export function alertReadingHtml(event) {
  if (event.private || event.portfolioOnly || (event.importance !== 'high' && !(event.storyId && event.storyChange !== 'new'))) return '';
  const request = noteRequestFor(developmentOfRow(event));
  if (!request) return '';
  requests.set(request.handle,{request,event});
  return `<div data-alert-reading="${escapeHtml(request.handle)}" class="my-1 break-words text-xs leading-relaxed text-slate-600" title="${escapeHtml(NOTE_DISCLOSURE)}"><span class="font-semibold text-indigo-700">So what? · AI excerpt reading</span> <span data-alert-reading-body>${noteBodyHtml(request)}</span></div>`;
}
export function watchAlertReadings(root, {onVisible=null}={}) {
  const watched = new WeakSet(), visible = new Set();
  let timer=0,closed=false;
  const ask = () => {
    clearTimeout(timer);
    timer=setTimeout(()=>{
      if(closed || document.visibilityState==='hidden') return;
      const entries=[...visible].filter(n=>n.isConnected).map(n=>requests.get(n.dataset.alertReading)).filter(Boolean);
      requestNotes(entries.map(e=>e.request));
      onVisible?.(entries.map(e=>e.event));
    },200);
  };
  const observer = new IntersectionObserver(entries=>{
    for(const e of entries) e.isIntersecting ? visible.add(e.target) : visible.delete(e.target);
    ask();
  });
  const scan=()=>{
    for(const node of root.querySelectorAll('[data-alert-reading]')) if(!watched.has(node)){watched.add(node);observer.observe(node);}
    for(const node of visible) if(!node.isConnected){visible.delete(node);observer.unobserve(node);}
  };
  const mutations=new MutationObserver(scan);mutations.observe(root,{subtree:true,childList:true});scan();
  const off=onNotes(handles=>{
    const changed=new Set(handles);
    for(const node of root.querySelectorAll('[data-alert-reading]')) if(changed.has(node.dataset.alertReading)){
      const entry=requests.get(node.dataset.alertReading),body=node.querySelector('[data-alert-reading-body]');
      if(entry&&body)body.innerHTML=noteBodyHtml(entry.request);
    }
  });
  return ()=>{closed=true;clearTimeout(timer);off();observer.disconnect();mutations.disconnect();visible.clear();requests.clear();};
}
