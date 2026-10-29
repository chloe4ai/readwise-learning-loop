// Turn AI conversation exports into Readwise-ready highlights.
//
// Two stages:
//   1. parse*()  — normalize Claude / ChatGPT exports or a pasted transcript
//                  into { id, title, createdAt, source, turns: [{ role, text, at }] }
//   2. extractHighlights() — pick the few sentences worth remembering,
//                  using transparent heuristics (no API key needed).
//                  An LLM mode lives in the demo page (bring-your-own-key).

import { tokenize, jaccard, stripMarkdown, isCJKHeavy } from './text.js';

// ---------- 1. Parsing ----------

export function parseClaudeExport(data) {
  const convos = Array.isArray(data) ? data : [data];
  return convos
    .filter((c) => Array.isArray(c.chat_messages))
    .map((c) => ({
      id: c.uuid || c.name,
      title: c.name || 'Untitled Claude chat',
      createdAt: c.created_at || null,
      source: 'claude',
      turns: c.chat_messages
        .map((m) => ({
          role: m.sender === 'human' ? 'user' : 'assistant',
          text: messageText(m),
          at: m.created_at || c.created_at || null,
        }))
        .filter((t) => t.text.trim()),
    }));
}

function messageText(m) {
  if (typeof m.text === 'string' && m.text.trim()) return m.text;
  if (Array.isArray(m.content)) {
    return m.content.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n\n');
  }
  return '';
}

export function parseChatGPTExport(data) {
  const convos = Array.isArray(data) ? data : [data];
  return convos
    .filter((c) => c && c.mapping)
    .map((c) => {
      // Walk from the current leaf up to the root: this is the branch the user actually kept.
      const path = [];
      let node = c.current_node || lastNodeId(c.mapping);
      const seen = new Set();
      while (node && c.mapping[node] && !seen.has(node)) {
        seen.add(node);
        path.push(c.mapping[node]);
        node = c.mapping[node].parent;
      }
      path.reverse();
      const turns = path
        .map((n) => n.message)
        .filter((m) => m && m.author && (m.author.role === 'user' || m.author.role === 'assistant'))
        .map((m) => ({
          role: m.author.role,
          text: ((m.content && m.content.parts) || []).filter((p) => typeof p === 'string').join('\n\n'),
          at: m.create_time ? new Date(m.create_time * 1000).toISOString() : null,
        }))
        .filter((t) => t.text.trim());
      return {
        id: c.id || c.conversation_id || c.title,
        title: c.title || 'Untitled ChatGPT chat',
        createdAt: c.create_time ? new Date(c.create_time * 1000).toISOString() : null,
        source: 'chatgpt',
        turns,
      };
    });
}

function lastNodeId(mapping) {
  const ids = Object.keys(mapping);
  return ids.find((id) => !(mapping[id].children || []).length) || ids[ids.length - 1];
}

const USER_PREFIX = /^\s*(user|human|you|me|我|问)\s*[:：]\s*/i;
const AI_PREFIX = /^\s*(assistant|claude|chatgpt|gpt|ai|答)\s*[:：]\s*/i;

export function parseTranscript(text, title = 'Pasted conversation') {
  const turns = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (USER_PREFIX.test(line)) {
      cur = { role: 'user', text: line.replace(USER_PREFIX, ''), at: null };
      turns.push(cur);
    } else if (AI_PREFIX.test(line)) {
      cur = { role: 'assistant', text: line.replace(AI_PREFIX, ''), at: null };
      turns.push(cur);
    } else if (cur) {
      cur.text += '\n' + line;
    } else if (line.trim()) {
      // No prefixes at all: treat the whole paste as one assistant answer.
      cur = { role: 'assistant', text: line, at: null };
      turns.push(cur);
    }
  }
  return [{ id: 'paste', title, createdAt: null, source: 'transcript', turns: turns.filter((t) => t.text.trim()) }];
}

export function detectAndParse(input, title) {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        return detectAndParse(JSON.parse(trimmed), title);
      } catch {
        /* fall through to transcript */
      }
    }
    return parseTranscript(input, title);
  }
  const sample = Array.isArray(input) ? input[0] : input;
  if (sample && sample.chat_messages) return parseClaudeExport(input);
  if (sample && sample.mapping) return parseChatGPTExport(input);
  throw new Error('Unrecognized format: expected a Claude or ChatGPT conversations.json, or a transcript.');
}

// ---------- 2. Extraction ----------

const SIGNALS = [
  { key: 'definition', w: 1.0, re: /^[^,;:]{2,60}?\b(is|are|means|refers to|is called|stands for|is defined as)\b|是指|指的是|意思是|叫做|本质是/i },
  { key: 'contrast', w: 1.0, re: /\b(not .{1,40} but|instead of|rather than|unlike|whereas|the difference)\b|不是.{1,20}而是|而不是|区别|相反/i },
  { key: 'rule', w: 1.0, re: /\b(always|never|rule of thumb|the key|the trick|the catch|avoid|matters because|the reason)\b|关键|一定要|千万|不要|原因是|之所以/i },
  { key: 'causal', w: 0.6, re: /\b(because|so that|which means|therefore|as a result)\b|因为|所以|因此|导致/i },
  { key: 'number', w: 0.3, re: /\d/ },
];

const FILLER = /^(great question|good question|sure|certainly|absolutely|of course|here('s| is| are)|let me|i can|i'd|i would|happy to|hope this|in summary|to summarize|overall|好的|当然|希望|总结一下)/i;
const LEARNED = /\b(got it|makes sense|interesting|i see|til|didn'?t know|never knew|aha|oh)\b|明白|懂了|原来|学到|有意思|没想到/i;
const ASKED = /\?|？|\b(what|why|how|explain|difference|when should)\b|什么|为什么|怎么|区别|是不是/i;

function splitUnits(text) {
  const noCode = text.replace(/```[\s\S]*?```/g, ' ');
  const units = [];
  for (const rawLine of noCode.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^\|/.test(line)) continue; // skip headings & tables
    const isBullet = /^([-*+•]|\d+[.)])\s+/.test(line);
    const hadBold = /\*\*[^*]+\*\*/.test(line);
    if (isBullet) {
      units.push({ raw: line, hadBold, bullet: true });
      continue;
    }
    const parts = isCJKHeavy(line)
      ? line.split(/(?<=[。！？])/)
      : line.split(/(?<=[.!?])\s+(?=["“(\[A-Z0-9])/);
    for (const p of parts) if (p.trim()) units.push({ raw: p.trim(), hadBold: /\*\*[^*]+\*\*/.test(p), bullet: false });
  }
  return units;
}

export function scoreUnit(unit, ctx) {
  const text = stripMarkdown(unit.raw);
  const cjk = isCJKHeavy(text);
  const len = text.length;
  const [minLen, maxLen] = cjk ? [12, 160] : [45, 320];
  const reasons = [];
  if (len < minLen || len > maxLen) return { text, score: -Infinity, reasons: ['length'] };
  if (FILLER.test(text) || /[:：]$/.test(text) || /^https?:\/\//.test(text)) return { text, score: -Infinity, reasons: ['filler'] };

  let score = 0;
  for (const s of SIGNALS) {
    if (s.re.test(text)) {
      score += s.w;
      reasons.push(s.key);
    }
  }
  if (unit.hadBold) { score += 0.8; reasons.push('emphasized'); }
  if (ctx.answersQuestion && ctx.position < 3) { score += 0.9; reasons.push('answers your question'); }
  if (ctx.followedByAha) { score += 1.1; reasons.push('you reacted to it'); }
  if (ctx.position === 0) score += 0.2; // first sentence of an answer is usually the thesis
  // Prefer mid-length, self-contained sentences.
  const ideal = cjk ? 60 : 160;
  score -= Math.abs(len - ideal) / (ideal * 4);
  if (/^(this|that|it|these|those|they)\b|^(这|那|它)/i.test(text)) { score -= 1.2; reasons.push('needs context'); }
  return { text, score, reasons };
}

export function extractHighlights(conversations, { perConversation = 4, perTurn = 2, minScore = 1.0 } = {}) {
  const out = [];
  for (const convo of conversations) {
    const cands = [];
    convo.turns.forEach((turn, i) => {
      if (turn.role !== 'assistant') return;
      const prevUser = [...convo.turns.slice(0, i)].reverse().find((t) => t.role === 'user');
      const nextUser = convo.turns.slice(i + 1).find((t) => t.role === 'user');
      const answersQuestion = !!(prevUser && ASKED.test(prevUser.text));
      const followedByAha = !!(nextUser && LEARNED.test(nextUser.text.slice(0, 200)));
      splitUnits(turn.text).forEach((unit, position) => {
        const s = scoreUnit(unit, { answersQuestion, followedByAha, position });
        if (s.score >= minScore) {
          cands.push({ ...s, turnIndex: i, at: turn.at, question: prevUser ? oneLine(prevUser.text, 140) : null });
        }
      });
    });
    // Greedy pick with near-duplicate suppression.
    cands.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const c of cands) {
      const toks = new Set(tokenize(c.text));
      if (picked.some((p) => jaccard(p._toks, toks) > 0.45)) continue;
      if (picked.filter((p) => p.turnIndex === c.turnIndex).length >= perTurn) continue; // spread across answers
      picked.push({ ...c, _toks: toks });
      if (picked.length >= perConversation) break;
    }
    picked.sort((a, b) => a.turnIndex - b.turnIndex);
    picked.forEach((p, k) => {
      out.push({
        text: p.text,
        title: convo.title,
        author: convo.source === 'chatgpt' ? 'ChatGPT' : convo.source === 'claude' ? 'Claude' : 'AI conversation',
        note: p.question ? `Q: ${p.question}` : '',
        tags: ['ai-chat', convo.source],
        location: k + 1,
        highlighted_at: p.at || convo.createdAt || null,
        score: Math.round(p.score * 100) / 100,
        reasons: p.reasons,
        conversationId: convo.id,
      });
    });
  }
  return out;
}

function oneLine(s, n) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
