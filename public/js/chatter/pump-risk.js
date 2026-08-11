// chatter/pump-risk.js — the pump-risk heuristic.
//
// A spike in message volume is not the same thing as interest. Six accounts forwarding the
// same bullish note four hundred times is a manufactured spike, and a dashboard that ranks
// purely by volume would put it at the top and call it "trending".
//
// So this computes a 0–3 flag from named, inspectable criteria and returns the reasons with
// their measured values. The UI is required to show those reasons wherever it shows the flag —
// the number on its own is a verdict nobody can check.
//
//   const risk = pumpRisk(group);
//   risk.level      // 0..3
//   risk.label      // 'Clear' | 'Watch' | 'Elevated' | 'High'
//   risk.reasons    // [{ id, label, fired, detail }] — ALL criteria, fired or not
//   risk.gate       // the volume gate, separately, since it can veto the whole thing
//
// THIS IS A HEURISTIC, NOT A FINDING. It says "this pattern is consistent with coordinated
// posting", never "this is a pump". The thresholds below are judgement calls, deliberately
// written as named constants so they can be argued with rather than reverse-engineered.

// --- thresholds ---------------------------------------------------------------------------
// A burst has to clear both of these before any signal counts. A ten-message-a-day group with
// one enthusiastic member is not interesting, however lopsided its ratios look.
const MIN_MESSAGES_24H = 120;
const MIN_VOLUME_SPIKE = 1.8; // vs the prior 24h

// Messages per distinct sender. Real discussion converges near 2–4; a wall of posts from a
// handful of accounts runs far higher.
const CONCENTRATION_MSGS_PER_SENDER = 12;

// Share of messages that are forwards rather than original posts.
const FORWARD_RATIO = 0.5;

// Mean sentiment. Genuine discussion contains disagreement; a coordinated push does not.
const UNIFORM_BULLISH = 0.55;

export const THRESHOLDS = {
  MIN_MESSAGES_24H,
  MIN_VOLUME_SPIKE,
  CONCENTRATION_MSGS_PER_SENDER,
  FORWARD_RATIO,
  UNIFORM_BULLISH,
};

export const RISK_LABEL = ['Clear', 'Watch', 'Elevated', 'High'];

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} group a row from chatter-telegram.json
 * @returns {{ level:number, label:string, reasons:Array, gate:object, msgsPerSender:number, spike:number|null }}
 */
export function pumpRisk(group) {
  const messages = Number(group?.messages24h) || 0;
  const prior = Number(group?.messagesPrior24h) || 0;
  const senders = Math.max(1, Number(group?.uniqueSenders24h) || 0);
  const forwards = Number(group?.forwardRatio) || 0;
  const sentiment = Number(group?.sentiment) || 0;

  const msgsPerSender = r1(messages / senders);
  const spike = prior > 0 ? r2(messages / prior) : null;

  // The gate: enough traffic, and traffic that actually jumped.
  const gateFired = messages >= MIN_MESSAGES_24H && (spike == null || spike >= MIN_VOLUME_SPIKE);
  const gate = {
    id: 'volume',
    label: 'Volume burst',
    fired: gateFired,
    detail: gateFired
      ? `${messages} messages in 24h${spike != null ? `, ${spike}× the previous day` : ''}`
      : messages < MIN_MESSAGES_24H
        ? `only ${messages} messages in 24h (needs ${MIN_MESSAGES_24H}+ to qualify)`
        : `${messages} messages, but only ${spike}× the previous day (needs ${MIN_VOLUME_SPIKE}×)`,
  };

  const signals = [
    {
      id: 'concentration',
      label: 'Few senders, many messages',
      fired: msgsPerSender >= CONCENTRATION_MSGS_PER_SENDER,
      detail: `${senders} distinct senders produced ${messages} messages — ${msgsPerSender} each${
        msgsPerSender >= CONCENTRATION_MSGS_PER_SENDER ? '' : ` (below the ${CONCENTRATION_MSGS_PER_SENDER} threshold)`
      }`,
    },
    {
      id: 'forwards',
      label: 'Mostly forwarded, not written',
      fired: forwards >= FORWARD_RATIO,
      detail: `${Math.round(forwards * 100)}% of messages are forwards${
        forwards >= FORWARD_RATIO ? '' : ` (below the ${Math.round(FORWARD_RATIO * 100)}% threshold)`
      }`,
    },
    {
      id: 'uniform',
      label: 'Uniformly bullish',
      fired: sentiment >= UNIFORM_BULLISH,
      detail: `mean sentiment ${sentiment > 0 ? '+' : ''}${r2(sentiment)}${
        sentiment >= UNIFORM_BULLISH ? ' — almost no disagreement in the room' : ` (below the +${UNIFORM_BULLISH} threshold)`
      }`,
    },
  ];

  // Without the volume gate, nothing counts: the ratios above are meaningless on a quiet group.
  const level = gateFired ? signals.filter((s) => s.fired).length : 0;

  return {
    level,
    label: RISK_LABEL[level],
    gate,
    reasons: [gate, ...signals],
    firedCount: signals.filter((s) => s.fired).length,
    msgsPerSender,
    spike,
  };
}

/** Tailwind classes for the risk pill. Rose/amber here are semantic — this IS a warning. */
export function riskPillClass(level) {
  return [
    'bg-slate-100 text-slate-600 ring-slate-200',
    'bg-slate-100 text-slate-700 ring-slate-300',
    'bg-amber-50 text-amber-700 ring-amber-200',
    'bg-rose-50 text-rose-700 ring-rose-200',
  ][level] || 'bg-slate-100 text-slate-600 ring-slate-200';
}

/** Row tint for levels 2–3, so a flagged group is visible while scanning the table. */
export function riskRowClass(level) {
  if (level >= 3) return 'bg-rose-50/40';
  if (level === 2) return 'bg-amber-50/40';
  return '';
}
