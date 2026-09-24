// A shared presentation of Sattva's checked story developments. No second grouping engine.
// Original source rows stay intact for search, filters, exports and archived-story decisions.
import { storyGrouping } from './alert-stories.js';
import { clip, filingClaim } from './alert-claims.js';
export const KIND_LABEL = { filing:'Corporate announcement', news:'News', post:'Social post' };
export const storyKindOf = e => ({announcements:'filing','nse-filings':'filing',news:'news','market-news':'news',twitter:'post'})[e?.feed] || null;
export const membersOf = e => e?.storyReports?.length ? e.storyReports : [e];
export const venuesOf = e => [...new Set([...(String(e?.detail || '').match(/\b(?:NSE|BSE)\b/g) || []),
  ...(e?.feed === 'nse-filings' ? ['NSE'] : [])])];
export function publisherOf(e) {
  const named = e?.sourceRecord?.publisher || e?.sourceRecord?.source;
  if (typeof named === 'string' && named.trim()) return named.trim();
  try { return new URL(e.url).hostname.replace(/^www\./,''); } catch { return e?.feedLabel || e?.feed || ''; }
}
export function developmentOfRow(e) {
  if (!e) return null;
  if (e.development) return e.development;
  const members = membersOf(e), kind = storyKindOf(e);
  return { lead:e, kind, day:e.day, members, others:members.filter(m=>m.id!==e.id),
    filings:members.filter(m=>storyKindOf(m)==='filing').length,
    reports:members.filter(m=>storyKindOf(m)==='news').length,
    posts:members.filter(m=>storyKindOf(m)==='post').length,
    venues:[...new Set(members.flatMap(venuesOf))] };
}
export const developmentLine = (dev,{fallback=''}={}) => !dev?.lead ? fallback
  : dev.kind==='filing' ? filingClaim(dev.lead) : clip(dev.lead.headline || fallback);
export const developmentSource = dev => dev?.kind==='filing' ? dev.venues.join(' · ') || 'Exchange filing' : publisherOf(dev?.lead);
export const foldedSummary = dev => dev?.others?.length ? `${dev.others.length} other source ${dev.others.length===1?'report':'reports'}` : '';
export function foldedList(dev,{limit=Infinity,withLinks=false}={}) {
  const rows = dev?.others || [];
  return rows.slice(0,limit).map(e=>`${publisherOf(e)} · ${e.day || 'Date unavailable'}${e.time?' '+e.time:''} — ${e.headline || ''}${withLinks&&e.url?' — '+e.url:''}`)
    .concat(rows.length>limit?[`${rows.length-limit} more reports; all remain available in the source list/export.`]:[]).join('\n');
}
export const developmentSearchText = dev => (dev?.members || []).map(e=>[e.headline,e.detail,e.url,publisherOf(e)].filter(Boolean).join(' ')).join(' ');
const cache = new WeakMap();
export function foldAlertRows(events) {
  const revision = storyGrouping.revision(), held = cache.get(events);
  if (held?.revision===revision) return held.rows;
  const rows = storyGrouping.project(events).map(e => e.storyReports ? {...e,development:developmentOfRow(e)} : e);
  cache.set(events,{revision,rows});
  return rows;
}
export const foldDevelopments = events => foldAlertRows(events).map(developmentOfRow);

export async function foldAlertRowsAsync(events,options={}) {
  const revision=storyGrouping.revision(),held=cache.get(events);
  if(held?.revision===revision)return held.rows;
  const projected=await storyGrouping.projectAsync(events,options);
  if(!projected || revision!==storyGrouping.revision())return null;
  const rows=projected.map(e=>e.storyReports?{...e,development:developmentOfRow(e)}:e);
  cache.set(events,{revision,rows});return rows;
}
