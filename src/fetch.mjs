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
  const items = [];
  const statuses = [];
  let pages = 0;

  for (let page = 1; page <= maxPages; page++) {
    const url = buildUrl(adapter, { page, since });
    const res = await fetchImpl(url, {
      method: adapter.fetch?.method ?? 'GET',
      headers: adapter.fetch?.headers ?? {},
    });
    statuses.push(res.status);
    // Fail loudly. A UA-only bot gate shows up here as a 403 and must never be
    // swallowed into an empty result that looks like "no new records".
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`);
    const body = await res.json();
    const batch = getPath(body, adapter.records_path ?? '$') ?? [];
    pages++;
    items.push(...batch);
    if (batch.length < perPage) break;
  }
  return { items, pages, statuses };
}
