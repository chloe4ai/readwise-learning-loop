import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tokenize, stripMarkdown, jaccard } from '../docs/lib/text.js';
import { detectAndParse, parseChatGPTExport, parseTranscript, extractHighlights } from '../docs/lib/extract.js';
import { BM25, dueness, contextualReview, baselineReview } from '../docs/lib/rank.js';
import { toApiHighlight, toCSV, pushHighlights, SOURCE_TYPE } from '../docs/lib/readwise.js';

const claude = JSON.parse(readFileSync(new URL('../docs/data/sample_claude_export.json', import.meta.url)));
const library = JSON.parse(readFileSync(new URL('../docs/data/sample_library.json', import.meta.url)));

test('tokenize handles English stemming and Chinese bigrams', () => {
  assert.deepEqual(tokenize('The auctions are pricing clicks'), ['auction', 'pric', 'click']);
  assert.deepEqual(tokenize('复利定投'), ['复利', '利定', '定投']);
});

test('stripMarkdown removes emphasis, bullets, links', () => {
  assert.equal(stripMarkdown('- **Bid shading** is [rational](http://x)'), 'Bid shading is rational');
});

test('parses Claude export into normalized turns', () => {
  const convos = detectAndParse(claude);
  assert.equal(convos.length, 3);
  assert.equal(convos[0].source, 'claude');
  assert.equal(convos[0].turns[0].role, 'user');
});

test('parses ChatGPT export following current_node branch only', () => {
  const data = [{ title: 'T', create_time: 1700000000, current_node: 'c', mapping: {
    r: { id: 'r', parent: null, children: ['a'], message: null },
    a: { id: 'a', parent: 'r', children: ['b', 'x'], message: { author: { role: 'user' }, content: { parts: ['Why?'] }, create_time: 1700000001 } },
    x: { id: 'x', parent: 'a', children: [], message: { author: { role: 'assistant' }, content: { parts: ['abandoned branch'] } } },
    b: { id: 'b', parent: 'a', children: ['c'], message: { author: { role: 'assistant' }, content: { parts: ['kept answer'] } } },
    c: { id: 'c', parent: 'b', children: [], message: { author: { role: 'user' }, content: { parts: ['thanks'] } } },
  } }];
  const [c] = parseChatGPTExport(data);
  assert.deepEqual(c.turns.map((t) => t.text), ['Why?', 'kept answer', 'thanks']);
});

test('parses a plain transcript with prefixes (English and Chinese)', () => {
  const [c] = parseTranscript('User: what is X?\nClaude: X is a thing.\n more\n我：懂了');
  assert.equal(c.turns.length, 3);
  assert.equal(c.turns[1].text, 'X is a thing.\n more');
});

test('extracts substantive sentences, skips filler, attaches the question', () => {
  const hs = extractHighlights(detectAndParse(claude));
  const texts = hs.map((h) => h.text);
  assert.ok(hs.length >= 6, `got ${hs.length}`);
  assert.ok(!texts.some((t) => /^(Great question|Let me know|好的|希望)/.test(t)), 'filler leaked');
  assert.ok(texts.some((t) => t.includes('Bid shading')));
  assert.ok(!texts.some((t) => /^(It|This|That) /.test(t)), 'context-dependent sentence leaked');
  assert.ok(texts.some((t) => /复利/.test(t)), 'Chinese conversation produced a highlight');
  assert.ok(hs.every((h) => h.note.startsWith('Q: ')));
  // no near-duplicates within a conversation
  for (const a of hs) for (const b of hs) if (a !== b && a.conversationId === b.conversationId)
    assert.ok(jaccard(tokenize(a.text), tokenize(b.text)) <= 0.45);
});

test('BM25 ranks the matching doc first', () => {
  const bm = new BM25(['ad auction reserve price', 'spaced repetition memory', 'index fund fees']);
  const q = tokenize('reserve prices in auctions');
  const scores = [0, 1, 2].map((i) => bm.score(q, i).s);
  assert.equal(scores.indexOf(Math.max(...scores)), 0);
});

test('dueness is 0..1 and uses daysSinceReview', () => {
  assert.equal(dueness({ daysSinceReview: 14, intervalDays: 7 }), 1);
  assert.equal(dueness({ daysSinceReview: 0, intervalDays: 7 }), 0);
  assert.equal(dueness({}), 1);
});

test('context changes the review: interview context surfaces interview highlights', () => {
  const ctx = contextualReview(library, 'I have an ad auction product-sense interview on Thursday', { n: 5 });
  const tags = ctx.flatMap((r) => r.h.tags);
  assert.ok(tags.includes('interview'));
  assert.ok(tags.includes('auctions') || tags.includes('adtech'));
  const base = baselineReview(library, { n: 5 });
  assert.notDeepEqual(ctx.map((r) => r.h.id), base.map((r) => r.h.id));
});

test('MMR keeps one source from dominating', () => {
  const ctx = contextualReview(library, 'ad auctions bid shading reserve price first-price second-price', { n: 5 });
  const titles = ctx.map((r) => r.h.title);
  const maxSame = Math.max(...titles.map((t) => titles.filter((x) => x === t).length));
  assert.ok(maxSame <= 2, titles.join(' | '));
});

test('Chinese context works', () => {
  const ctx = contextualReview(library, '最近在研究复利和定投', { n: 3 });
  assert.ok(ctx[0].h.tags.includes('investing'));
});

test('API payload follows Readwise limits and conventions', () => {
  const h = toApiHighlight({ text: 'x'.repeat(9000), title: 'T', author: 'Claude', note: 'Q: why', tags: ['ai-chat'], location: 2 });
  assert.equal(h.text.length, 8191);
  assert.equal(h.source_type, SOURCE_TYPE);
  assert.ok(/^[^\s]{3,64}$/.test(h.source_type));
  assert.equal(h.note, 'Q: why\n.ai-chat');
  assert.equal(h.location_type, 'order');
});

test('CSV escapes quotes, commas and newlines', () => {
  const csv = toCSV([{ text: 'a, "b"\nc', title: 'T', author: 'A', note: '', location: 1 }]);
  assert.equal(csv.split('\n')[0], 'Highlight,Title,Author,URL,Note,Location,Date');
  assert.ok(csv.includes('"a, ""b""\nc"'));
});

test('pushHighlights batches and retries on 429', async () => {
  const calls = [];
  let first = true;
  const fetchImpl = async (url, opts) => {
    calls.push(JSON.parse(opts.body).highlights.length);
    if (first) { first = false; return { status: 429, ok: false, headers: { get: () => '0' } }; }
    return { status: 200, ok: true, headers: { get: () => null } };
  };
  const hs = Array.from({ length: 150 }, (_, i) => ({ text: `h${i}`, title: 'T', author: 'A' }));
  const sent = await pushHighlights('tok', hs, { fetchImpl, batchSize: 100 });
  assert.equal(sent, 150);
  assert.deepEqual(calls, [100, 100, 50]);
});

// ---------- ③ What to read next (Readwise Books) ----------
import { recommendBooks, storeDefault, ownedBookIds, explainBook, displayTerms } from '../docs/lib/books.js';
const catalog = JSON.parse(readFileSync(new URL('../docs/data/sample_books.json', import.meta.url)));

test('books: already-read books are skipped, same-name articles are not', () => {
  const owned = ownedBookIds(library, catalog);
  const title = (id) => catalog.find((b) => b.id === id).title;
  assert.ok([...owned].map(title).includes('The Art of War'), 'Art of War is in the library');
  assert.ok(![...owned].map(title).includes('Working Backwards'), 'an article titled "Working backwards" is not the book');
  const { picks } = recommendBooks(library, catalog, 'strategy know the enemy');
  assert.ok(!picks.some((p) => p.b.title === 'The Art of War'));
});

test('books: this week\'s context changes the shelf (English and Chinese)', () => {
  const interview = recommendBooks(library, catalog, 'Preparing for a product-sense interview on ad auctions this Thursday').picks.map((p) => p.b.title);
  assert.ok(interview.slice(0, 2).includes('Cracking the PM Interview'));
  assert.ok(interview.slice(0, 2).includes('Auction Theory'));
  const zh = recommendBooks(library, catalog, '最近在研究复利和定投').picks.slice(0, 2).map((p) => p.b.topics);
  assert.ok(zh.every((t) => t.includes('investing')), JSON.stringify(zh));
  assert.notDeepEqual(interview, storeDefault(catalog).map((x) => x.b.title));
});

test('books: every pick is explained, and AI-chat learning shows up as a gap', () => {
  const { picks } = recommendBooks(library, catalog, 'ad auctions');
  for (const p of picks) assert.ok(explainBook(p).length >= 1);
  const auction = picks.find((p) => p.b.title === 'Auction Theory');
  assert.ok(auction.support.every((x) => x.h.tags.includes('ai-chat')), 'evidence comes from Claude chats');
  assert.ok(explainBook(auction).some((r) => r.kind === 'gap'));
  assert.ok(explainBook(auction).some((r) => r.kind === 'taste' && r.text.includes('second-price')));
});

test('books: MMR keeps one topic from taking over the shelf', () => {
  const { picks } = recommendBooks(library, catalog, 'investing compounding index funds fees money', { lambda: 0.6 });
  const investing = picks.filter((p) => p.b.topics.includes('investing')).length;
  assert.ok(investing <= 3, picks.map((p) => p.b.title).join(' | '));
});

test('books: reasons show the reader\'s words, not stems', () => {
  assert.deepEqual(displayTerms('Preparing for interviews', ['prepar', 'interview']), ['preparing', 'interviews']);
  assert.deepEqual(displayTerms('最近在研究复利和定投', ['复利']), ['复利']);
});
