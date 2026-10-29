import { detectAndParse, extractHighlights } from './lib/extract.js';
import { baselineReview, contextualReview, explain } from './lib/rank.js';
import { toApiPayload, toCSV, pushHighlights } from './lib/readwise.js';
import { recommendBooks, storeDefault, explainBook, ownedBookIds } from './lib/books.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let highlights = [];
let library = [];
let captured = []; // highlights the reader chose to add to the review demo
let catalog = [];

// ---------- tabs ----------
document.querySelectorAll('[role=tab]').forEach((b) =>
  b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  if (name === 'review') renderReview();
  if (name === 'books') renderBooks();
}

// ---------- capture ----------
$('#load-sample').addEventListener('click', async () => {
  const r = await fetch('data/sample_claude_export.json');
  $('#input').value = JSON.stringify(await r.json(), null, 1);
  $('#parse-status').textContent = 'Sample loaded: 3 Claude conversations (English + 中文).';
});

$('#file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  $('#input').value = await f.text();
  $('#parse-status').textContent = `Loaded ${f.name} (${Math.round(f.size / 1024)} KB).`;
});

document.querySelectorAll('input[name=mode]').forEach((r) =>
  r.addEventListener('change', () => ($('#llm-opts').hidden = mode() !== 'llm')));
const mode = () => document.querySelector('input[name=mode]:checked').value;

$('#extract').addEventListener('click', async () => {
  const btn = $('#extract');
  const status = $('#parse-status');
  const raw = $('#input').value.trim();
  if (!raw) { status.textContent = 'Paste a transcript or load the sample first.'; return; }
  let convos;
  try {
    convos = detectAndParse(raw);
  } catch (err) {
    status.innerHTML = `<span class="err">${esc(err.message)}</span>`;
    return;
  }
  const turns = convos.reduce((s, c) => s + c.turns.length, 0);
  btn.disabled = true;
  try {
    if (mode() === 'llm') {
      status.textContent = `Asking the model about ${convos.length} conversation(s)…`;
      highlights = await llmExtract(convos);
    } else {
      highlights = extractHighlights(convos);
    }
    highlights.forEach((h) => (h.keep = true));
    status.textContent = `Parsed ${convos.length} conversation(s), ${turns} turns → ${highlights.length} highlights.`;
    renderHighlights();
  } catch (err) {
    status.innerHTML = `<span class="err">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

async function llmExtract(convos) {
  const key = $('#anthropic-key').value.trim();
  if (!key) throw new Error('Add an Anthropic API key, or switch to Heuristic mode.');
  const out = [];
  for (const c of convos) {
    const transcript = c.turns.map((t) => `${t.role === 'user' ? 'USER' : 'ASSISTANT'}: ${t.text}`).join('\n\n').slice(0, 60000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: $('#model').value.trim(),
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `From this conversation, pick at most 4 things the USER learned that are worth reviewing in a month.
Each must be a single self-contained sentence (no "this/it" referring back), written in the conversation's language, faithful to what the assistant said.
Return only JSON: [{"text": "...", "question": "the user question it answers", "why": "short reason"}]

${transcript}`,
        }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    const txt = data.content.map((p) => p.text || '').join('');
    const items = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
    items.forEach((it, k) => out.push({
      text: it.text,
      title: c.title,
      author: c.source === 'chatgpt' ? 'ChatGPT' : c.source === 'claude' ? 'Claude' : 'AI conversation',
      note: it.question ? `Q: ${it.question}` : '',
      tags: ['ai-chat', c.source],
      location: k + 1,
      highlighted_at: c.createdAt,
      reasons: [it.why || 'model pick'],
      score: null,
    }));
  }
  return out;
}

function renderHighlights() {
  const box = $('#highlights');
  $('#hl-count').textContent = `${highlights.filter((h) => h.keep).length} / ${highlights.length}`;
  $('#export-actions').hidden = !highlights.length;
  if (!highlights.length) {
    box.className = 'stack empty-state';
    box.textContent = 'No sentences cleared the bar. Try a longer conversation or LLM mode.';
    return;
  }
  box.className = 'stack';
  box.innerHTML = highlights.map((h, i) => `
    <article class="hl ${h.keep ? '' : 'off'}">
      <p class="quote">${esc(h.text)}</p>
      <div class="src">${esc(h.author)} · ${esc(h.title)}</div>
      ${h.note ? `<div class="note">${esc(h.note)}</div>` : ''}
      <div class="meta">
        ${(h.reasons || []).map((r) => `<span class="reason">${esc(r)}</span>`).join('')}
        ${h.score != null ? `<span class="reason">score ${h.score}</span>` : ''}
        <label class="keep"><input type="checkbox" data-i="${i}" ${h.keep ? 'checked' : ''}> keep</label>
      </div>
    </article>`).join('');
  box.querySelectorAll('input[type=checkbox]').forEach((cb) =>
    cb.addEventListener('change', () => { highlights[cb.dataset.i].keep = cb.checked; renderHighlights(); }));
}

const kept = () => highlights.filter((h) => h.keep);

$('#dl-csv').addEventListener('click', () => {
  const blob = new Blob([toCSV(kept())], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'readwise_ai_highlights.csv' });
  a.click();
  URL.revokeObjectURL(a.href);
  note(`Downloaded ${kept().length} highlights. Import at readwise.io/import_bulk → CSV.`, 'ok');
});

$('#copy-json').addEventListener('click', async () => {
  await navigator.clipboard.writeText(JSON.stringify(toApiPayload(kept()), null, 2));
  note('Copied the POST /api/v2/highlights/ payload.', 'ok');
});

$('#send-rw').addEventListener('click', async () => {
  const token = $('#rw-token').value.trim();
  if (!token) return note('Paste your Readwise access token first.', 'err');
  try {
    const n = await pushHighlights(token, kept());
    note(`Sent ${n} highlights to Readwise. They'll show up in your library under "learning_loop".`, 'ok');
  } catch (err) {
    note(err instanceof TypeError
      ? 'Your browser blocked the direct call (CORS). Use the CLI: node cli/learning-loop.mjs export.json --push'
      : err.message, 'err');
  }
});

$('#to-review').addEventListener('click', () => {
  captured = kept().map((h, i) => ({ ...h, id: `new${i}`, daysSinceReview: undefined, intervalDays: 3 }));
  showTab('review');
});

function note(msg, cls) {
  $('#export-status').innerHTML = `<span class="${cls}">${esc(msg)}</span>`;
}

// ---------- review ----------
async function loadLibrary() {
  if (!library.length) library = await (await fetch('data/sample_library.json')).json();
}

function card(item, showContext) {
  const h = item.h;
  const onTopic = item.rel > 0.15;
  return `
    <article class="hl">
      <p class="quote">${esc(h.text)}</p>
      <div class="src">${esc(h.author)} · ${esc(h.title)} ${showContext && onTopic ? '<span class="ontopic">· on topic</span>' : ''}</div>
      <div class="bars">
        <span>relevance</span><div class="bar rel"><span style="width:${Math.round(item.rel * 100)}%"></span></div><span>${item.rel.toFixed(2)}</span>
        <span>due-ness</span><div class="bar due"><span style="width:${Math.round(item.due * 100)}%"></span></div><span>${item.due.toFixed(2)}</span>
      </div>
      ${showContext ? `<div class="why">${esc(explain(item))}</div>` : ''}
    </article>`;
}

async function renderReview() {
  await loadLibrary();
  const lib = [...captured, ...library];
  const context = $('#context').value;
  const wRel = Number($('#w-rel').value);
  const lambda = Number($('#lambda').value);
  $('#w-rel-out').textContent = wRel.toFixed(2);
  $('#lambda-out').textContent = lambda.toFixed(2);
  $('#lib-note').textContent = `Sample library: ${lib.length} highlights${captured.length ? ` (including ${captured.length} you just captured)` : ''}. Relevance is shown on both sides so you can see what the baseline ignores.`;

  const ctx = contextualReview(lib, context, { n: 5, wRel, wDue: 1 - wRel, lambda });
  // Score the baseline picks for relevance too, purely for display.
  const relById = new Map(contextualReview(lib, context, { n: lib.length, wRel: 1, wDue: 0, lambda: 1 }).map((r) => [r.h, r.rel]));
  const base = baselineReview(lib, { n: 5 }).map((b) => ({ ...b, rel: relById.get(b.h) || 0 }));

  $('#base-list').innerHTML = base.map((b) => card(b, false)).join('');
  $('#ctx-list').innerHTML = ctx.map((c) => card(c, true)).join('');
  const hits = (xs) => xs.filter((x) => x.rel > 0.15).length;
  $('#base-hit').textContent = `${hits(base)} / 5 on topic`;
  $('#ctx-hit').textContent = `${hits(ctx)} / 5 on topic`;
}

let t;
$('#context').addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderReview, 150); });
['#w-rel', '#lambda'].forEach((s) => $(s).addEventListener('input', renderReview));
$('#presets').addEventListener('click', (e) => {
  if (e.target.classList.contains('chip')) { $('#context').value = e.target.textContent; renderReview(); }
});

// ---------- books ----------
async function loadCatalog() {
  if (!catalog.length) catalog = await (await fetch('data/sample_books.json')).json();
}

const pct = (x) => Math.round(Math.max(0, Math.min(1, x)) * 100);

function storeCard(b, owned) {
  return `
    <article class="hl book ${owned ? 'off' : ''}">
      <p class="book-title">${esc(b.title)}</p>
      <div class="src">${esc(b.author)}</div>
      <p class="blurb">${esc(b.blurb)}</p>
      ${owned ? '<div class="note">You already have highlights from this book.</div>' : ''}
    </article>`;
}

function bookCard(item) {
  const b = item.b;
  const reasons = explainBook(item);
  return `
    <article class="hl book">
      <p class="book-title">${esc(b.title)}</p>
      <div class="src">${esc(b.author)}</div>
      <p class="blurb">${esc(b.blurb)}</p>
      <ul class="reasons">${reasons.map((r) => `<li class="r-${r.kind}">${esc(r.text)}</li>`).join('')}</ul>
      <div class="bars">
        <span>taste</span><div class="bar rel"><span style="width:${pct(item.taste)}%"></span></div><span>${item.taste.toFixed(2)}</span>
        <span>this week</span><div class="bar due"><span style="width:${pct(item.intent)}%"></span></div><span>${item.intent.toFixed(2)}</span>
        <span>AI-chat gap</span><div class="bar gap"><span style="width:${pct(item.gap)}%"></span></div><span>${item.gap.toFixed(2)}</span>
      </div>
    </article>`;
}

async function renderBooks() {
  await Promise.all([loadLibrary(), loadCatalog()]);
  const lib = [...captured, ...library];
  const context = $('#book-context').value;
  const wIntent = Number($('#w-intent').value);
  const lambda = Number($('#book-lambda').value);
  $('#w-intent-out').textContent = wIntent.toFixed(2);
  $('#book-lambda-out').textContent = lambda.toFixed(2);

  const wGap = 0.15;
  const { picks, skippedOwned } = recommendBooks(lib, catalog, context, {
    n: 5, wIntent: (1 - wGap) * wIntent, wTaste: (1 - wGap) * (1 - wIntent), wGap, lambda,
  });
  const owned = ownedBookIds(lib, catalog);
  const store = storeDefault(catalog, { n: 5 });

  $('#store-list').innerHTML = store.map(({ b }) => storeCard(b, owned.has(b.id))).join('');
  $('#foryou-list').innerHTML = picks.map(bookCard).join('');
  const linked = picks.filter((p) => p.support.length && p.support[0].s >= 0.2).length;
  const ownedInStore = store.filter(({ b }) => owned.has(b.id)).length;
  $('#store-hit').textContent = ownedInStore ? `${ownedInStore} already read · not personal` : 'same for everyone';
  $('#foryou-hit').textContent = `${linked} / 5 tied to your highlights`;
  const fromAI = lib.filter((h) => (h.tags || []).includes('ai-chat')).length;
  $('#book-note').textContent = `Signals: ${lib.length} highlights (${fromAI} from AI chats${captured.length ? `, including ${captured.length} you just captured in ①` : ''}) against a ${catalog.length}-book sample catalog.`
    + (skippedOwned.length ? ` Skipped because you already read it: ${skippedOwned.map((b) => b.title).join(', ')}.` : '');
}

let tb;
$('#book-context').addEventListener('input', () => { clearTimeout(tb); tb = setTimeout(renderBooks, 150); });
['#w-intent', '#book-lambda'].forEach((s) => $(s).addEventListener('input', renderBooks));
$('#book-presets').addEventListener('click', (e) => {
  if (e.target.classList.contains('chip')) { $('#book-context').value = e.target.textContent; renderBooks(); }
});
