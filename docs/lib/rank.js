// Context-aware Daily Review.
//
// Readwise's Daily Review today is driven by spaced repetition: "which highlights are due?"
// This module adds a second question: "which due highlights matter to what I'm doing this week?"
//
//   final = wRel * relevance(context) + wDue * dueness
//   then re-rank with MMR (Maximal Marginal Relevance) so one book can't take over the session.
//
// Everything runs client-side; relevance is BM25 over highlight text + title + tags.

import { tokenize, jaccard, mulberry32 } from './text.js';

export class BM25 {
  constructor(docs, { k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.docs = docs.map((d) => tokenize(d));
    this.N = this.docs.length;
    this.avgdl = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.N);
    this.df = new Map();
    for (const d of this.docs) for (const t of new Set(d)) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.tf = this.docs.map((d) => {
      const m = new Map();
      for (const t of d) m.set(t, (m.get(t) || 0) + 1);
      return m;
    });
  }
  idf(t) {
    const n = this.df.get(t) || 0;
    return Math.log(1 + (this.N - n + 0.5) / (n + 0.5));
  }
  score(queryTokens, i) {
    const tf = this.tf[i];
    const dl = this.docs[i].length;
    let s = 0;
    const matched = [];
    for (const q of new Set(queryTokens)) {
      const f = tf.get(q);
      if (!f) continue;
      matched.push(q);
      s += this.idf(q) * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * dl) / this.avgdl)));
    }
    return { s, matched };
  }
}

// 0 = just reviewed, 1 = exactly due, capped at 1 when overdue.
export function dueness(h, now = Date.now()) {
  let days;
  if (typeof h.daysSinceReview === 'number') days = h.daysSinceReview;
  else if (h.lastReviewed) days = (now - new Date(h.lastReviewed).getTime()) / 86400000;
  else return 1;
  const interval = Math.max(1, h.intervalDays || 7);
  return Math.max(0, Math.min(1, days / interval));
}

function docText(h) {
  return [h.text, h.title, h.author, (h.tags || []).join(' ')].join(' ');
}

// Approximation of today's behavior: due-ness plus some shuffle. Seeded for reproducibility.
export function baselineReview(library, { n = 5, now = Date.now(), seed = 7 } = {}) {
  const rand = mulberry32(seed);
  return library
    .map((h) => {
      const due = dueness(h, now);
      return { h, due, rel: 0, final: 0.7 * due + 0.3 * rand(), matched: [] };
    })
    .sort((a, b) => b.final - a.final)
    .slice(0, n);
}

export function contextualReview(library, context, { n = 5, wRel = 0.65, wDue = 0.35, lambda = 0.75, now = Date.now() } = {}) {
  const bm = new BM25(library.map(docText));
  const q = tokenize(context);
  const raw = library.map((h, i) => ({ h, i, ...bm.score(q, i) }));
  const maxS = Math.max(1e-9, ...raw.map((r) => r.s));
  const scored = raw.map((r) => {
    const rel = r.s / maxS;
    const due = dueness(r.h, now);
    return { h: r.h, rel, due, matched: r.matched, final: wRel * rel + wDue * due, toks: new Set(tokenize(docText(r.h))) };
  });

  // MMR: trade a little relevance for variety (different ideas, different sources).
  const pool = [...scored].sort((a, b) => b.final - a.final);
  const picked = [];
  while (picked.length < n && pool.length) {
    let best = 0;
    let bestVal = -Infinity;
    pool.forEach((c, idx) => {
      const sim = picked.length
        ? Math.max(...picked.map((p) => Math.max(jaccard(p.toks, c.toks), p.h.title === c.h.title ? 0.6 : 0)))
        : 0;
      const val = lambda * c.final - (1 - lambda) * sim;
      if (val > bestVal) { bestVal = val; best = idx; }
    });
    const [chosen] = pool.splice(best, 1);
    chosen.mmr = bestVal;
    picked.push(chosen);
  }
  return picked.map(({ toks, ...rest }) => rest);
}

export function explain(item) {
  const bits = [];
  if (item.matched && item.matched.length) bits.push(`matches “${item.matched.slice(0, 4).join('”, “')}”`);
  if (item.due >= 1) bits.push('due for review');
  else if (item.due < 0.3) bits.push('reviewed recently');
  return bits.join(' · ') || 'keeps the session varied';
}
