// Shared text utilities: tokenization that works for English and Chinese.
// Used by both extraction (dedupe) and ranking (BM25, diversity).

const STOP = new Set(`a an and are as at be been but by can could do does for from had has have how i if in into is it its
just like may me more most my no not of on or our so such than that the their them then there these they this those to
too us very was we were what when where which while who why will with would you your also about over only one any each
other some been being get got here let make much many should via using use used really`.split(/\s+/));

// Function characters that make poor bigrams (的, 了, 和 ...).
const CJK_STOP = new Set('的了和是在也就都而及与或着把被让给吗呢吧啊很最のはがをにでとも'.split(''));
// Han (including the supplementary Extension B+ planes) and Japanese kana.
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu;

export function isCJKHeavy(s) {
  const cjk = (s.match(CJK_RUN) || []).join('').length;
  return cjk > s.length * 0.3;
}

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

// English: lowercase words minus stopwords, lightly stemmed.
// Chinese: character bigrams (a standard trick when no segmenter is available).
// Full-width ASCII → ASCII (ＡＩ → AI), and Latin diacritics dropped (café → cafe).
// Marks are only stripped after Latin letters, so kana like が keep their dakuten.
export function normalizeText(s) {
  return String(s)
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
    .toLowerCase();
}

export function tokenize(s) {
  if (!s) return [];
  const out = [];
  const lower = normalizeText(s);
  for (const run of lower.match(CJK_RUN) || []) {
    // Stop characters split the run instead of erasing their neighbours: 我的书 → 我, 书.
    let seg = [];
    const flush = () => {
      if (seg.length === 1) out.push(seg[0]);
      for (let i = 0; i < seg.length - 1; i++) out.push(seg[i] + seg[i + 1]);
      seg = [];
    };
    for (const ch of run) { // for…of walks code points, so Extension B characters stay whole
      if (CJK_STOP.has(ch)) flush();
      else seg.push(ch);
    }
    flush();
  }
  const latin = lower.replace(CJK_RUN, ' ');
  for (const w of latin.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || []) {
    const t = w.replace(/'s$/, '').replace(/^-+|-+$/g, '');
    if (t.length < 2 || STOP.has(t)) continue;
    out.push(stem(t));
  }
  return out;
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// Remove markdown decoration so highlights read cleanly in Readwise.
export function stripMarkdown(s) {
  return s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+•]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Deterministic PRNG so the "baseline" ordering is reproducible in the demo and tests.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
