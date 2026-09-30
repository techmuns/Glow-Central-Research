// Collection health stays separate from the number of matching announcements on screen.
export function announcementCoverage(meta, now = Date.now()) {
  const fresh = value => {
    const time = Date.parse(value || '');
    return Number.isFinite(time) && time <= now + 600000 && now - time <= 4 * 3600000;
  };
  const notes = [];
  if (!fresh(meta.capturedAt) || meta.sourceCheck?.error || meta.coversUniverse !== true)
    notes.push('The latest BSE check is stale or incomplete.');
  if (meta.sourceCheck?.identityError) notes.push('The BSE company directory could not be refreshed. Saved company identities are in use.');
  const recovery = meta.recovery;
  if (!recovery?.available || recovery.error || !fresh(recovery.lastPageAt))
    notes.push('The backup announcement feed could not be fully checked.');
  else if (recovery.pendingCount) notes.push('The backup feed is still recovering missed intervals.');
  if (meta.nse?.error || meta.nse?.degraded) notes.push('The NSE feed has an incomplete check.');
  if (meta.archive?.error || meta.shared?.error) notes.push('Some saved announcement history could not be loaded.');
  const bseTime = fresh(meta.capturedAt) || Number.isFinite(Date.parse(meta.capturedAt || ''))
    ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(meta.capturedAt)) + ' IST'
    : 'unavailable';
  return { incomplete: !!notes.length, label: notes.length ? 'Some announcements may be missing' : `BSE checked ${bseTime}`,
    detail: [...notes, `Last BSE capture: ${bseTime}.`, 'Automatic checks continue; saved announcements remain available.'].join(' ') };
}
