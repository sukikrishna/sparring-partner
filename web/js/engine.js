// One interface over the two ways answers are produced:
//  - demo: hand-written script for the bundled scenario, plus passage search
//  - live: the Python backend calling Claude
// Every function returns plain objects in the same shape for both modes.

import { api } from './api.js';
import { Index, excerpt } from './search.js';
import { state } from './store.js';
import { normalize, similarity, sleep } from './util.js';

let caseIndex = null;
let caseIndexKey = null;

function index() {
  const key = `${state.caseId}:${state.roleId}`;
  if (caseIndexKey !== key) {
    caseIndex = new Index(state.caseData.documents);
    caseIndexKey = key;
  }
  return caseIndex;
}

const isLive = () => state.mode === 'live';

const base = () => ({ case_id: state.caseId, role_id: state.roleId });

const toHistory = (msgs) =>
  msgs.filter((m) => !m.pending && !m.error && m.text).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));

// Pretend latency in demo mode so the interaction reads like a real exchange.
const thinking = () => sleep(450 + Math.random() * 350);

function matchScripted(entries, question) {
  const q = question.toLowerCase();
  const exact = entries.find((e) => e.q.toLowerCase() === q);
  if (exact) return exact;
  let best = null, bestScore = 0;
  for (const e of entries) {
    const score = e.keys.reduce((n, k) => n + (q.includes(k.toLowerCase()) ? (k.includes(' ') ? 2 : 1) : 0), 0);
    if (score > bestScore) { best = e; bestScore = score; }
  }
  return bestScore >= 2 || (best && bestScore >= 1 && q.split(/\s+/).length <= 6) ? best : null;
}

// ------------------------------------------------------------------ gaps

/** Returns {gaps: [...], message} */
export async function findGaps(notesText) {
  if (isLive()) {
    const gaps = await api.gaps({ ...base(), notes: notesText, max_gaps: 4 });
    return { gaps, message: gaps.length ? '' : 'No load-bearing gaps found in these notes.' };
  }
  await thinking();
  if (!state.demo) {
    return { gaps: [], message: 'Gap finding for this case needs live mode (a configured model). The library and passage search still work.' };
  }
  const text = normalize(notesText);
  const found = state.demo.gaps.filter((g) => text.includes(normalize(g.quote)));
  const message = found.length
    ? (found.length < state.demo.gaps.length ? 'Scripted demo: only gaps whose passages are still in your notes are shown.' : '')
    : 'The scripted demo only recognises the starter notes. Reset the demo, or switch to live mode to analyse your own writing.';
  return { gaps: found, message };
}

// ------------------------------------------------------------------ chats

/** Suggested questions for a document thread (demo script only). */
export function suggestionsForDoc(docId, gapId, askedIds) {
  if (!state.demo || isLive()) return [];
  const entries = (state.demo.doc_qa[docId] || []).filter((e) => !askedIds.has(e.id));
  const scriptGap = gapId && state.gaps.find((g) => g.id === gapId)?.scriptId;
  return entries.sort((a, b) => (b.gaps.includes(scriptGap) ? 1 : 0) - (a.gaps.includes(scriptGap) ? 1 : 0)).slice(0, 3);
}

export function suggestionsForCase(askedIds) {
  if (!state.demo || isLive()) return [];
  return state.demo.case_qa.filter((e) => !askedIds.has(e.id)).slice(0, 4);
}

export async function askDocument({ docId, gap, question, history, notes }) {
  if (isLive()) {
    const r = await api.docChat({
      ...base(),
      doc_id: docId,
      notes,
      gap: gap ? { quote: gap.quote, question: gap.question || '', assumption: gap.assumption || '' } : null,
      history: toHistory(history),
      question,
    });
    return { text: r.answer, cites: r.cited_paragraphs, keyFinding: r.key_finding, followUps: r.follow_ups };
  }
  await thinking();
  const scripted = state.demo && matchScripted(state.demo.doc_qa[docId] || [], question);
  if (scripted) {
    return { text: scripted.answer, cites: scripted.cites, keyFinding: scripted.key_finding, followUps: [], qaId: scripted.id };
  }
  const d = state.docsById[docId];
  const hits = new Index([d]).search(question, 3);
  if (!hits.length) {
    return {
      text: 'This is the scripted demo, so I can only answer the prepared questions, and no paragraph in this document matches your wording. Try a suggested question, or switch to live mode.',
      cites: [], keyFinding: null, followUps: [],
    };
  }
  return {
    text: 'Scripted demo: I can only answer the prepared questions. These paragraphs best match yours:\n' +
      hits.map((h) => `¶${h.paragraph} ${excerpt(h.text)}`).join('\n'),
    cites: hits.map((h) => h.paragraph).sort((a, b) => a - b),
    keyFinding: null, followUps: [], passagesOnly: true,
  };
}

export async function askCase({ question, history, notes }) {
  if (isLive()) {
    const r = await api.caseChat({ ...base(), notes, history: toHistory(history), question });
    return {
      text: r.answer,
      citations: r.citations.map((c) => ({ docId: c.doc_id, paragraph: c.paragraph })),
      keyFinding: r.key_finding,
      followUps: r.follow_ups,
    };
  }
  await thinking();
  const scripted = state.demo && matchScripted(state.demo.case_qa, question);
  if (scripted) {
    return {
      text: scripted.answer,
      citations: scripted.citations.map((c) => ({ docId: c.doc_id, paragraph: c.paragraph })),
      keyFinding: scripted.key_finding, followUps: [], qaId: scripted.id,
    };
  }
  const hits = index().search(question, 4);
  if (!hits.length) {
    return { text: 'No passage in your documents matches those words. Try rephrasing.', citations: [], keyFinding: null, followUps: [] };
  }
  return {
    text: (state.demo ? 'Scripted demo: I can only answer the prepared questions. ' : 'No model is configured. ') +
      'These passages best match yours:\n' +
      hits.map((h) => `${h.title} ¶${h.paragraph}: ${excerpt(h.text, 160)}`).join('\n'),
    citations: hits.map((h) => ({ docId: h.docId, paragraph: h.paragraph })),
    keyFinding: null, followUps: [], passagesOnly: true,
  };
}

// ------------------------------------------------------------ structuring

/** Returns {view, source, message} */
export async function structureNotes(notesText, insights) {
  if (isLive()) {
    const view = await api.structure({
      ...base(),
      notes: notesText,
      insights: insights.map((i) => ({ id: i.id, text: i.text, author: i.author, origin: i.origin?.type || '' })),
    });
    return { view, source: 'live', message: '' };
  }
  await thinking();
  if (!state.demo) return { view: null, source: 'demo', message: 'Structuring needs live mode for this case.' };
  const unchanged = similarity(notesText, state.caseData.role.starter_notes) > 0.97;
  return {
    view: state.demo.structured,
    source: 'demo',
    message: unchanged ? '' : 'Scripted demo: this view was prepared for the starter notes and does not reflect your edits. Live mode restructures whatever you write.',
  };
}

// ------------------------------------------------------------------ recheck

/** Decide whether an edited passage still rests on the gap's assumption. */
export async function recheck(gap, revised, notes) {
  const sim = similarity(gap.quote, revised);
  if (!revised.trim()) return { resolved: true, explanation: 'Passage removed.' };
  if (sim >= 0.97) return { resolved: false, explanation: 'Unchanged.' };
  if (!isLive()) {
    return sim < 0.6
      ? { resolved: true, explanation: 'Rewritten substantially.' }
      : { resolved: false, explanation: 'Only lightly edited. In the scripted demo a passage counts as resolved once it is substantially rewritten.' };
  }
  return api.recheck({
    ...base(),
    gap: { quote: gap.quote, question: gap.question || '', assumption: gap.assumption || '' },
    revised_passage: revised,
    notes,
  });
}
