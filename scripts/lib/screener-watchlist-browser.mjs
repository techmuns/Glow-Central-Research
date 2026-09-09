import { parseWatchlistExport } from './screener-watchlist.mjs';

// Read both independent views before allowing a membership change. Screener
// omits its export form for a brand-new empty watchlist.
export async function readWatchlistInventory(page, { origin, watchlistId, watchlistName }) {
  const managePath = `/user/stocks/${watchlistId}/`;
  const watchlistPath = `/watchlist/${watchlistId}/`;
  const importPath = `/watchlist/import/${watchlistId}/`;
  async function go(path) {
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
    const url = new URL(page.url());
    if (!response?.ok() || url.origin !== origin || url.pathname !== path) throw new Error('Screener page unavailable');
  }

  await go(managePath);
  const title = (await page.locator('h1').first().textContent())?.trim();
  if (title !== `Add companies to ${watchlistName}`) throw new Error('Unexpected watchlist identity');
  if (await page.locator('#watchlist-search').count() !== 1 ||
      await page.locator(`a[href="${importPath}"]`).count() !== 1) {
    throw new Error('Watchlist management controls are unavailable');
  }
  const manageRows = await page.locator('button[onclick*="Watchlist.removeCompany"]').evaluateAll(buttons => buttons.map(button => {
    const onclick = button.getAttribute('onclick') || '';
    const companyId = /removeCompany\(['"](\d+)['"]\)/.exec(onclick)?.[1] || '';
    const container = button.closest('li, tr') || button.parentElement;
    const link = container?.querySelector('a[href^="/company/"]');
    return { companyId, href: link?.getAttribute('href') || '', name: (link?.textContent || container?.textContent || '').trim() };
  }));
  if (manageRows.some(row => !row.companyId) || new Set(manageRows.map(row => row.companyId)).size !== manageRows.length) {
    throw new Error('Unrecognized company removal controls');
  }
  const manageCompanyLinks = await page.locator('a[href^="/company/"]').count();

  await go(watchlistPath);
  if (await page.locator(`a[href^="${managePath}"]`).count() === 0) throw new Error('Watchlist manage link is unavailable');
  const forms = page.locator('form[action^="/api/export/screen/"]');
  if (await forms.count() === 0) {
    const tableCompanyLinks = await page.locator('a[href^="/company/"]').count();
    if (manageRows.length || manageCompanyLinks || tableCompanyLinks) throw new Error('Nonempty watchlist export is unavailable');
    return { current: [], manageRows };
  }
  const form = forms.first();
  const exportUrl = new URL(await form.getAttribute('action') || '', origin);
  if (exportUrl.origin !== origin || exportUrl.searchParams.get('sublist_id') !== watchlistId) throw new Error('Unexpected export target');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    form.locator('button[type="submit"], input[type="submit"]').first().click(),
  ]);
  if (await download.failure()) throw new Error('Watchlist export download failed');
  const chunks = [];
  const stream = await download.createReadStream();
  for await (const chunk of stream) chunks.push(chunk);
  await download.delete().catch(() => {});
  const current = parseWatchlistExport(Buffer.concat(chunks));
  if (manageRows.length !== current.length) throw new Error('Export and manage counts differ');
  return { current, manageRows };
}
