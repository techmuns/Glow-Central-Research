// tabs/ask-research.js — a dashboard-wide conversational research workspace.

import { empty, el } from '../core/dom.js';
import * as watchlist from '../core/watchlist.js';
import * as scopeLists from '../core/scope-lists.js';
import { scopeLabel } from '../data/scope.js';
import { buildResearchEvidence, researchSuggestions } from '../research/estate.js';
import { renderResearchAnswer, renderResearchSources } from '../research/renderer.js';

export const meta = {
  id: 'ask-research',
  title: 'Ask Research',
  subtitle: 'Ask across every dashboard tab, with optional current web research.',
  subviews: [],
  allowEmptyScope: true,
};

const STORAGE_KEY = 'sattva:ask-research:v1';
const MAX_SESSIONS = 24;
const MAX_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 8_000;

let sessions = loadSessions();
let activeId = sessions[0]?.id || null;
let ctxRef = null;
let uiDispose = null;
let configState = null;
let configPromise = null;
const generations = new Map();

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `research-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function newSession() {
  const now = new Date().toISOString();
  return {
    id: makeId(),
    title: 'New research',
    createdAt: now,
    updatedAt: now,
    messages: [],
    draft: '',
    webResearch: false,
    status: 'idle',
    phase: '',
    error: null,
    streamText: '',
    streamSources: [],
    streamDashboard: [],
  };
}

function normaliseSession(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const messages = Array.isArray(raw.messages)
    ? raw.messages
        .filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message?.text === 'string')
        .slice(-MAX_MESSAGES)
        .map((message) => ({
          role: message.role,
          text: message.text.slice(0, MAX_MESSAGE_CHARS),
          webResearch: message.webResearch === true,
          dashboardSources: Array.isArray(message.dashboardSources) ? message.dashboardSources.slice(0, 16) : [],
          webSources: Array.isArray(message.webSources) ? message.webSources.slice(0, 12) : [],
        }))
    : [];
  return {
    id: raw.id,
    title: String(raw.title || 'Research conversation').slice(0, 120),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString(),
    messages,
    draft: '',
    webResearch: raw.webResearch === true,
    status: 'idle',
    phase: '',
    error: null,
    streamText: '',
    streamSources: [],
    streamDashboard: [],
  };
}

function loadSessions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normaliseSession).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, MAX_SESSIONS);
  } catch {
    return [];
  }
}

function persistSessions() {
  try {
    const payload = sessions
      .slice()
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, MAX_SESSIONS)
      .map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        webResearch: session.webResearch,
        messages: session.messages.slice(-MAX_MESSAGES),
      }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // The active in-memory conversation remains usable when device persistence is unavailable.
  }
}

function currentSession() {
  return sessions.find((session) => session.id === activeId) || null;
}

function ensureSession() {
  let session = currentSession();
  if (session) return session;
  session = newSession();
  sessions.unshift(session);
  activeId = session.id;
  return session;
}

function shortTitle(question) {
  const oneLine = String(question).replace(/\s+/g, ' ').trim();
  return oneLine.length > 76 ? `${oneLine.slice(0, 75)}…` : oneLine;
}

function timeLabel(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function isBusy(session) {
  return generations.has(session.id);
}

function abortActiveGenerations() {
  for (const generation of generations.values()) generation.controller.abort();
}

function template(scope) {
  return `
    <section class="research-workspace" data-research-workspace>
      <div class="research-workspace-header">
        <div>
          <div class="flex items-center gap-2">
            <span class="research-spark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 3 1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8L12 3Z" stroke-linejoin="round"/><path d="m19 15 .7 2.1L22 18l-2.3.9L19 21l-.7-2.1L16 18l2.3-.9L19 15Z" stroke-linejoin="round"/></svg>
            </span>
            <h2 class="font-display text-xl font-extrabold text-slate-900">Ask Research</h2>
          </div>
          <p class="mt-1 text-sm text-slate-500">One answer across every dashboard tab in ${scopeLabel(scope)} scope.</p>
        </div>
        <span class="research-estate-chip">
          <span class="h-1.5 w-1.5 rounded-full bg-indigo-500"></span>
          Reads the whole dashboard
        </span>
      </div>

      <div class="research-layout">
        <aside class="research-sidebar" aria-label="Research conversations">
          <div class="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3.5">
            <div>
              <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Library</div>
              <h3 class="mt-0.5 text-sm font-bold text-slate-800">Conversations</h3>
            </div>
            <button type="button" class="research-new-button" data-research-new aria-label="Start a new research conversation">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke-linecap="round"/></svg>
              New
            </button>
          </div>
          <div class="research-session-list scrollbar-thin" data-research-sessions></div>
          <div class="border-t border-slate-100 px-4 py-3 text-[11px] leading-relaxed text-slate-400">
            Conversation history stays on this device. Each question and a bounded dashboard evidence packet are sent to OpenAI for the answer.
          </div>
        </aside>

        <div class="research-thread">
          <div class="research-transcript scrollbar-thin" role="log" aria-live="polite" aria-label="Research conversation" data-research-transcript></div>

          <div class="research-composer-wrap">
            <div class="research-config-notice hidden" data-research-config role="status"></div>
            <div class="research-phase min-h-[1.25rem]" role="status" aria-live="polite" data-research-phase></div>
            <div class="research-composer" data-research-composer>
              <textarea rows="1" maxlength="1500" data-research-input placeholder="Ask about anything in these reports…" aria-label="Ask about the dashboard"></textarea>
              <div class="research-composer-actions">
                <button type="button" class="research-web-button" data-research-web aria-pressed="false">
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.65" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M3.5 10h13M10 3c2 2.1 3 4.4 3 7s-1 4.9-3 7c-2-2.1-3-4.4-3-7s1-4.9 3-7Z"/></svg>
                  <span><strong>Web research</strong><small>Combine dashboard + web</small></span>
                </button>
                <button type="button" class="research-send-button" data-research-send aria-label="Send question">
                  <span>Send</span>
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m4 10 11-6-3 12-2.3-4.1L4 10Z" stroke-linejoin="round"/><path d="m9.7 11.9 2.4-3.1" stroke-linecap="round"/></svg>
                </button>
              </div>
            </div>
            <p class="mt-2 text-center text-[10px] text-slate-400">Dashboard figures remain the source of truth. Web research is clearly separated and linked.</p>
          </div>
        </div>
      </div>
    </section>`;
}

export function render(ctx) {
  cleanupUi();
  // A scope change changes the evidence universe. Do not let an answer assembled under the old
  // scope land inside a workspace now labelled as the new one.
  if (ctxRef && ctxRef.scope !== ctx.scope) {
    abortActiveGenerations();
  }
  ctxRef = ctx;
  ensureSession();
  ctx.root.innerHTML = template(ctx.scope);
  uiDispose = wire(ctx.root);
  paintAll();
  ensureConfig().then(() => {
    if (ctxRef === ctx) paintComposer();
  });
}

export function destroy() {
  cleanupUi();
  ctxRef = null;
  abortActiveGenerations();
}

function cleanupUi() {
  try {
    uiDispose?.();
  } catch (error) {
    console.error('[ask-research] UI cleanup failed', error);
  }
  uiDispose = null;
}

function wire(root) {
  const input = root.querySelector('[data-research-input]');
  // Scope editors intentionally postpone the shell remount until they close. Listen to the stores
  // as well as render() so a response cannot finish and enter conversation history while an open
  // editor has already changed the company set behind its evidence packet.
  const stopWatchlist = watchlist.onChange(() => {
    if (ctxRef?.scope === 'watchlist') abortActiveGenerations();
  });
  const stopScopeLists = scopeLists.onChange((scope) => {
    if (ctxRef?.scope === scope) abortActiveGenerations();
  });
  const onClick = (event) => {
    const sessionButton = event.target.closest('[data-research-session]');
    const deleteButton = event.target.closest('[data-research-delete]');
    const suggestion = event.target.closest('[data-research-suggestion]');
    if (deleteButton) {
      event.stopPropagation();
      deleteSession(deleteButton.dataset.researchDelete);
    } else if (sessionButton) {
      activeId = sessionButton.dataset.researchSession;
      paintAll();
    } else if (event.target.closest('[data-research-new]')) {
      const session = newSession();
      sessions.unshift(session);
      activeId = session.id;
      paintAll();
      root.querySelector('[data-research-input]')?.focus();
    } else if (event.target.closest('[data-research-web]')) {
      const session = currentSession();
      if (!session || isBusy(session) || !configState?.webResearchAvailable) return;
      session.webResearch = !session.webResearch;
      paintComposer();
    } else if (event.target.closest('[data-research-send]')) {
      submitCurrent();
    } else if (suggestion) {
      const session = currentSession();
      if (!session) return;
      session.draft = suggestion.dataset.researchSuggestion || '';
      paintComposer();
      submitCurrent();
    }
  };
  const onInput = () => {
    const session = currentSession();
    if (!session) return;
    session.draft = input.value;
    autoSize(input);
    syncSendState();
  };
  const onKeydown = (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    submitCurrent();
  };
  root.addEventListener('click', onClick);
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeydown);
  return () => {
    root.removeEventListener('click', onClick);
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKeydown);
    stopWatchlist();
    stopScopeLists();
  };
}

function deleteSession(id) {
  const session = sessions.find((item) => item.id === id);
  if (!session || isBusy(session)) return;
  sessions = sessions.filter((item) => item.id !== id);
  if (activeId === id) activeId = sessions[0]?.id || null;
  ensureSession();
  persistSessions();
  paintAll();
}

async function ensureConfig() {
  // A confirmed 200 response is stable for this page session. Transport and 5xx failures are not:
  // keep their explanatory state visible, but let the next mount retry instead of wedging the SPA.
  if (configState && configState.retryable !== true) return configState;
  if (configPromise) return configPromise;
  configPromise = fetch('api/research', { headers: { accept: 'application/json' }, cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      configState = {
        configured: body?.configured === true,
        webResearchAvailable: body?.webResearchAvailable === true,
        retryable: false,
        message: body?.configured ? '' : 'Ask Research is not configured on this server. Add the server-side OpenAI key to enable answers.',
      };
      return configState;
    })
    .catch(() => {
      configState = {
        configured: false,
        webResearchAvailable: false,
        retryable: true,
        message: 'Ask Research needs the Cloudflare Worker runtime and its server-side OpenAI key.',
      };
      return configState;
    })
    .finally(() => {
      configPromise = null;
    });
  return configPromise;
}

function paintAll() {
  if (!ctxRef) return;
  ensureSession();
  paintSidebar();
  paintTranscript();
  paintComposer();
}

function paintSidebar() {
  const root = ctxRef?.root;
  const list = root?.querySelector('[data-research-sessions]');
  if (!list) return;
  empty(list);
  const ordered = sessions.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  for (const session of ordered) {
    const busy = isBusy(session);
    const item = el('div', {
      class: `research-session ${session.id === activeId ? 'is-active' : ''}`,
    });
    const button = el('button', {
      type: 'button',
      class: 'flex min-w-0 flex-1 items-center text-left',
      'data-research-session': session.id,
      'aria-current': session.id === activeId ? 'true' : null,
    });
    const body = el('span', { class: 'min-w-0 flex-1 text-left' });
    body.appendChild(el('strong', { class: 'research-session-title' }, session.title));
    body.appendChild(el('span', { class: `research-session-meta ${session.status === 'needs-attention' ? 'text-rose-500' : ''}` }, busy ? session.phase || 'Answering…' : session.status === 'needs-attention' ? 'Needs attention' : timeLabel(session.updatedAt)));
    button.appendChild(body);
    const remove = el('button', {
      type: 'button',
      tabindex: busy ? '-1' : '0',
      class: 'research-session-delete',
      'data-research-delete': session.id,
      'aria-label': `Delete ${session.title}`,
      'aria-disabled': busy ? 'true' : 'false',
      title: busy ? 'Wait for this answer to finish' : 'Delete conversation',
    });
    remove.appendChild(el('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'aria-hidden': 'true' }, [
      el('path', { d: 'M5 6h10M8 6V4h4v2m-6 0 .7 10h6.6L14 6M8.5 9v4M11.5 9v4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    ]));
    item.appendChild(button);
    item.appendChild(remove);
    list.appendChild(item);
  }
}

function paintTranscript() {
  const root = ctxRef?.root;
  const transcript = root?.querySelector('[data-research-transcript]');
  const session = currentSession();
  if (!transcript || !session) return;
  const followLive = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
  const showOpening = !session.messages.length && !session.streamText && !isBusy(session);
  empty(transcript);

  if (showOpening) {
    transcript.appendChild(openingState(ctxRef.scope));
    transcript.scrollTop = 0;
    requestAnimationFrame(() => {
      if (transcript.isConnected) transcript.scrollTop = 0;
    });
  } else {
    const stack = el('div', { class: 'research-message-stack' });
    for (const message of session.messages) stack.appendChild(messageNode(message));
    if (isBusy(session)) stack.appendChild(streamNode(session));
    transcript.appendChild(stack);
  }

  if (!showOpening && (followLive || isBusy(session))) {
    transcript.style.scrollBehavior = 'auto';
    transcript.scrollTop = transcript.scrollHeight;
    requestAnimationFrame(() => {
      if (!transcript.isConnected) return;
      transcript.scrollTop = transcript.scrollHeight;
      transcript.style.scrollBehavior = '';
    });
  }
}

function openingState(scope) {
  const wrap = el('div', { class: 'research-opening' });
  const icon = el('span', { class: 'research-opening-icon', 'aria-hidden': 'true' });
  icon.appendChild(el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7' }, [
    el('path', { d: 'm12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z', 'stroke-linejoin': 'round' }),
    el('path', { d: 'M5 15v4m-2-2h4M19 14v5m-2.5-2.5h5', 'stroke-linecap': 'round' }),
  ]));
  wrap.appendChild(icon);
  wrap.appendChild(el('h3', { class: 'font-display mt-5 text-2xl font-extrabold tracking-tight text-slate-900' }, 'Research the whole picture'));
  wrap.appendChild(el('p', { class: 'mt-2 max-w-2xl text-sm leading-6 text-slate-500' }, `Ask one question across every dashboard tab in ${scopeLabel(scope)} scope. Ask Research checks each source, preserves its period and provenance, and never turns missing data into a number.`));

  const promises = el('div', { class: 'research-opening-promises' });
  for (const item of [
    ['Every tab', 'Earnings, calls, chatter, technicals, filings, investor books and portfolio analytics.'],
    ['Traceable', 'Material figures name the dashboard page they came from.'],
    ['Optional web', 'Turn on web research to combine current external context with dashboard evidence.'],
  ]) {
    const card = el('div', { class: 'research-promise' });
    card.appendChild(el('span', { class: 'research-promise-dot' }));
    const copy = el('span');
    copy.appendChild(el('strong', { class: 'block text-xs font-bold text-slate-700' }, item[0]));
    copy.appendChild(el('span', { class: 'mt-0.5 block text-[11px] leading-4 text-slate-400' }, item[1]));
    card.appendChild(copy);
    promises.appendChild(card);
  }
  wrap.appendChild(promises);

  const label = el('div', { class: 'mt-7 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400' }, 'Try asking');
  wrap.appendChild(label);
  const suggestions = el('div', { class: 'research-suggestions' });
  for (const suggestion of researchSuggestions(scope)) {
    const button = el('button', { type: 'button', class: 'research-suggestion', 'data-research-suggestion': suggestion });
    button.appendChild(el('span', {}, suggestion));
    button.appendChild(el('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'aria-hidden': 'true' }, [el('path', { d: 'm7 4 6 6-6 6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })]));
    suggestions.appendChild(button);
  }
  wrap.appendChild(suggestions);
  return wrap;
}

function messageNode(message) {
  if (message.role === 'user') {
    const row = el('div', { class: 'research-user-row' });
    row.appendChild(el('div', { class: 'research-user-bubble' }, message.text));
    return row;
  }
  const article = el('article', { class: 'research-assistant-answer' });
  const label = el('div', { class: 'research-answer-label' });
  label.appendChild(el('span', { class: 'research-mini-spark', 'aria-hidden': 'true' }, '✦'));
  label.appendChild(el('span', {}, message.webResearch ? 'Dashboard + web research' : 'Dashboard research'));
  article.appendChild(label);
  const body = el('div', { class: 'research-answer-body' });
  renderResearchAnswer(body, message.text);
  article.appendChild(body);
  const sources = el('div', { class: 'research-sources' });
  renderResearchSources(sources, { dashboard: message.dashboardSources, web: message.webSources });
  article.appendChild(sources);
  return article;
}

function streamNode(session) {
  const article = el('article', { class: 'research-assistant-answer is-streaming', 'aria-live': 'off' });
  const label = el('div', { class: 'research-answer-label' });
  label.appendChild(el('span', { class: 'research-live-dot', 'aria-hidden': 'true' }));
  label.appendChild(el('span', {}, session.webResearch ? 'Dashboard + web research' : 'Dashboard research'));
  article.appendChild(label);
  if (session.streamText) {
    const body = el('div', { class: 'research-answer-body' });
    renderResearchAnswer(body, session.streamText);
    article.appendChild(body);
  } else {
    article.appendChild(el('div', { class: 'research-thinking' }, [
      el('span'), el('span'), el('span'), el('strong', {}, session.phase || 'Reading the dashboard'),
    ]));
  }
  return article;
}

function paintComposer() {
  const root = ctxRef?.root;
  const session = currentSession();
  if (!root || !session) return;
  const input = root.querySelector('[data-research-input]');
  const web = root.querySelector('[data-research-web]');
  const composer = root.querySelector('[data-research-composer]');
  const notice = root.querySelector('[data-research-config]');
  const phase = root.querySelector('[data-research-phase]');
  const busy = isBusy(session);
  const configured = configState?.configured === true;

  if (input.value !== session.draft) input.value = session.draft;
  input.disabled = busy || !configured;
  input.placeholder = configured ? 'Ask about anything in these reports…' : 'Assistant is not configured';
  autoSize(input);
  composer.classList.toggle('is-disabled', !configured);

  web.disabled = busy || !configState?.webResearchAvailable;
  web.classList.toggle('is-active', session.webResearch);
  web.setAttribute('aria-pressed', String(session.webResearch));
  web.querySelector('small').textContent = session.webResearch ? 'Dashboard + current web' : 'Combine dashboard + web';

  notice.classList.toggle('hidden', configured || configState === null);
  notice.textContent = configState?.message || '';
  phase.textContent = session.error || (busy ? session.phase : '');
  phase.classList.toggle('text-rose-600', !!session.error);
  syncSendState();
}

function syncSendState() {
  const root = ctxRef?.root;
  const session = currentSession();
  const send = root?.querySelector('[data-research-send]');
  if (!send || !session) return;
  const disabled = !configState?.configured || isBusy(session) || !session.draft.trim();
  send.disabled = disabled;
  send.classList.toggle('is-busy', isBusy(session));
  send.querySelector('span').textContent = isBusy(session) ? 'Working' : 'Send';
}

function autoSize(input) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(180, Math.max(44, input.scrollHeight))}px`;
}

function setPhase(session, phase) {
  session.phase = phase;
  if (activeId === session.id) {
    paintComposer();
    paintTranscript();
  }
  paintSidebar();
}

function dashboardSources(evidence) {
  const byTab = new Map();
  for (const source of evidence?.sources || []) {
    if (source.status !== 'ready' || byTab.has(source.tab)) continue;
    byTab.set(source.tab, { id: source.id, tab: source.tab, route: source.route });
  }
  return [...byTab.values()];
}

async function submitCurrent() {
  const session = currentSession();
  if (!session || isBusy(session) || !configState?.configured) return;
  const question = session.draft.trim();
  if (!question) return;

  const originalDraft = session.draft;
  const userMessage = { role: 'user', text: question };
  session.messages.push(userMessage);
  if (session.messages.filter((message) => message.role === 'user').length === 1) session.title = shortTitle(question);
  session.updatedAt = new Date().toISOString();
  session.draft = '';
  session.error = null;
  session.status = 'answering';
  session.streamText = '';
  session.streamSources = [];
  session.streamDashboard = [];

  const generation = { controller: new AbortController(), paintQueued: false };
  generations.set(session.id, generation);
  setPhase(session, 'Opening every dashboard source…');
  paintAll();

  try {
    const evidence = await buildResearchEvidence({
      question,
      scope: ctxRef?.scope || 'portfolio',
      onProgress: ({ completed, total, source }) => setPhase(session, `Reading ${source} · ${completed} of ${total}`),
    });
    if (generation.controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    session.streamDashboard = dashboardSources(evidence);
    setPhase(session, session.webResearch ? 'Sending dashboard evidence and starting web research…' : 'Writing from dashboard evidence…');

    const history = session.messages.slice(0, -1).map((message) => ({ role: message.role, text: message.text }));
    const response = await fetch('api/research', {
      method: 'POST',
      headers: { accept: 'application/x-ndjson', 'content-type': 'application/json' },
      body: JSON.stringify({ question, scope: evidence.scope, webResearch: session.webResearch, history, evidence }),
      signal: generation.controller.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || `Research request failed (HTTP ${response.status}).`);
    }
    if (!response.body) throw new Error('The research response had no stream.');
    await consumeStream(response.body, session, generation);
  } catch (error) {
    const index = session.messages.lastIndexOf(userMessage);
    if (index >= 0) session.messages.splice(index, 1);
    session.draft = originalDraft;
    session.streamText = '';
    session.streamSources = [];
    session.streamDashboard = [];
    session.status = error?.name === 'AbortError' ? 'idle' : 'needs-attention';
    session.error = error?.name === 'AbortError' ? null : error?.message || 'Research could not be completed.';
    session.phase = '';
    persistSessions();
  } finally {
    generations.delete(session.id);
    if (session.status === 'answering') session.status = 'idle';
    if (activeId === session.id && ctxRef) paintAll();
    else if (ctxRef) paintSidebar();
  }
}

async function consumeStream(stream, session, generation) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  let streamError = null;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    buffer += decoder.decode(part.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error('The answer stream was malformed.');
      }
      if (event.type === 'text' && typeof event.text === 'string') {
        session.streamText += event.text;
        queueStreamPaint(session, generation);
      } else if (event.type === 'phase' && event.phase) {
        setPhase(session, event.phase);
      } else if (event.type === 'sources') {
        session.streamSources = Array.isArray(event.sources) ? event.sources : [];
      } else if (event.type === 'done') {
        done = true;
      } else if (event.type === 'error') {
        streamError = event.message || 'Research could not be completed.';
      }
    }
  }
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer);
      if (event.type === 'done') done = true;
      if (event.type === 'error') streamError = event.message || 'Research could not be completed.';
    } catch {
      throw new Error('The answer stream ended mid-event.');
    }
  }
  if (streamError) throw new Error(streamError);
  if (!done || !session.streamText.trim()) throw new Error('The answer ended before a complete response arrived.');

  session.messages.push({
    role: 'assistant',
    text: session.streamText.slice(0, MAX_MESSAGE_CHARS),
    webResearch: session.webResearch,
    dashboardSources: session.streamDashboard,
    webSources: session.streamSources,
  });
  session.messages = session.messages.slice(-MAX_MESSAGES);
  session.updatedAt = new Date().toISOString();
  session.streamText = '';
  session.streamSources = [];
  session.streamDashboard = [];
  session.status = 'idle';
  session.phase = '';
  session.error = null;
  persistSessions();
}

function queueStreamPaint(session, generation) {
  if (generation.paintQueued) return;
  generation.paintQueued = true;
  requestAnimationFrame(() => {
    generation.paintQueued = false;
    if (activeId === session.id && ctxRef) paintTranscript();
  });
}
