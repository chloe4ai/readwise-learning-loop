// "What to read next" for Readwise Books.
//
// A bookstore home page usually ranks by popularity. Readwise knows something no other store
// does: what each reader has already highlighted, and (with Learning Loop) what they have been
// learning in AI conversations. This module turns that into a ranked, explainable shelf.
//
//   final = wTaste  · taste    (how strongly your highlights point at this book)
//         + wIntent · intent   (how well it fits what you're working on this week)
//         + wGap    · gap      (you've been learning this topic from AI chats, not yet from a book)
//   then MMR (Maximal Marginal Relevance) over topics, so the shelf isn't five investing books.
//
// Books you already have highlights from are removed, and every pick says which of your own
// highlights it came from. Everything runs client-side; relevance is BM25 (see rank.js).

import { tokenize, jaccard, isCJKHeavy } from './text.js';
import { BM25, clamp01 } from './rank.js';

const AI_AUTHORS = new Set(['claude', 'chatgpt', 'ai conversation']);

export function isFromAIChat(h) {
  return (h.tags || []).includes('ai-chat') || AI_AUTHORS.has(String(h.author || '').toLowerCase());
}

function bookDoc(b) {
  return [b.title, b.author, (b.topics || []).join(' '), b.blurb, b.zh || ''].join(' ');
}

function highlightDoc(h) {
  return [h.text, h.title, (h.tags || []).join(' ')].join(' ');
}

const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// `inner` appears in `outer` as whole words (Latin) or as a run of characters (CJK).
const containsWords = (outer, inner) => new RegExp(`(?<![a-z0-9])${escapeRe(inner)}(?![a-z0-9])`).test(outer);

// Library title `t` vs. catalog name `n` (both normalized). Exact, or the book's name inside a
// longer title ("The Art of War, annotated"). A short title inside the book's name only counts
// when it covers most of it, so an article called "Money" is not The Psychology of Money.
function titleMatches(t, n) {
  if (!t || !n) return false;
  if (t === n) return true;
  if (n.length >= 4 && containsWords(t, n)) return true;
  return t.length >= 4 && t.length >= n.length * 0.6 && containsWords(n, t);
}

// A catalog book counts as "already read" when a library highlight matches both its title
// (or an alias, e.g. a translated title) and its author. Matching on the title alone would
// wrongly hide "Working Backwards" because of an article with the same name.
export function ownedBookIds(library, catalog) {
  const lib = library.filter((h) => !isFromAIChat(h)).map((h) => ({ t: norm(h.title), a: norm(h.author) }));
  const owned = new Set();
  for (const b of catalog) {
    const names = [b.title, ...(b.aliases || [])].map(norm).filter((n) => n.length >= 2);
    const authors = [b.author, ...(b.authorAliases || [])].map(norm).filter(Boolean);
    const hit = lib.some(({ t, a }) =>
      t && names.some((n) => titleMatches(t, n)) &&
      authors.some((x) => a && (x.includes(a) || a.includes(x))));
    if (hit) owned.add(b.id);
  }
  return owned;
}

// Show the reader's own words, not stems: "preparing", not "prepar".
export function displayTerms(context, matched) {
  const want = new Set(matched);
  const out = [];
  for (const w of String(context).split(/[\s,.;:!?，。；：！？]+/)) {
    if (!w) continue;
    const hits = tokenize(w).filter((t) => want.has(t));
    if (!hits.length) continue;
    // Chinese has no spaces, so show the matched words (bigrams) rather than the whole sentence.
    const shown = isCJKHeavy(w) ? hits : [w.toLowerCase()];
    for (const x of shown) if (!out.includes(x)) out.push(x);
  }
  return out;
}

// What a store shows when it knows nothing about you: its own bestseller order.
export function storeDefault(catalog, { n = 5 } = {}) {
  return [...catalog].sort((a, b) => a.storeRank - b.storeRank).slice(0, n).map((b) => ({ b }));
}

export function recommendBooks(library, catalog, context = '', {
  n = 5, wTaste = 0.35, wIntent = 0.5, wGap = 0.15, lambda = 0.7, supportK = 3,
} = {}) {
  wTaste = clamp01(wTaste, 0.35);
  wIntent = clamp01(wIntent, 0.5);
  wGap = clamp01(wGap, 0.15);
  lambda = clamp01(lambda, 0.7);
  const owned = ownedBookIds(library, catalog);
  const bm = new BM25(catalog.map(bookDoc));

  // Highlight → book affinity matrix (BM25), normalized by its global max.
  const S = library.map((h) => {
    const q = tokenize(highlightDoc(h));
    return catalog.map((_, j) => bm.score(q, j).s);
  });
  // Loops, not Math.max(...arr): spreading a large library overflows the call stack.
  let maxS = 1e-9;
  for (const row of S) for (const v of row) if (v > maxS) maxS = v;

  const q = tokenize(context);
  const intentRaw = catalog.map((_, j) => bm.score(q, j));
  let maxI = 1e-9;
  for (const r of intentRaw) if (r.s > maxI) maxI = r.s;

  const scored = catalog.map((b, j) => {
    const support = library
      .map((h, i) => ({ h, s: S[i][j] / maxS }))
      .filter((x) => x.s > 0.08)
      .sort((a, b2) => b2.s - a.s)
      .slice(0, supportK);
    const taste = support.length ? support.reduce((t, x) => t + x.s, 0) / supportK : 0;
    // Share of the evidence (weighted by strength) that came from AI conversations.
    const total = support.reduce((t, x) => t + x.s, 0);
    const aiShare = total ? support.filter((x) => isFromAIChat(x.h)).reduce((t, x) => t + x.s, 0) / total : 0;
    // Only a real gap when most of what points at this book came from AI chats.
    const gap = aiShare >= 0.6 ? aiShare * Math.min(1, taste * 2) : 0;
    const intent = intentRaw[j].s / maxI;
    return {
      b, taste, intent, gap, aiShare, support,
      matched: intentRaw[j].matched,
      terms: displayTerms(context, intentRaw[j].matched),
      owned: owned.has(b.id),
      final: wTaste * taste + wIntent * intent + wGap * gap,
      topicSet: new Set([...(b.topics || []), ...tokenize((b.topics || []).join(' '))]),
    };
  });

  const pool = scored.filter((x) => !x.owned).sort((a, b) => b.final - a.final);
  const picked = [];
  while (picked.length < n && pool.length) {
    let best = 0;
    let bestVal = -Infinity;
    pool.forEach((c, idx) => {
      const sim = picked.length ? Math.max(...picked.map((p) => jaccard(p.topicSet, c.topicSet))) : 0;
      const val = lambda * c.final - (1 - lambda) * sim;
      if (val > bestVal) { bestVal = val; best = idx; }
    });
    const [chosen] = pool.splice(best, 1);
    picked.push(chosen);
  }

  return {
    picks: picked.map(({ topicSet, ...rest }) => rest),
    skippedOwned: catalog.filter((b) => owned.has(b.id)),
  };
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// Plain-language reasons, so a reader can see why a book is on their shelf.
export function explainBook(item) {
  const out = [];
  const terms = item.terms && item.terms.length ? item.terms : item.matched || [];
  if (terms.length && item.intent > 0.25) {
    out.push({ kind: 'intent', text: `fits this week: “${terms.slice(0, 3).join('”, “')}”` });
  }
  const top = item.support && item.support[0];
  if (top && top.s >= 0.2) {
    const src = isFromAIChat(top.h) ? top.h.author : top.h.title;
    out.push({ kind: 'taste', text: `because you highlighted “${clip(top.h.text, 70)}” (${src})` });
  }
  if (item.gap >= 0.8) {
    out.push({ kind: 'gap', text: 'you have learned this mostly in AI chats; a book would go deeper' });
  }
  if (!out.length) out.push({ kind: 'variety', text: 'keeps the shelf varied' });
  return out;
}
