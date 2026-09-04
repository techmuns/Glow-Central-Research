import * as coverage from './coverage.js';

/** Browser timers pause during sleep/BFCache. Revoke their old success before
 * checking again; a hidden-page response cannot overwrite the resumed check. */
export function bindFamilySyncLifecycle(win = window, doc = document) {
  const recheck = () => {
    coverage.invalidate();
    if (!doc.hidden && win.navigator.onLine !== false) void coverage.refresh();
  };
  const offline = () => coverage.invalidate('Offline — showing saved portfolio holdings, which may be out of date.');
  const changes = () => win.navigator.onLine === false ? offline() : recheck();
  const bindings = [[doc, 'visibilitychange', changes], [win, 'pageshow', changes],
    [win, 'focus', changes], [win, 'online', changes], [win, 'offline', offline]];
  for (const [target, event, fn] of bindings) target.addEventListener(event, fn);
  return () => { for (const [target, event, fn] of bindings) target.removeEventListener(event, fn); };
}
