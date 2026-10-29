#!/usr/bin/env node
// Usage:
//   node cli/learning-loop.mjs conversations.json                 # preview highlights
//   node cli/learning-loop.mjs conversations.json --csv out.csv   # Readwise CSV import file
//   READWISE_TOKEN=xxx node cli/learning-loop.mjs conversations.json --push
//
// Works with Claude or ChatGPT "conversations.json" exports, or a plain-text transcript.

import { readFileSync, writeFileSync } from 'node:fs';
import { detectAndParse, extractHighlights } from '../docs/lib/extract.js';
import { toCSV, checkToken, pushHighlights } from '../docs/lib/readwise.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

if (!file) {
  console.error('Usage: node cli/learning-loop.mjs <conversations.json|transcript.txt> [--csv out.csv] [--push] [--per 4]');
  process.exit(1);
}

const convos = detectAndParse(readFileSync(file, 'utf8'));
const highlights = extractHighlights(convos, { perConversation: Number(opt('per') || 4) });
console.log(`${convos.length} conversations → ${highlights.length} highlights\n`);
for (const h of highlights) console.log(`• ${h.text}\n    ${h.author} · ${h.title}${h.note ? `\n    ${h.note}` : ''}\n`);

const csvPath = opt('csv');
if (csvPath) {
  writeFileSync(csvPath, toCSV(highlights));
  console.log(`Wrote ${csvPath} — import it at https://readwise.io/import_bulk`);
}

if (flag('push')) {
  const token = process.env.READWISE_TOKEN;
  if (!token) { console.error('Set READWISE_TOKEN (get it at https://readwise.io/access_token)'); process.exit(1); }
  if (!(await checkToken(token))) { console.error('Readwise rejected the token.'); process.exit(1); }
  const n = await pushHighlights(token, highlights);
  console.log(`Sent ${n} highlights to Readwise.`);
}
