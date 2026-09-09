import { revalidatedJson } from '../core/store.js';

let data = null, loading = null, checkedAt = 0;
export const evidence = () => data || { relations: [], holdings: [] };
export function loadEvidence() {
  if (data && Date.now() - checkedAt < 300000) return Promise.resolve(data);
  if (!loading) loading = revalidatedJson('data/holding-evidence.json', { optional: true }).then((next) => {
    if (Array.isArray(next?.relations) && Array.isArray(next?.holdings)) { data = next; checkedAt = Date.now(); }
    return data;
  }).finally(() => { loading = null; });
  return loading;
}
export function evidenceFor(id, kind = 'investor') {
  const relations = evidence().relations.filter((r) => (kind === 'investor' ? r.investorSlugs : r.managerIds)?.includes(id));
  return evidence().holdings.filter((h) => relations.some((r) => r.entityId === h.entityId)).map((h) => ({ ...h,
    relation: relations.find((r) => r.entityId === h.entityId) }));
}
