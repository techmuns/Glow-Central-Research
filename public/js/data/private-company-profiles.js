// Private Market's company descriptions, read once when a company card first opens (GLOW-OWNED).
// The file is written on a runner by scripts/build-private-company-profiles.mjs; the browser never
// fetches a company's own site. A failed read is a state the card names, never "no description".
import { revalidatedJson } from '../core/store.js';
import { profileKey, validProfiles } from './private-company-profiles-shared.js';

let file = null, pending = null, error = null;
const listeners = new Set();

export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
/** 'idle' | 'loading' | 'ready' | 'failed' */
export const status = () => file ? 'ready' : error ? 'failed' : pending ? 'loading' : 'idle';
export const meta = () => ({ generatedAt: file?.generatedAt || null, companies: file?.companies ?? null, found: file?.found ?? null, error });
/** The held answer for a company: a profile, or null when it has not been looked up yet. */
export const profileFor = (name) => file?.profiles?.[profileKey(name)] || null;

export function load() {
  if (file || pending) return pending || Promise.resolve(file);
  pending = revalidatedJson('data/private-company-profiles.json')
    .then((value) => { if (!validProfiles(value)) throw Error('Invalid company descriptions file'); file = value; error = null; })
    .catch((e) => { error = e?.message || 'Company descriptions unavailable'; })
    .finally(() => { pending = null; listeners.forEach((fn) => fn()); });
  return pending;
}
