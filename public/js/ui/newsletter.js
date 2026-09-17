// ui/newsletter.js — THE NEWSLETTER CONTROL: one header button beside the bell, one panel.
//
// From it a reader subscribes their own address, adds colleagues, chooses which of the two daily
// briefs each address gets, sets the desk's two send times, previews an edition, sends a test copy
// to themselves or the edition to everyone, and reads what the last few sends did.
//
// EVERYTHING IT SHOWS IS READ FROM /api/newsletter WHEN THE PANEL OPENS, never on page load: the
// list is shared desk state held on the Worker, and a static origin has no Worker at all — which
// this panel names as such rather than rendering as an error. Nothing is fetched until somebody
// asks; the button carries no count and no dot it could not vouch for.
//
// THE PANEL IS A POPOVER LIKE THE INBOX, not an overlay: no backdrop, the page stays live behind
// it, Escape / an outside click / focus leaving it close it, and focus returns to the button.

import { escapeHtml } from '../core/dom.js';
import { formatRelativeTime } from '../core/format.js';
import { getHostContext, authHeaders } from '../core/host-context.js';
import * as people from '../core/watchlist-people.js';
import * as router from '../core/router.js';
import { EDITIONS, EDITION_IDS, normaliseEmail, istLabel } from '../data/newsletter-shared.js';

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
let note = null;          // { tone: 'ok' | 'warn' | 'error', text }
let confirmAll = false;
let edition = defaultEdition();

const REASONS = {
  'no-token': 'The Worker has no email token. An operator adds the MUNS_TOKEN secret in the Cloudflare dashboard; your own session can still send a copy from here.',
  unauthorised: 'The email service refused the token. It may have expired.',
  'rate-limited': 'The email service is rate-limiting sends. Try again in a minute.',
  'cooling-down': 'This edition went to everyone a few minutes ago. Wait five minutes before sending it again.',
  'no-recipients': 'Nobody is subscribed to this edition yet.',
  'book-unavailable': 'The portfolio book could not be read, so a brief about direct holdings could not be built.',
  'build-failed': 'The brief could not be built.',
  'invalid-email': 'Enter a valid email address first.',
  'rate-limit': 'Too many changes in a minute. Try again shortly.',
  'invalid-request': 'That change was refused.',
};

function defaultEdition() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date()));
  return hour < 12 ? 'morning' : 'evening';
}

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
export const state = () => ({ status, snapshot, busy, note, edition });

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

function contributor() {
  return people.me() || mine()?.name || myEmail() || null;
}

export async function subscribe(email, editions, { name = null, by = null } = {}) {
  const address = normaliseEmail(email);
  if (!address) throw Object.assign(new Error(REASONS['invalid-email']), { reason: 'invalid-email' });
  const who = by || contributor();
  if (!who) throw Object.assign(new Error('Say who is adding this address first.'), { reason: 'no-contributor' });
  const body = await post(ROUTE, { intents: [{ op: 'subscribe', email: address, editions, name, by: who }] });
  adopt(body);
  const outcome = body.outcomes?.find((o) => o.email === address)?.outcome;
  if (outcome === 'full') throw Object.assign(new Error('The list is full.'), { reason: 'full' });
  return outcome;
}

export async function unsubscribe(email) {
  const body = await post(ROUTE, { intents: [{ op: 'unsubscribe', email, by: contributor() }] });
  adopt(body);
}

export async function setEditions(email, editions) {
  const body = await post(ROUTE, { intents: [{ op: 'editions', email, editions }] });
  adopt(body);
}

export async function saveSettings(settings) {
  const body = await post(ROUTE, { settings });
  adopt(body);
  return body;
}

export async function send(to, which = edition, email = myEmail()) {
  return post(`${ROUTE}/send`, { edition: which, to, email });
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
  root.addEventListener('change', onChange);
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
    router.saveLastRoute(router.buildHash(route));
  } catch { /* the flag is a convenience; the panel still opens */ }
  setTimeout(open, 0);
  return true;
}

export function open() {
  if (!button) return;
  root.hidden = false; confirmAll = false; note = null;
  button.setAttribute('aria-expanded', 'true');
  paint(); position();
  root.querySelector('[data-brief-close]')?.focus();
  if (status !== 'loading') read();
}

export function close(restoreFocus) {
  if (!root || root.hidden) return;
  root.hidden = true; confirmAll = false;
  button?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) button?.focus();
}

function position() {
  if (!root || root.hidden || !button) return;
  const rect = button.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > innerHeight) { close(false); return; }
  const width = Math.min(440, innerWidth - 24);
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
  if (action === 'preview') { window.open(`${ROUTE}/preview?edition=${encodeURIComponent(edition)}`, '_blank', 'noopener'); return; }
  if (action === 'unsubscribe-me') {
    const email = mine()?.email; if (!email) return;
    act('unsubscribe', async () => { await unsubscribe(email); note = { tone: 'ok', text: `${email} will get no more briefs.` }; });
    return;
  }
  if (action === 'remove') {
    const email = target.dataset.email;
    act(`remove:${email}`, async () => { await unsubscribe(email); note = { tone: 'ok', text: `${email} removed.` }; });
    return;
  }
  if (action === 'send-test') {
    const email = myEmail() || root.querySelector('[data-brief-email]')?.value;
    act('send-test', async () => {
      const out = await send('me', edition, email);
      const first = out.outcomes?.[0];
      note = first?.ok
        ? { tone: 'ok', text: `Test copy of the ${EDITIONS[edition].label.toLowerCase()} sent to ${first.email}.` }
        : { tone: 'error', text: REASONS[out.reason || first?.reason] || `The copy was not sent (${out.reason || first?.reason || 'failed'}).` };
    });
    return;
  }
  if (action === 'send-all') { confirmAll = true; paint(); return; }
  if (action === 'send-all-cancel') { confirmAll = false; paint(); return; }
  if (action === 'send-all-confirm') {
    confirmAll = false;
    act('send-all', async () => {
      const out = await send('all', edition);
      if (out.reason === 'already-sent') { note = { tone: 'warn', text: 'That send was already recorded.' }; return; }
      const sent = out.sent || 0, failed = out.failed || 0;
      note = sent && !failed
        ? { tone: 'ok', text: `${EDITIONS[edition].label} sent to ${sent} ${sent === 1 ? 'address' : 'addresses'}.` }
        : sent ? { tone: 'warn', text: `Sent to ${sent}, ${failed} failed (${out.outcomes?.find((o) => !o.ok)?.reason || 'failed'}).` }
        : { tone: 'error', text: REASONS[out.reason] || `Nothing was sent (${out.reason || 'failed'}).` };
      await read();
    });
  }
}

function onSubmit(event) {
  const form = event.target.closest('form[data-brief-form]');
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.briefForm;
  const data = new FormData(form);
  if (kind === 'me') {
    const email = String(data.get('email') || '');
    const editions = EDITION_IDS.filter((id) => data.get(`edition-${id}`));
    act('subscribe-me', async () => {
      if (!editions.length) throw new Error('Choose at least one brief.');
      const by = String(data.get('by') || '').trim() || null;
      const outcome = await subscribe(email, editions, { by: by || normaliseEmail(email) });
      rememberMe(normaliseEmail(email));
      if (by) people.setMe(by);
      note = { tone: 'ok', text: outcome === 'unchanged' ? 'Already subscribed.' : `Subscribed. The next brief goes to ${normaliseEmail(email)}.` };
    });
  } else if (kind === 'add') {
    const email = String(data.get('email') || '');
    const editions = EDITION_IDS.filter((id) => data.get(`edition-${id}`));
    const by = String(data.get('by') || '').trim() || null;
    act('add', async () => {
      if (!editions.length) throw new Error('Choose at least one brief.');
      if (by) people.setMe(by);
      const outcome = await subscribe(email, editions, { by });
      form.reset();
      note = { tone: 'ok', text: outcome === 'unchanged' ? `${normaliseEmail(email)} is already on the list.` : `${normaliseEmail(email)} added.` };
    });
  } else if (kind === 'schedule') {
    const settings = Object.fromEntries(EDITION_IDS.map((id) => [id, { enabled: !!data.get(`enabled-${id}`), time: String(data.get(`time-${id}`) || EDITIONS[id].defaultTime) }]));
    act('schedule', async () => {
      await saveSettings(settings);
      note = { tone: 'ok', text: 'Schedule saved for the whole desk.' };
    });
  }
}

function onChange(event) {
  const target = event.target;
  if (target.matches('[data-brief-edition-select]')) { edition = target.value; paint(); return; }
  if (target.matches('[data-brief-my-edition]')) {
    const me = mine(); if (!me) return;
    const editions = [...root.querySelectorAll('[data-brief-my-edition]:checked')].map((n) => n.value);
    act('editions', async () => {
      if (!editions.length) throw new Error('Choose at least one brief, or unsubscribe.');
      await setEditions(me.email, editions);
      note = { tone: 'ok', text: 'Updated which briefs you get.' };
    });
  }
}

// ---- paint -------------------------------------------------------------------------------------

const check = (name, value, label, checked, extra = '') => `<label class="brief-check"><input type="checkbox" name="${name}" value="${escapeHtml(value)}" ${checked ? 'checked' : ''} ${extra}><span>${escapeHtml(label)}</span></label>`;
const editionLabel = (id, settings) => `${EDITIONS[id].short} ${settings?.[id]?.time || EDITIONS[id].defaultTime} IST`;
const outcomeText = (d) => {
  if (!d.finishedAt) return 'interrupted';
  if (d.reason === 'missed') return 'missed';
  if (d.reason === 'no-recipients') return 'nobody subscribed';
  if (d.reason === 'already-sent') return 'already sent';
  if (d.reason && !d.sent) return `not sent · ${d.reason}`;
  return `sent to ${d.sent} of ${d.recipients}${d.failed ? ` · ${d.failed} failed` : ''}`;
};

function paint() {
  if (button) {
    const me = mine();
    button.querySelector('[data-brief-dot]').hidden = !me;
    button.setAttribute('aria-label', me ? `Newsletter, subscribed as ${me.email}` : 'Newsletter');
    button.setAttribute('aria-expanded', String(!!root && !root.hidden));
  }
  if (!root || root.hidden) return;
  const head = `<div class="brief-heading"><h2>Newsletter</h2><span class="brief-heading-sub">Two briefs a day, weekdays</span><button type="button" class="brief-icon-button" data-brief-action="close" data-brief-close aria-label="Close newsletter">${CLOSE}</button></div>`;
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
  // Everything typed into an unsubmitted form, and the focus, survive the rebuild; the reader's
  // own edition ticks are the one exception, because there the server's answer is the truth.
  const kept = keepFields();
  root.innerHTML = head + body;
  restoreFields(kept);
  position();
}

function keepFields() {
  return [...root.querySelectorAll('input[name], select[name]')]
    .filter((el) => !el.hasAttribute('data-brief-my-edition'))
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
  const email = myEmail();
  const settings = snapshot.settings;
  const schedule = snapshot.schedule || {};
  const others = (snapshot.subscribers || []).filter((s) => s.email !== me?.email);
  const contributorName = people.me();
  const nameField = contributorName ? '' : `<input class="brief-input" type="text" name="by" placeholder="Your name (shown as who added it)" maxlength="60" autocomplete="name">`;

  const mineBlock = me
    ? `<section class="brief-section">
        <div class="brief-you"><span class="brief-you-mark">${MAIL}</span><div><strong>You're subscribed</strong><span>${escapeHtml(me.email)}</span></div></div>
        <div class="brief-check-row">${EDITION_IDS.map((id) => check('my-edition', id, editionLabel(id, settings), me.editions.includes(id), `data-brief-my-edition ${busy ? 'disabled' : ''}`)).join('')}</div>
        <div class="brief-actions"><button type="button" class="brief-button-secondary" data-brief-action="unsubscribe-me" ${busy ? 'disabled' : ''}>Unsubscribe</button></div>
      </section>`
    : `<section class="brief-section">
        <form data-brief-form="me" class="brief-form">
          <label class="brief-label" for="brief-my-email">Your email</label>
          <input id="brief-my-email" class="brief-input" type="email" name="email" data-brief-email value="${escapeHtml(email)}" placeholder="you@company.com" autocomplete="email" required inputmode="email">
          <div class="brief-check-row">${EDITION_IDS.map((id) => check(`edition-${id}`, '1', editionLabel(id, settings), true)).join('')}</div>
          ${nameField}
          <div class="brief-actions"><button type="submit" class="brief-button-primary" ${busy ? 'disabled' : ''}>${busy === 'subscribe-me' ? 'Subscribing…' : 'Subscribe'}</button></div>
        </form>
      </section>`;

  const next = schedule.next ? `Next: ${EDITIONS[schedule.next.edition].label}, ${istLabel(Date.parse(schedule.next.at))}` : 'No send is scheduled — both briefs are switched off.';
  const tokenNote = schedule.tokenConfigured === false
    ? `<p class="brief-warn">Scheduled sends need the team email token on the Worker (the <code>MUNS_TOKEN</code> secret). Until an operator adds it, only the buttons below can send, using your own session.</p>`
    : '';
  const scheduleBlock = `<section class="brief-section">
      <h3 class="brief-h3">When it sends</h3>
      <form data-brief-form="schedule" class="brief-form">
        ${EDITION_IDS.map((id) => `<div class="brief-time-row">
          <label class="brief-check"><input type="checkbox" name="enabled-${id}" value="1" ${settings?.[id]?.enabled ? 'checked' : ''}><span>${escapeHtml(EDITIONS[id].label)}</span></label>
          <input class="brief-input brief-input-time" type="time" name="time-${id}" value="${escapeHtml(settings?.[id]?.time || EDITIONS[id].defaultTime)}" aria-label="${escapeHtml(EDITIONS[id].label)} time (IST)"><span class="brief-muted">IST · ${escapeHtml(EDITIONS[id].covers)}</span>
        </div>`).join('')}
        <div class="brief-actions brief-actions-split"><span class="brief-muted" data-brief-next>${escapeHtml(next)}</span><button type="submit" class="brief-button-secondary" ${busy ? 'disabled' : ''}>Save for the desk</button></div>
      </form>
      ${tokenNote}
    </section>`;

  const teamRows = others.length
    ? others.map((s) => `<li class="brief-row"><div class="brief-row-copy"><strong>${escapeHtml(s.name || s.email)}</strong>${s.name ? `<span>${escapeHtml(s.email)}</span>` : ''}<span class="brief-muted">${escapeHtml(s.editions.map((id) => EDITIONS[id].short).join(' + '))}${s.addedBy ? ` · added by ${escapeHtml(s.addedBy)}` : ''}</span></div><button type="button" class="brief-icon-button" data-brief-action="remove" data-email="${escapeHtml(s.email)}" aria-label="Remove ${escapeHtml(s.email)}" title="Remove" ${busy ? 'disabled' : ''}>${CLOSE}</button></li>`).join('')
    : `<li class="brief-row brief-row-empty">Nobody else yet. Add the team below.</li>`;
  const teamBlock = `<section class="brief-section">
      <h3 class="brief-h3">Team <span class="brief-count">${snapshot.count} of ${snapshot.limit}</span></h3>
      <ul class="brief-list">${teamRows}</ul>
      <form data-brief-form="add" class="brief-form brief-form-inline">
        <input class="brief-input" type="email" name="email" placeholder="colleague@company.com" autocomplete="off" required inputmode="email" aria-label="Colleague's email">
        <div class="brief-check-row">${EDITION_IDS.map((id) => check(`edition-${id}`, '1', EDITIONS[id].short, true)).join('')}</div>
        ${nameField}
        <button type="submit" class="brief-button-secondary" ${busy ? 'disabled' : ''}>${busy === 'add' ? 'Adding…' : 'Add'}</button>
      </form>
    </section>`;

  const recipients = (snapshot.subscribers || []).filter((s) => s.editions.includes(edition)).length;
  const sendBlock = `<section class="brief-section">
      <h3 class="brief-h3">Send now</h3>
      <div class="brief-send-row">
        <select class="brief-input brief-select" data-brief-edition-select aria-label="Edition">${EDITION_IDS.map((id) => `<option value="${id}" ${id === edition ? 'selected' : ''}>${escapeHtml(EDITIONS[id].label)}</option>`).join('')}</select>
        <button type="button" class="brief-button-secondary" data-brief-action="preview">Preview</button>
        <button type="button" class="brief-button-secondary" data-brief-action="send-test" ${busy || !email ? 'disabled' : ''} title="${email ? `Send a copy to ${escapeHtml(email)}` : 'Enter your email above first'}">${busy === 'send-test' ? 'Sending…' : 'Send me a copy'}</button>
        ${confirmAll
          ? `<span class="brief-confirm">Send the ${escapeHtml(EDITIONS[edition].label.toLowerCase())} to ${recipients} ${recipients === 1 ? 'address' : 'addresses'} now? <button type="button" class="brief-button-primary" data-brief-action="send-all-confirm" ${busy || !recipients ? 'disabled' : ''}>Yes, send</button><button type="button" class="brief-button-secondary" data-brief-action="send-all-cancel">Cancel</button></span>`
          : `<button type="button" class="brief-button-primary" data-brief-action="send-all" ${busy || !recipients ? 'disabled' : ''}>${busy === 'send-all' ? 'Sending…' : `Send to everyone (${recipients})`}</button>`}
      </div>
      <p class="brief-muted">Built the moment you press it, covering the edition's window up to now. A copy and a test never count as the scheduled send.</p>
    </section>`;

  const deliveries = (snapshot.deliveries || []).slice(0, 4);
  const logBlock = deliveries.length
    ? `<section class="brief-section brief-section-log"><h3 class="brief-h3">Recent sends</h3><ul class="brief-log">${deliveries.map((d) => `<li><span>${escapeHtml(d.edition ? EDITIONS[d.edition].label : 'Brief')} · ${escapeHtml(d.source === 'timer' ? 'scheduled' : d.source === 'test' ? 'test copy' : 'sent by hand')}</span><span class="brief-muted" title="${escapeHtml(d.startedAt)}">${escapeHtml(formatRelativeTime(Date.parse(d.startedAt)))} · ${escapeHtml(outcomeText(d))}</span></li>`).join('')}</ul></section>`
    : '';

  const noteBlock = note ? `<p class="brief-note" data-tone="${note.tone}" role="status">${escapeHtml(note.text)}</p>` : '';
  return `<div class="brief-body">${noteBlock}${mineBlock}${sendBlock}${scheduleBlock}${teamBlock}${logBlock}</div>
    <p class="brief-storage">One shared list for the desk, kept on the Worker · ${escapeHtml(snapshot.updatedAt ? `changed ${formatRelativeTime(Date.parse(snapshot.updatedAt))}` : 'no changes yet')}</p>`;
}
