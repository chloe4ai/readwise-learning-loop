// Output adapters for Readwise.
// Field names and limits follow the public API docs: https://readwise.io/api_deets

export const SOURCE_TYPE = 'learning_loop'; // 3–64 chars, no spaces

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) : s);

export function toApiHighlight(h) {
  const out = {
    text: clip(h.text, 8191),
    title: clip(h.title, 511),
    author: clip(h.author, 1024),
    source_type: SOURCE_TYPE,
    category: 'articles',
    location_type: 'order',
  };
  const tags = (h.tags || []).map((t) => `.${t.replace(/\s+/g, '-')}`).join(' ');
  const note = [h.note, tags].filter(Boolean).join('\n');
  if (note) out.note = clip(note, 8191); // ".tag" in a note becomes a Readwise tag
  if (Number.isInteger(h.location)) out.location = h.location;
  if (h.highlighted_at) out.highlighted_at = h.highlighted_at;
  return out;
}

export function toApiPayload(highlights) {
  return { highlights: highlights.map(toApiHighlight) };
}

// Readwise CSV import template columns.
export const CSV_HEADER = ['Highlight', 'Title', 'Author', 'URL', 'Note', 'Location', 'Date'];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(highlights) {
  const rows = highlights.map((h) => [h.text, h.title, h.author, '', h.note || '', h.location ?? '', h.highlighted_at || '']);
  return [CSV_HEADER, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

export async function checkToken(token, fetchImpl = fetch) {
  const r = await fetchImpl('https://readwise.io/api/v2/auth/', { headers: { Authorization: `Token ${token}` } });
  return r.status === 204;
}

export async function pushHighlights(token, highlights, { fetchImpl = fetch, batchSize = 100 } = {}) {
  let sent = 0;
  for (let i = 0; i < highlights.length; i += batchSize) {
    const batch = highlights.slice(i, i + batchSize);
    const r = await fetchImpl('https://readwise.io/api/v2/highlights/', {
      method: 'POST',
      headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(toApiPayload(batch)),
    });
    if (r.status === 429) {
      const wait = Number(r.headers.get('Retry-After') || 5);
      await new Promise((res) => setTimeout(res, wait * 1000));
      i -= batchSize;
      continue;
    }
    if (!r.ok) throw new Error(`Readwise API error ${r.status}: ${await r.text()}`);
    sent += batch.length;
  }
  return sent;
}
