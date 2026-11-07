import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tokenize, stripMarkdown, jaccard } from '../docs/lib/text.js';
import { detectAndParse, parseChatGPTExport, parseTranscript, extractHighlights, isAha, splitSentences } from '../docs/lib/extract.js';
import { BM25, dueness, contextualReview, baselineReview } from '../docs/lib/rank.js';
import { toApiHighlight, toCSV, pushHighlights, retryAfterMs, SOURCE_TYPE } from '../docs/lib/readwise.js';

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

// ---------- Regressions ----------

test('large libraries do not overflow the call stack', () => {
  const big = Array.from({ length: 8000 }, (_, i) => ({ text: `auction bid ${i}`, title: `h${i}`, author: 'x' }));
  assert.equal(recommendBooks(big, catalog, 'auction').picks.length, 5);
  const huge = Array.from({ length: 150000 }, (_, i) => ({ text: `w${i % 50}`, title: `t${i}`, daysSinceReview: 1 }));
  assert.equal(contextualReview(huge, 'w1', { n: 1 }).length, 1);
});

test('"you reacted" fires on aha replies, not on confusion or pushback', () => {
  for (const r of ['Oh interesting!', "I didn't know that", '原来如此', '原来是这样', '原来复利这么厉害啊', 'TIL about bid shading',
    'ok that makes sense now', 'got it, thanks', '懂了', '学到了'])
    assert.ok(isAha(r), r);
  for (const r of ['我不明白', '原来的方案更好', 'Oh no, that is wrong.', 'it no longer makes sense', 'I see no reason',
    "That doesn't make sense", "I don't understand", "I'm confused", '没懂', '这不对', 'until tomorrow', 'ohm law'])
    assert.ok(!isAha(r), r);
  const convo = (reply) => [{ id: 1, title: 't', source: 'claude', turns: [
    { role: 'user', text: '什么是复利？' },
    { role: 'assistant', text: '复利是指利息也会继续产生利息，时间越长效果越明显。' },
    { role: 'user', text: reply }] }];
  const reacted = (reply) => extractHighlights(convo(reply), { minScore: -99 })[0].reasons.includes('you reacted to it');
  assert.ok(reacted('原来如此！'));
  assert.ok(!reacted('我不明白'));
});

const gptMsg = (role, parts, extra = {}) => ({ author: { role }, content: { content_type: 'text', parts }, ...extra });

test('ChatGPT without a usable current_node follows the newest leaf', () => {
  const mapping = {
    r: { parent: null, children: ['u'] },
    u: { parent: 'r', children: ['old', 'new'], message: gptMsg('user', ['q?'], { create_time: 1 }) },
    old: { parent: 'u', children: [], message: gptMsg('assistant', ['ABANDONED'], { create_time: 2 }) },
    new: { parent: 'u', children: [], message: gptMsg('assistant', ['REGENERATED'], { create_time: 3 }) },
  };
  assert.deepEqual(parseChatGPTExport([{ title: 't', mapping }])[0].turns.map((t) => t.text), ['q?', 'REGENERATED']);
  assert.deepEqual(parseChatGPTExport([{ title: 't', current_node: 'gone', mapping }])[0].turns.map((t) => t.text), ['q?', 'REGENERATED']);
});

test('ChatGPT reads voice transcriptions and skips tool-addressed messages', () => {
  const voice = (t) => ({ content_type: 'audio_transcription', text: t });
  const [c] = parseChatGPTExport([{ title: 't', current_node: 'b', mapping: {
    u: { parent: null, children: ['a'], message: { author: { role: 'user' }, content: { content_type: 'multimodal_text', parts: [voice('why is the sky blue?')] } } },
    a: { parent: 'u', children: ['b'], message: gptMsg('assistant', ['User asked about sky.'], { recipient: 'bio' }) },
    b: { parent: 'a', children: [], message: { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'multimodal_text', parts: [voice('Rayleigh scattering.')] } } },
  } }]);
  assert.deepEqual(c.turns.map((t) => [t.role, t.text]), [['user', 'why is the sky blue?'], ['assistant', 'Rayleigh scattering.']]);
});

test('tokenize keeps neighbours of stop characters and normalizes width and accents', () => {
  assert.ok(tokenize('我的书').includes('书'));
  assert.deepEqual(tokenize('很好'), ['好']);
  assert.deepEqual(tokenize('ＡＩ产品'), ['产品', 'ai']);
  assert.deepEqual(tokenize('café naïve'), ['cafe', 'naive']);
  assert.deepEqual(tokenize('𠀀𠀁'), ['𠀀𠀁']);
  assert.deepEqual(tokenize('日本語のテキスト'), ['日本', '本語', 'テキ', 'キス', 'スト']);
});

test('sentence splitting respects abbreviations, CJK punctuation and closing quotes', () => {
  assert.deepEqual(splitSentences('Dr. Smith showed that auctions are truthful. U.S. rules differ, e.g. Fed rules. Mrs. Lee agreed.'),
    ['Dr. Smith showed that auctions are truthful.', 'U.S. rules differ, e.g. Fed rules.', 'Mrs. Lee agreed.']);
  assert.deepEqual(splitSentences('使用 React Server Components 时 hydration mismatch 很常见。另外 useEffect hook 不会在 server 运行。'),
    ['使用 React Server Components 时 hydration mismatch 很常见。', '另外 useEffect hook 不会在 server 运行。']);
  assert.deepEqual(splitSentences('他说：“复利是世界第八大奇迹。”然后他解释了原因。'), ['他说：“复利是世界第八大奇迹。”', '然后他解释了原因。']);
  assert.deepEqual(splitSentences('复利为什么重要?因为时间会放大收益!所以越早越好。'), ['复利为什么重要?', '因为时间会放大收益!', '所以越早越好。']);
  // "No." abbreviates only before a number.
  assert.deepEqual(splitSentences('See No. 5 for details. The short answer is no. Index funds win.'),
    ['See No. 5 for details.', 'The short answer is no.', 'Index funds win.']);
});

test('MMR does not treat untitled highlights as one source', () => {
  const mk = (t) => [{ text: 'auction bidding', title: t[0], daysSinceReview: 5 }, { text: 'auction reserve price', title: t[1], daysSinceReview: 5 }];
  const untitled = contextualReview(mk([undefined, undefined]), 'auction', { n: 2 })[1].mmr;
  const distinct = contextualReview(mk(['A', 'B']), 'auction', { n: 2 })[1].mmr;
  assert.equal(untitled, distinct);
});

test('weights are clamped and a bad lastReviewed means never reviewed', () => {
  assert.equal(dueness({ lastReviewed: 'not a date' }), 1);
  const r = contextualReview([{ text: 'zebra', title: 'a', lastReviewed: 'bad' }, { text: 'auction auction', title: 'b', daysSinceReview: 7 }], 'auction', { n: 2 });
  assert.ok(r.every((x) => Number.isFinite(x.final)));
  // wDue = -0.5 must not reward recently reviewed highlights
  const lib = [{ text: 'x', title: 'a', daysSinceReview: 0 }, { text: 'y', title: 'b', daysSinceReview: 30 }];
  const neg = contextualReview(lib, '', { n: 2, wRel: 1.5, wDue: -0.5 });
  assert.ok(neg.every((x) => x.final >= 0 && x.final <= 1), JSON.stringify(neg.map((x) => x.final)));
  // lambda = 1.5 must not reward similarity
  const sim = [{ text: 'auction bid', title: 'A' }, { text: 'auction bid shading', title: 'A' }, { text: 'auction reserve', title: 'B' }];
  assert.ok(contextualReview(sim, 'auction', { n: 2, lambda: 1.5 }).some((x) => x.h.title === 'B'));
  assert.ok(recommendBooks(library, catalog, 'ad auctions', { wTaste: NaN, lambda: -3 }).picks.every((p) => Number.isFinite(p.final)));
});

test('books: ownership needs a real title match', () => {
  const pom = [{ id: 'pom', title: 'The Psychology of Money', author: 'Morgan Housel' }];
  const own = (title) => ownedBookIds([{ text: 'q', title, author: 'Morgan Housel' }], pom).has('pom');
  assert.ok(!own(''), 'empty title matches nothing');
  assert.ok(!own('Money'), 'a short article title is not the book');
  assert.ok(own('The Psychology of Money'));
  assert.ok(own('The Psychology of Money: Timeless lessons on wealth'));
  assert.ok(!own('Psychology of Moneyball'));
});

test('pushHighlights reads HTTP-date Retry-After, backs off, and gives up', async () => {
  const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
  assert.equal(retryAfterMs('Wed, 21 Oct 2026 07:28:30 GMT', now), 30000);
  assert.equal(retryAfterMs('Wed, 21 Oct 2026 07:27:00 GMT', now), 0);
  assert.equal(retryAfterMs('12', now), 12000);
  assert.equal(retryAfterMs('garbage', now), null);
  let calls = 0;
  const waits = [];
  const fetchImpl = async () => { calls++; return { status: 429, ok: false, headers: { get: () => 'Wed, 21 Oct 2015 07:28:00 GMT' } }; };
  await assert.rejects(
    pushHighlights('tok', [{ text: 'a', title: 'b' }], { fetchImpl, wait: async (ms) => { waits.push(ms); } }),
    /gave up after 5 retries/);
  assert.equal(calls, 6);
  assert.ok(waits.every((ms) => ms >= 1000), JSON.stringify(waits));
});

test('parsing edge cases: empty export, null entries, unknown JSON, attachment-only questions', () => {
  assert.deepEqual(detectAndParse([]), []);
  assert.deepEqual(detectAndParse('[]'), []);
  assert.equal(detectAndParse([null, { name: 'c', chat_messages: [{ sender: 'human', text: 'hi' }] }]).length, 1);
  assert.equal(parseChatGPTExport([null, { title: 't', mapping: {} }]).length, 1);
  assert.throws(() => detectAndParse('{"foo":"bar baz"}'), /Unrecognized format/);
  assert.equal(detectAndParse('[10:00] User: hi')[0].source, 'transcript');
  const [c] = detectAndParse([{ name: 'c', chat_messages: [
    { sender: 'human', text: 'What is bid shading in first-price auctions?' },
    { sender: 'assistant', text: 'Bid shading means bidding below your true value because you pay what you bid in a first-price auction.' },
    { sender: 'human', text: '', attachments: [{ file_name: 'report.pdf', extracted_content: 'doc' }] },
    { sender: 'assistant', text: 'The key finding of the report is that reserve prices raise revenue when bidders are few and values are spread out.' },
  ] }]);
  assert.deepEqual(c.turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
  const hs = extractHighlights([c], { minScore: -99 });
  const reserve = hs.find((h) => h.text.includes('reserve prices'));
  assert.equal(reserve.note, 'Q: [Attachment: report.pdf]');
});

test('CSV neutralizes formula-looking cells', () => {
  const csv = toCSV([{ text: '=HYPERLINK("http://evil","x")', title: '+cmd', author: '@me', note: '-1+2', location: 1 }]);
  const row = csv.split('\n')[1];
  assert.ok(row.startsWith(`"'=HYPERLINK(""http://evil"",""x"")"`), row);
  assert.ok(row.includes(",'+cmd,'@me,,'-1+2,1,"), row);
});
