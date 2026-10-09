// Only routing metadata is needed to draw the navigation. Secondary interfaces import on use;
// shared source readers, collection and durable history keep their existing app-wide lifetime.
import { VIEWS as announcementViews } from '../tabs/corp-announcements-views.js';
import { VIEWS as bookViews } from '../tabs/family-book-views.js';
import * as aiAlerts from '../tabs/ai-alerts.js';

export function lazyTab(meta, importer) {
  let module = null, pending = null;
  return {
    meta: { subviews: [], ...meta },
    load() {
      if (module) return Promise.resolve(module);
      if (!pending) pending = importer().then(value => (module = value))
        .finally(() => { pending = null; });
      return pending;
    },
    destroy() { module?.destroy?.(); },
  };
}

// Keep these routing fields in agreement with each module's meta (verify-startup-ui.mjs).
// Literal import paths also let the service worker warm every view for offline tab switches.
export const researchTabs = [
  // The landing interface is ready before app-wide source reads take the network slots.
  lazyTab(aiAlerts.meta, () => Promise.resolve(aiAlerts)),
  lazyTab({ id: 'daily-alerts', title: 'All Alerts', layout: 'table' }, () => import('../tabs/daily-alerts.js')),
  lazyTab({ id: 'bookmarks', title: 'Bookmarks', allowEmptyScope: true, scopeIndependent: true }, () => import('../tabs/bookmarks.js')),
  lazyTab({ id: 'earnings-hub', title: 'Earnings Hub' }, () => import('../tabs/earnings-hub.js')),
  lazyTab({ id: 'concall', title: 'Con-call' }, () => import('../tabs/concall.js')),
  lazyTab({ id: 'public-chatter', title: 'Public Chatter', allowEmptyScope: true }, () => import('../tabs/public-chatter.js')),
  lazyTab({ id: 'breakouts', title: 'Breakouts / Technical', subviews: [
    { id: 'strong-breakouts', label: 'Strong Breakouts' },
    { id: 'technical-scanner', label: 'Technical Scanner' },
    { id: 'fii-accumulation', label: 'FII Accumulation' },
  ] }, () => import('../tabs/breakouts.js')),
  lazyTab({ id: 'super-investors', title: 'Super Investors', subviews: [
    { id: 'superstar-investors', label: 'Superstar Investors' },
    { id: 'institutions', label: 'Institutions' },
  ] }, () => import('../tabs/super-investors.js')),
  lazyTab({ id: 'news', title: 'News' }, () => import('../tabs/news.js')),
  lazyTab({ id: 'ipos', title: 'IPOs', allowEmptyScope: true }, () => import('../tabs/ipos.js')),
  lazyTab({ id: 'corp-announcements', title: 'Corp Announcements', subviews: announcementViews, inlineSubviews: true },
    () => import('../tabs/corp-announcements.js')),
  lazyTab({ id: 'nse-filings', title: 'NSE Filings' }, () => import('../tabs/nse-filings.js')),
  lazyTab({ id: 'insider-trades', title: 'Bulk/Block Deal' }, () => import('../tabs/insider-trades.js')),
  lazyTab({ id: 'mutual-funds', title: 'Mutual Funds', allowEmptyScope: true, inlineSubviews: true, subviews: [
    { id: 'all-schemes', label: 'All Schemes' },
    { id: 'category-performance', label: 'Category Performance' },
    { id: 'company-holdings', label: 'Company Holdings' },
  ] }, () => import('../tabs/mutual-funds.js')),
  lazyTab({ id: 'macro-research', title: 'Macro Research', allowEmptyScope: true, subviews: [
    { id: 'commodities', label: 'Commodities' },
    { id: 'indices', label: 'Global Indices' },
    { id: 'currencies', label: 'Currencies' },
    { id: 'rates', label: 'Rates & Bonds' },
    { id: 'fpi', label: 'FPI Activity' },
  ] }, () => import('../tabs/macro-research.js')),
  lazyTab({ id: 'economy-macro', title: 'Economy & Macro', allowEmptyScope: true }, () => import('../tabs/economy-macro.js')),
  lazyTab({ id: 'family-book', title: 'Family Book', allowEmptyScope: true, inlineSubviews: true, subviews: bookViews },
    () => import('../tabs/family-book.js')),
];
