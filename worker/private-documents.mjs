// Small, bounded JSON reads shared by caller-authenticated document lookups.
export const privateReply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store', vary: 'Authorization', 'x-content-type-options': 'nosniff' } });

export async function boundedJson(message, limit, signal) {
  if (Number(message.headers.get('content-length')) > limit) { await message.body?.cancel(); throw new Error('too-large'); }
  const reader = message.body?.getReader();
  if (!reader) throw new Error('shape');
  let length = 0;
  const decoder = new TextDecoder();
  let body = '';
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error('timeout');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new Error('timeout');
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('too-large');
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
