import { getPath } from './extract.mjs';

export function buildUrl(adapter, { page, since } = {}) {
  const url = new URL(adapter.access.url);
  const p = adapter.fetch?.pagination;
  if (p?.style === 'page-param' && page !== undefined) {
    url.searchParams.set(p.param, String(page));
    if (p.per_page_param) url.searchParams.set(p.per_page_param, String(p.per_page));
  }
  const inc = adapter.fetch?.incremental;
  if (inc?.param && since) url.searchParams.set(inc.param, since);
  return url.toString();
}

export async function fetchAll(adapter, { since, fetchImpl = fetch } = {}) {
  const p = adapter.fetch?.pagination;
  const maxPages = p?.max_pages ?? 1;
  const perPage = p?.per_page ?? Infinity;
  const timeoutMs = adapter.fetch?.timeout_ms ?? 30_000;
  const maxRecords = adapter.fetch?.max_records ?? 5000;
  const maxResponseBytes = adapter.fetch?.max_response_bytes ?? 20_000_000;
  const items = [];
  const statuses = [];
  let pages = 0;

  for (let page = 1; page <= maxPages; page++) {
    const url = buildUrl(adapter, { page, since });
    let res;
    try {
      res = await fetchImpl(url, {
        method: adapter.fetch?.method ?? 'GET',
        headers: adapter.fetch?.headers ?? {},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Runs unattended on a cron -- a bare "fetch failed" with no host or
      // URL in an Actions log is close to useless when tracking down which
      // of several adapters actually broke, or whether it was a timeout
      // versus DNS versus TLS.
      const reason = err?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : err.message;
      throw new Error(`fetch failed: ${reason} — ${url}`);
    }
    statuses.push(res.status);
    // Fail loudly. A UA-only bot gate shows up here as a 403 and must never be
    // swallowed into an empty result that looks like "no new records".
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`);

    const contentLength = res.headers?.get?.('content-length');
    if (contentLength && Number(contentLength) > maxResponseBytes) {
      throw new Error(`response too large: ${contentLength} bytes > max_response_bytes ${maxResponseBytes} — ${url}`);
    }

    const body = await res.json();
    const batch = getPath(body, adapter.records_path ?? '$') ?? [];
    // A path that resolves to a string is the sharpest edge case here: a
    // string is iterable, so an unguarded spread below would silently
    // consume it character-by-character and paginate to max_pages on
    // fabricated "records" instead of failing.
    if (!Array.isArray(batch)) {
      throw new Error(
        `records_path "${adapter.records_path ?? '$'}" resolved to ${typeof batch}, expected an array — ${url}`,
      );
    }
    pages++;
    items.push(...batch);
    if (items.length > maxRecords) {
      throw new Error(`fetch exceeded max_records (${maxRecords}) — check records_path/pagination for ${adapter.host}`);
    }
    if (batch.length < perPage) break;
  }
  return { items, pages, statuses };
}
