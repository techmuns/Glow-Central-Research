// ui/newsletter.js — THE NEWSLETTER CONTROL: one header button beside the bell, one panel.
//
// KEPT DELIBERATELY SMALL (owner's ask, 17 September 2026: "keep it simple and easiest ui ux").
// The panel does three things and nothing else: subscribe or unsubscribe your own address, see and
// edit who else gets the brief, and preview either edition. Every address gets both editions; the
// send times, a manual send and the delivery log stay on the server (`/api/newsletter/send`,
// `settings`) and are not controls here. A name is never asked for: an addition is attributed to
// this device's known contributor, else the signed-in address, else the address itself.
//
// EVERYTHING IT SHOWS IS READ FROM /api/newsletter WHEN THE PANEL OPENS, never on page load: the
// list is shared desk state held on the Worker, and a static origin has no Worker at all — which
// this panel names as such rather than rendering as an error.
//
// THE PANEL IS A POPOVER LIKE THE INBOX, not an overlay: no backdrop, the page stays live behind
// it, Escape / an outside click / focus leaving it close it, and focus returns to the button.

import { escapeHtml } from '../core/dom.js';
import { getHostContext, authHeaders } from '../core/host-context.js';
import * as people from '../core/watchlist-people.js';
import * as router from '../core/router.js';
<<<<<<< HEAD
=======
import { saveLastRoute } from '../core/state.js';
>>>>>>> sattva/main
import { EDITIONS, EDITION_IDS, normaliseEmail } from '../data/newsletter-shared.js';

const ROUTE = '/api/newsletter';
const ME_KEY = 'sattva:newsletter:me';
const icon = (path) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const MAIL = icon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>');
const CLOSE = icon('<path d="m6 6 12 12M6 18 18 6"/>');

export const buttonHtml = `<button type="button" class="brief-button" data-brief-button aria-haspopup="dialog" aria-controls="brief-root" aria-expanded="false" title="Newsletter: the morning and evening brief by email">${MAIL}<span>Newsletter</span><span class="brief-button-dot" data-brief-dot hidden aria-hidden="true"></span></button>`;

let root = null;
let button = null;
let snapshot = null;      // the last successful read of /api/newsletter
let status = 'idle';      // idle | loading | ready | unavailable | offline
let busy = null;          // the action in flight, for disabled controls
let note = null;          // { tone: 'ok' | 'error', text }

const REASONS = {
  'invalid-email': 'Enter a valid email address.',
  'rate-limit': 'Too many changes in a minute. Try again shortly.',
  'invalid-request': 'That change was refused.',
};

function savedMe() {
  try { return normaliseEmail(localStorage.getItem(ME_KEY)) || ''; } catch { return ''; }
}
function rememberMe(email) {
  try { if (email) localStorage.setItem(ME_KEY, email); else localStorage.removeItem(ME_KEY); } catch { /* storage is a convenience */ }
}
export function myEmail() {
  return normaliseEmail(getHostContext().session?.email) || savedMe();
}
export const mine = () => (snapshot?.subscribers || []).find((s) => s.email === myEmail()) || null;
export const state = () => ({ status, snapshot, busy, note });

// ---- transport ---------------------------------------------------------------------------------

async function read() {
  status = snapshot ? status : 'loading';
  paint();
  let response;
  try {
    response = await fetch(ROUTE, { cache: 'no-store', headers: { accept: 'application/json', ...authHeaders(ROUTE) }, signal: AbortSignal.timeout(12000) });
  } catch {
    status = 'offline'; paint(); return;
  }
  // A static origin answers 404 (or a non-JSON page); a deployment whose object is down answers
  // 503. Those are different claims and the panel makes the right one.
  const type = response.headers.get('content-type') || '';
  if (response.status === 404 || response.status === 501 || !/json/.test(type)) { status = 'unavailable'; paint(); return; }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok || body?.ok !== true) { status = 'offline'; paint(); return; }
  snapshot = body; status = 'ready'; paint();
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST', cache: 'no-store',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...authHeaders(path) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  if (!parsed) throw Object.assign(new Error('The newsletter service did not answer.'), { reason: response.status === 404 ? 'unavailable' : 'offline' });
  if (!response.ok || parsed.ok === false) throw Object.assign(new Error(parsed.message || REASONS[parsed.reason] || 'That could not be done.'), { reason: parsed.reason || 'failed', body: parsed });
  return parsed;
}

async function act(name, fn) {
  if (busy) return;
  busy = name; note = null; paint();
  try {
    await fn();
  } catch (error) {
    note = { tone: 'error', text: error?.message || 'That could not be done.' };
  } finally {
    busy = null; paint();
  }
}

function adopt(body) {
  if (body && Array.isArray(body.subscribers)) snapshot = { ...(snapshot || {}), ...body };
  status = 'ready';
}

// ---- actions -----------------------------------------------------------------------------------

/** Who an addition is attributed to — the contract requires a name, the panel never asks for one. */
function contributor(fallback) {
  return people.me() || mine()?.name || myEmail() || fallback || null;
}

export async function subscribe(email, editions = EDITION_IDS) {
  const address = normaliseEmail(email);
  if (!address) throw Object.assign(new Error(REASONS['invalid-email']), { reason: 'invalid-email' });
  const body = await post(ROUTE, { intents: [{ op: 'subscribe', email: address, editions, name: null, by: contributor(address) }] });
  adopt(body);
  const outcome = body.outcomes?.find((o) => o.email === address)?.outcome;
  if (outcome === 'full') throw Object.assign(new Error('The list is full.'), { reason: 'full' });
  return outcome;
}

export async function unsubscribe(email) {
  const body = await post(ROUTE, { intents: [{ op: 'unsubscribe', email, by: contributor(email) }] });
  adopt(body);
}

// ---- the panel ---------------------------------------------------------------------------------

export function mount() {
  if (root?.isConnected) return root;
  root = document.createElement('section');
  root.id = 'brief-root'; root.className = 'brief-panel'; root.hidden = true;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Newsletter');
  document.body.appendChild(root);
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  document.addEventListener('pointerdown', (event) => { if (!root.hidden && !root.contains(event.target) && !button?.contains(event.target)) close(false); });
  document.addEventListener('focusin', (event) => { if (!root.hidden && !root.contains(event.target) && !button?.contains(event.target)) close(false); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !root.hidden) { event.preventDefault(); close(true); } });
  window.addEventListener('hashchange', () => { if (!openFromLink()) close(false); });
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position);
  paint();
  return root;
}

export function mountButton(node) {
  mount(); button = node;
  const toggle = () => (root.hidden ? open() : close(true));
  node.addEventListener('click', toggle);
  paint();
  openFromLink();
  return () => { node.removeEventListener('click', toggle); close(false); if (button === node) button = null; };
}

// The email's Unsubscribe link lands here with ?newsletter=manage. Open straight onto the panel,
// and scrub the flag from the URL and from the saved route: tab-owned params ride along on every
// navigation, so left in place it would reopen the panel on each tab change and on the next visit.
const MANAGE_RE = /[?&]newsletter=manage(?:&|$)/;
function openFromLink() {
  if (!MANAGE_RE.test(location.hash)) return false;
  try {
    const route = router.parseHash();
    if (route.params) delete route.params.newsletter;
    router.replaceRoute(route);
<<<<<<< HEAD
    router.saveLastRoute(router.buildHash(route));
=======
    // `saveLastRoute` lives in core/state.js, NOT on the router. Reaching for `router.saveLastRoute`
    // throws a TypeError straight into this catch, which reads as the flag being scrubbed while the
    // SAVED route keeps `?newsletter=manage` — so the next visit, restored from that saved hash,
    // reopens the panel over whatever the reader actually wanted. The URL and the saved copy have
    // to be corrected together or neither is corrected.
    saveLastRoute(router.buildHash(route));
>>>>>>> sattva/main
  } catch { /* the flag is a convenience; the panel still opens */ }
  setTimeout(open, 0);
  return true;
}

export function open() {
  if (!button) return;
  root.hidden = false; note = null;
  button.setAttribute('aria-expanded', 'true');
  paint(); position();
  root.querySelector('[data-brief-close]')?.focus();
  if (status !== 'loading') read();
}

export function close(restoreFocus) {
  if (!root || root.hidden) return;
  root.hidden = true;
  button?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) button?.focus();
}

function position() {
  if (!root || root.hidden || !button) return;
  const rect = button.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > innerHeight) { close(false); return; }
  const width = Math.min(360, innerWidth - 24);
  const top = Math.min(rect.bottom + 10, Math.max(12, innerHeight - 240));
  root.style.width = `${width}px`;
  root.style.left = `${Math.max(12, Math.min(rect.right - width, innerWidth - width - 12))}px`;
  root.style.top = `${top}px`;
  root.style.maxHeight = `${Math.max(200, Math.min(640, innerHeight - top - 12))}px`;
}

// ---- events ------------------------------------------------------------------------------------

function onClick(event) {
  const target = event.target.closest('[data-brief-action]');
  if (!target || target.disabled) return;
  const action = target.dataset.briefAction;
  if (action === 'close') { close(true); return; }
  if (action === 'retry') { read(); return; }
  if (action === 'preview') {
    const which = EDITIONS[target.dataset.edition] ? target.dataset.edition : 'morning';
    window.open(`${ROUTE}/preview?edition=${encodeURIComponent(which)}`, '_blank', 'noopener');
    return;
  }
  if (action === 'unsubscribe-me') {
    const email = mine()?.email; if (!email) return;
    act('unsubscribe', async () => { await unsubscribe(email); note = { tone: 'ok', text: 'Unsubscribed.' }; });
    return;
  }
  if (action === 'remove') {
    const email = target.dataset.email;
    act(`remove:${email}`, async () => { await unsubscribe(email); note = { tone: 'ok', text: `${email} removed.` }; });
  }
}

function onSubmit(event) {
  const form = event.target.closest('form[data-brief-form]');
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.briefForm;
  const email = String(new FormData(form).get('email') || '');
  if (kind === 'me') {
    act('subscribe-me', async () => {
      const outcome = await subscribe(email);
      rememberMe(normaliseEmail(email));
      note = { tone: 'ok', text: outcome === 'unchanged' ? 'Already subscribed.' : 'Subscribed.' };
    });
  } else if (kind === 'add') {
    act('add', async () => {
      const outcome = await subscribe(email);
      // The form was repainted while the request ran; clear the one on screen, not the detached copy.
      root.querySelector('form[data-brief-form="add"]')?.reset();
      note = { tone: 'ok', text: outcome === 'unchanged' ? `${normaliseEmail(email)} is already on the list.` : `${normaliseEmail(email)} added.` };
    });
  }
}

// ---- paint -------------------------------------------------------------------------------------

const clock = (time) => { const [h, m] = String(time).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
/** "morning only" for an address that does not get both editions; nothing when it does. */
const onlyNote = (editions) => (editions.length === 1 ? `${EDITIONS[editions[0]].short.toLowerCase()} only` : '');

function paint() {
  if (button) {
    const me = mine();
    button.querySelector('[data-brief-dot]').hidden = !me;
    button.setAttribute('aria-label', me ? `Newsletter, subscribed as ${me.email}` : 'Newsletter');
    button.setAttribute('aria-expanded', String(!!root && !root.hidden));
  }
  if (!root || root.hidden) return;
  const head = `<div class="brief-heading"><h2>Newsletter</h2><button type="button" class="brief-icon-button" data-brief-action="close" data-brief-close aria-label="Close newsletter">${CLOSE}</button></div>`;
  let body;
  if (status === 'loading' || status === 'idle') {
    body = `<div class="brief-body"><div class="brief-skeleton"><span></span><span></span><span></span></div></div>`;
  } else if (status === 'unavailable') {
    body = `<div class="brief-body"><p class="brief-empty"><strong>The newsletter isn't part of this deployment.</strong><span>It needs the Worker's /api/newsletter route; a static copy of the dashboard has none.</span></p></div>`;
  } else if (status === 'offline') {
    body = `<div class="brief-body"><p class="brief-empty"><strong>Couldn't reach the newsletter service.</strong><span>The list is kept on the Worker and it did not answer.</span></p><div class="brief-actions"><button type="button" class="brief-button-secondary" data-brief-action="retry">Try again</button></div></div>`;
  } else {
    body = readyBody();
  }
  // A repaint while the reader is typing must not take their words: the read that follows every
  // open lands a few hundred milliseconds after the form has already been painted and used.
  // Everything typed into an unsubmitted form, and the focus, survive the rebuild.
  const kept = keepFields();
  root.innerHTML = head + body;
  restoreFields(kept);
  position();
}

function keepFields() {
  return [...root.querySelectorAll('input[name]')]
    .map((el) => ({
      form: el.closest('form')?.dataset.briefForm || '', name: el.name, type: el.type,
      value: el.value, checked: el.checked, focused: el === document.activeElement,
      caret: typeof el.selectionStart === 'number' ? el.selectionStart : null,
    }));
}

function restoreFields(kept) {
  for (const field of kept) {
    const scope = field.form ? root.querySelector(`form[data-brief-form="${field.form}"]`) : root;
    const el = scope?.querySelector(`[name="${field.name}"]`);
    if (!el || el.type !== field.type) continue;
    if (field.type === 'checkbox') el.checked = field.checked;
    else if (field.value !== '') el.value = field.value;
    if (field.focused) {
      el.focus({ preventScroll: true });
      if (field.caret != null && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(field.caret, field.caret); } catch { /* not a text field */ } }
    }
  }
}

function readyBody() {
  const me = mine();
  const settings = snapshot.settings || {};
  const others = (snapshot.subscribers || []).filter((s) => s.email !== me?.email);
  const times = EDITION_IDS.map((id) => clock(settings[id]?.time || EDITIONS[id].defaultTime)).join(' and ');
  const disabled = busy ? 'disabled' : '';

  const youBlock = me
    ? `<div class="brief-you"><span class="brief-you-tick" aria-hidden="true">✓</span><span class="brief-you-copy">Subscribed as <strong>${escapeHtml(me.email)}</strong>${onlyNote(me.editions) ? ` <span class="brief-soft">· ${escapeHtml(onlyNote(me.editions))}</span>` : ''}</span><button type="button" class="brief-link" data-brief-action="unsubscribe-me" ${disabled}>Unsubscribe</button></div>`
    : `<form data-brief-form="me" class="brief-inline">
        <input class="brief-input" type="email" name="email" value="${escapeHtml(myEmail())}" placeholder="you@company.com" autocomplete="email" required inputmode="email" aria-label="Your email">
        <button type="submit" class="brief-button-primary" ${disabled}>${busy === 'subscribe-me' ? 'Subscribing…' : 'Subscribe'}</button>
      </form>`;

  const rows = others.map((s) => `<li class="brief-row"><span class="brief-row-copy">${escapeHtml(s.email)}${onlyNote(s.editions) ? ` <span class="brief-soft">· ${escapeHtml(onlyNote(s.editions))}</span>` : ''}</span><button type="button" class="brief-icon-button" data-brief-action="remove" data-email="${escapeHtml(s.email)}" aria-label="Remove ${escapeHtml(s.email)}" title="Remove" ${disabled}>${CLOSE}</button></li>`).join('');
  const teamBlock = `<div class="brief-team">
      <p class="brief-label">${others.length ? `Also receiving <span class="brief-soft">${others.length}</span>` : 'Add your team'}</p>
      ${rows ? `<ul class="brief-list">${rows}</ul>` : ''}
      <form data-brief-form="add" class="brief-inline">
        <input class="brief-input" type="email" name="email" placeholder="Add a teammate's email" autocomplete="off" required inputmode="email" aria-label="Teammate's email">
        <button type="submit" class="brief-button-secondary" ${disabled}>${busy === 'add' ? 'Adding…' : 'Add'}</button>
      </form>
    </div>`;

  const tokenNote = snapshot.schedule?.tokenConfigured === false ? '<p class="brief-soft brief-token">Emails won’t send until the MUNS_TOKEN secret is added on the Worker.</p>' : '';
  const noteBlock = note ? `<p class="brief-note" data-tone="${note.tone}" role="status">${escapeHtml(note.text)}</p>` : '';
  return `<div class="brief-body">
      <p class="brief-lede">Your portfolio companies by email at ${escapeHtml(times)} IST, weekdays.</p>
      ${noteBlock}
      <div class="brief-section">${youBlock}</div>
      <div class="brief-section">${teamBlock}</div>
      ${tokenNote}
    </div>
    <div class="brief-foot">Preview <button type="button" class="brief-link" data-brief-action="preview" data-edition="morning">Morning</button><span aria-hidden="true">·</span><button type="button" class="brief-link" data-brief-action="preview" data-edition="evening">Evening</button></div>`;
}
