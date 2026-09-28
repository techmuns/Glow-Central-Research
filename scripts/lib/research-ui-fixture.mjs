// Retained research components are tested in a local-only shell. The shipped tab registry
// deliberately has no Ask Research entry or feature-flag backdoor.
export function researchFixtureAsset(path, body, { first = false } = {}) {
  if (path !== '/js/ui/shell.js') return body;
  const source = String(body);
  if (!source.includes('tabs: [aiAlerts,')) throw new Error('Research fixture needs the current AI Alerts landing registry');
  return "import * as askResearch from '../tabs/ask-research.js';\n" + source
    .replace('tabs: [aiAlerts,', first ? 'tabs: [askResearch, aiAlerts,' : 'tabs: [aiAlerts, askResearch,')
    .replace("  'ask-research': { tab: 'ai-alerts', subview: null },\n", '');
}

export async function installResearchFixture(context) {
  await context.route('**/js/ui/shell.js', async route => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Research UI fixtures are local only');
    const response = await route.fetch();
    await route.fulfill({ response, body: researchFixtureAsset(url.pathname, await response.text()) });
  });
}
