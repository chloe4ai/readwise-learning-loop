# Learning Loop

**Live demo:** https://chloe4ai.github.io/readwise-learning-loop/

> An independent prototype built on the public Readwise API. It is not an official Readwise product.

Readwise closes the loop on what you *read*. More and more of what people learn now happens in conversations with AI, and none of it comes back for review. This prototype tries three ideas:

1. **Capture:** turn Claude or ChatGPT conversations into highlights worth remembering.
2. **Context-aware review:** make Daily Review aware of what you're working on this week.
3. **What to read next (for Readwise Books):** let your highlights, and what you've been learning in AI chats, pick your next book.

---

## What the demo does

| | Capture | Context-aware review | What to read next (Books) |
|---|---|---|---|
| **Input** | Claude or ChatGPT `conversations.json`, or a pasted transcript | A highlight library plus one line on "what I'm working on" | The same library and one line on this week, plus a book catalog |
| **Core idea** | Score each sentence of each answer. The strongest signal is whether **your next message reacted** ("oh interesting", "didn't know that", "原来如此") | `final = w · relevance + (1 − w) · dueness`, then MMR (Maximal Marginal Relevance) for variety | `final = w₁ · taste + w₂ · this week + w₃ · AI-chat gap`, minus books you already read, then MMR over topics |
| **Output** | Highlights with the question as the note and `.ai-chat` tags → `POST /api/v2/highlights/` or CSV import | Top 5 cards, each explaining *why* it was picked | A 5-book shelf next to a bestseller shelf, each book naming the highlight it came from |
| **Needs a key?** | No. Heuristic mode is instant and explainable. An optional LLM (large language model) mode uses your own Anthropic key | No | No |

Details worth noting:

- **ChatGPT branches.** Only the branch you kept is used, found by walking up from `current_node`. Answers you regenerated and abandoned are ignored.
- **No filler.** Sentences like "Great question!", "Hope this helps" and "It matters most when…" (which depend on earlier context) are dropped.
- **Bilingual.** Chinese text is tokenized with character bigrams, so extraction and ranking both work in Chinese.
- **Closing the loop.** Highlights captured in ① can be added straight into ② and compete in the review, and they feed ③ as well.
- **AI-chat gap.** ③ notices when most of what you know about a topic came from AI conversations rather than a book, and treats a book on that topic as a natural next step.
- **No re-selling.** ③ removes books you already have highlights from. It matches on title or translated title *and* author, so an article named "Working backwards" doesn't hide the book.
- **Tested.** 19 unit tests cover the parsers, extraction, BM25 ranking, MMR, the Books shelf (already-read filter, English and Chinese context, explanations, topic diversity), the API payload limits, CSV escaping, and batching with 429 retry.

```bash
npm test                                                     # run the tests
node cli/learning-loop.mjs conversations.json                # preview highlights
node cli/learning-loop.mjs conversations.json --csv out.csv  # CSV for readwise.io/import_bulk
READWISE_TOKEN=... node cli/learning-loop.mjs conversations.json --push
```

The demo page runs entirely in the browser, and nothing leaves it unless you send it. Browsers may block a direct call to the Readwise API (a CORS, or cross-origin, restriction). In that case the CLI (command-line interface) does the push.

## Limitations

- Extraction uses heuristics. An LLM or a small trained ranker would do better.
- Relevance uses BM25 (a standard keyword-ranking formula). A production version would use hybrid search with embeddings.
- The review library is sample data: public-domain quotes and original sample text.
- The Books catalog has 22 real titles with short descriptions written for the demo. Its "bestseller" order is made up, not sales data.

## Project layout

- `docs/`: the GitHub Pages demo (`index.html`, `app.js`, and `lib/`, shared with the CLI and tests; `lib/books.js` is the Books shelf)
- `cli/`: Node CLI
- `tests/`: `node --test`

MIT licensed.
