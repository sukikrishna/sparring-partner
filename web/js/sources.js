// Source Documents column: the gap list, the full document library, one
// "rabbit-hole" chat per document (separate history per gap/document), and a
// case-wide chat for general questions that are not tied to a gap.

import * as engine from './engine.js';
import { dismissGap, readNotes, reopenGap, scrollToGap } from './editor.js';
import {
  addInsight, changed, doc, gapById, log, openGaps, state, thread, threadKey,
} from './store.js';
import { $, $$, button, el, flash, plural, uid } from './util.js';

let selectGap = () => {};

export function initSources(opts) {
  selectGap = opts.selectGap;
}

// ===================================================================== tabs

export function renderSources() {
  renderTabs();
  const body = $('#src-body');
  const scrollers = Object.fromEntries($$('[data-scroll-key]', body).map((n) => [n.dataset.scrollKey, n.scrollTop]));
  body.textContent = '';
  if (state.rightTab === 'library') body.append(renderLibrary());
  else if (state.rightTab === 'ask') body.append(renderCaseChat());
  else body.append(renderGapsTab());
  for (const n of $$('[data-scroll-key]', body)) {
    if (n.dataset.scrollKey in scrollers) n.scrollTop = scrollers[n.dataset.scrollKey];
  }
  for (const msgs of $$('.msgs', body)) msgs.scrollTop = msgs.scrollHeight;
}

function renderTabs() {
  const tabs = $('#src-tabs');
  tabs.textContent = '';
  const open = openGaps().length;
  const defs = [
    ['gaps', 'Gaps', state.gapsChecked ? String(open) : ''],
    ['library', 'Library', String(state.caseData.documents.length)],
    ['ask', 'Ask all documents', ''],
  ];
  for (const [id, label, count] of defs) {
    tabs.append(el('button', {
      type: 'button',
      className: 'tab-btn',
      attrs: { role: 'tab', 'aria-selected': String(state.rightTab === id) },
      onClick: () => { state.rightTab = id; log('tab', { column: 'sources', tab: id }); changed('right'); },
    }, label, count ? el('span', { className: 'count' }, count) : null));
  }
}

// ===================================================================== gaps

function renderGapsTab() {
  const gap = state.selectedGapId && gapById(state.selectedGapId);
  if (gap) return renderGapDetail(gap);

  const wrap = el('div', { className: 'intro', dataset: { scrollKey: 'gaps' } });
  if (!state.gapsChecked) {
    wrap.append(
      el('h3', { text: 'Write first, then check' }),
      el('p', { text: 'Your notes in the Human-Only column can be as rough as you like. When you are ready, press “Find gaps”: passages that rest on a questionable assumption get highlighted, each linked to the documents that bear on it.' }),
      el('p', { text: 'You can also browse the Library or ask a question across all documents at any time. Anything useful you find can be saved to the AI-Synthesis board.' }),
    );
    return wrap;
  }
  const open = state.gaps.filter((g) => g.status === 'open');
  const closed = state.gaps.filter((g) => g.status !== 'open');
  wrap.append(
    el('h3', { text: open.length ? 'Pick a gap to work on' : 'No open gaps' }),
    el('p', {
      text: open.length
        ? 'Click a highlighted passage in your notes, or choose a gap below. Its source documents open here, with a chat about each.'
        : 'Every flagged passage has been revised or dismissed. Your saved findings stay on the AI-Synthesis board.',
    }),
  );
  const list = el('ul', { className: 'gaplist' });
  for (const g of [...open, ...closed]) {
    const done = g.status !== 'open';
    list.append(el('li', {},
      el('button', {
        type: 'button',
        className: 'gaprow' + (done ? ' done' : ''),
        onClick: () => (done ? null : selectGap(g.id)),
        disabled: done,
      },
      el('span', { className: 'num' + (done ? ' done' : ''), text: done ? '✓' : g.n }),
      el('span', { className: 'gaprow-text' },
        el('span', { className: 'gaprow-title', text: g.title }),
        el('span', { className: 'gaprow-sub', text: done ? (g.statusNote || g.status) : g.question }),
      ),
      el('span', { className: `sev sev-${g.severity}`, text: g.lens }),
      ),
      g.status === 'dismissed' ? button('Reopen', () => reopenGap(g.id), 'link-btn') : null,
    ));
  }
  wrap.append(list);
  return wrap;
}

function renderGapDetail(gap) {
  const box = el('div', { className: 'gap-detail' });
  const docId = state.gapDocId[gap.id] && gap.doc_ids.includes(state.gapDocId[gap.id])
    ? state.gapDocId[gap.id] : gap.doc_ids[0];

  box.append(el('div', { className: 'gapcard' },
    el('div', { className: 'gapcard-row' },
      button('← All gaps', () => { state.selectedGapId = null; changed('left', 'right'); refreshMarksSelection(); }, 'link-btn'),
      el('span', { className: 'spacer' }),
      button('Show in notes', () => scrollToGap(gap.id), 'link-btn'),
      button('Not a gap', () => dismissGap(gap.id), 'link-btn', { title: 'Dismiss this highlight' }),
    ),
    el('div', { className: 'gapcard-title' },
      el('span', { className: 'num', text: gap.n }),
      el('span', { text: gap.title }),
      el('span', { className: `sev sev-${gap.severity}`, text: gap.lens }),
    ),
    el('p', { className: 'gapcard-q' }, el('span', { className: 'ai-mark', text: '✦ ' }), gap.question),
    gap.statusNote ? el('p', { className: 'gapcard-note', text: gap.statusNote }) : null,
  ));

  const chips = el('div', { className: 'docchips', attrs: { role: 'tablist', 'aria-label': 'Documents for this gap' } },
    el('span', { className: 'docchips-label', text: 'Read:' }));
  for (const id of gap.doc_ids) {
    const d = doc(id);
    if (!d) continue;
    chips.append(el('button', {
      type: 'button',
      className: 'docchip',
      attrs: { 'aria-selected': String(id === docId), role: 'tab' },
      onClick: () => { state.gapDocId[gap.id] = id; log('doc_opened', { docId: id, gapId: gap.id }); changed('right'); },
    }, d.title));
  }
  box.append(chips);
  box.append(renderDocPane(docId, gap));
  return box;
}

function refreshMarksSelection() {
  for (const m of $$('#editor mark[data-gap]')) m.classList.toggle('selected', m.dataset.gap === state.selectedGapId);
}

// ================================================================== library

function renderLibrary() {
  if (state.libraryDocId && doc(state.libraryDocId)) {
    const box = el('div', { className: 'gap-detail' });
    box.append(el('div', { className: 'gapcard-row lib-back' },
      button('← Library', () => { state.libraryDocId = null; changed('right'); }, 'link-btn'),
      el('span', { className: 'muted small', text: 'Not linked to a gap · findings go to General' }),
    ));
    box.append(renderDocPane(state.libraryDocId, null));
    return box;
  }

  const wrap = el('div', { className: 'library', dataset: { scrollKey: 'library' } });
  const input = el('input', {
    type: 'search',
    className: 'lib-filter',
    placeholder: 'Filter by title or words in the text…',
    value: state.libraryFilter,
    attrs: { 'aria-label': 'Filter documents' },
  });
  const list = el('div', { className: 'lib-list' });
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    list.textContent = '';
    const groups = new Map();
    for (const d of state.caseData.documents) {
      let hits = 0;
      if (q) {
        hits = d.paragraphs.filter((p) => p.toLowerCase().includes(q)).length;
        if (!hits && !d.title.toLowerCase().includes(q)) continue;
      }
      if (!groups.has(d.kind)) groups.set(d.kind, []);
      groups.get(d.kind).push([d, hits]);
    }
    if (!groups.size) list.append(el('p', { className: 'muted', text: 'No documents match.' }));
    for (const [kind, docs] of groups) {
      list.append(el('div', { className: 'lib-kind', text: kind }));
      for (const [d, hits] of docs) {
        const threadLen = (state.threads[threadKey({ docId: d.id })] || []).filter((m) => m.role === 'user').length;
        list.append(el('button', {
          type: 'button',
          className: 'lib-item',
          onClick: () => { state.libraryDocId = d.id; log('doc_opened', { docId: d.id, gapId: null }); changed('right'); },
        },
        el('span', { className: 'lib-title', text: d.title }),
        el('span', { className: 'lib-meta' },
          `${d.paragraphs.length} ¶`,
          hits ? ` · ${plural(hits, 'match', 'matches')}` : '',
          threadLen ? ` · ${plural(threadLen, 'question')} asked` : ''),
        ));
      }
    }
  };
  input.addEventListener('input', () => { state.libraryFilter = input.value; draw(); });
  draw();
  wrap.append(
    el('p', { className: 'muted small', text: `Every document available to you as ${state.caseData.role.name}. Open one to read it and ask about it.` }),
    input, list,
  );
  return wrap;
}

// ============================================================ doc + chat pane

function renderDocPane(docId, gap) {
  const d = doc(docId);
  const pane = el('div', { className: 'docpane' });
  if (!d) {
    pane.append(el('p', { className: 'muted', text: 'This document is not available to your role.' }));
    return pane;
  }
  const key = threadKey({ gapId: gap?.id, docId });
  const cited = new Set((state.threads[key] || []).flatMap((m) => m.cites || []));

  const scroll = el('div', { className: 'doc-scroll', tabIndex: 0, attrs: { 'aria-label': 'Document text' }, dataset: { scrollKey: `doc:${docId}` } });
  d.paragraphs.forEach((text, i) => {
    const n = i + 1;
    scroll.append(el('div', { className: 'doc-p' + (cited.has(n) ? ' cited' : ''), id: `para-${n}` },
      el('span', { className: 'pn', text: `¶${n}` }),
      el('span', { className: text.includes(' | ') ? 'doc-row' : '', text }),
    ));
  });
  pane.append(el('section', { className: 'docbox' },
    el('header', { className: 'doc-head' },
      el('div', { className: 'doc-type', text: d.kind }),
      el('div', { className: 'doc-title', text: d.title }),
    ),
    scroll,
  ));
  pane.append(renderChat({ scope: 'doc', key, docId, gap }));
  return pane;
}

function renderCaseChat() {
  const box = el('div', { className: 'casechat' });
  box.append(el('div', { className: 'intro compact' },
    el('h3', { text: 'Ask across all your documents' }),
    el('p', { text: 'For questions that are not about one passage: answers cite paragraphs from any document you can see. Findings from here are saved as general insights.' }),
  ));
  box.append(renderChat({ scope: 'case', key: 'case' }));
  return box;
}

// ===================================================================== chat

function renderChat(ctx) {
  const box = el('section', { className: 'chatbox' + (ctx.scope === 'case' ? ' tall' : ''), dataset: { key: ctx.key } });
  const label = ctx.scope === 'case'
    ? el('span', {}, el('b', { text: 'Case chat' }), ' · all documents')
    : el('span', {}, el('b', { text: 'Rabbit-hole chat' }), ' · this document only', ctx.gap ? ` · gap ${ctx.gap.n}` : '');
  box.append(el('div', { className: 'chat-head' }, label));
  box.append(el('div', { className: 'msgs', attrs: { 'aria-live': 'polite' } }));
  box.append(el('div', { className: 'chips' }));
  const input = el('input', {
    type: 'text',
    placeholder: ctx.scope === 'case' ? 'Ask anything about the case…' : 'Ask about this document…',
    attrs: { 'aria-label': 'Your question' },
  });
  box.append(el('form', {
    className: 'composer',
    onSubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) { input.value = ''; ask(ctx, v); } },
  }, input, el('button', { type: 'submit', text: 'Ask' })));
  fillChat(box, ctx);
  return box;
}

/** Re-render the messages and suggestions of a visible chat without touching its input. */
export function refreshThread(key) {
  const box = $(`.chatbox[data-key="${CSS.escape(key)}"]`);
  if (!box) return;
  const [gapPart, docId] = key === 'case' ? [null, null] : key.split('::');
  const gap = gapPart && gapPart !== 'library' ? gapById(gapPart) : null;
  fillChat(box, { scope: key === 'case' ? 'case' : 'doc', key, docId, gap });
  // Keep the "cited" paragraph markers in sync with the conversation.
  if (docId) {
    const cited = new Set((state.threads[key] || []).flatMap((m) => m.cites || []));
    for (const p of $$('.doc-p', box.parentElement)) p.classList.toggle('cited', cited.has(Number(p.id.slice(5))));
  }
}

function fillChat(box, ctx) {
  const msgsEl = $('.msgs', box);
  const chipsEl = $('.chips', box);
  const msgs = state.threads[ctx.key] || [];
  msgsEl.textContent = '';
  if (!msgs.length) {
    msgsEl.append(el('p', { className: 'muted small empty-chat', text: ctx.scope === 'case'
      ? 'Ask a question, or start with a suggestion below.'
      : 'Ask about this document. Answers stay in this chat and do not mix with other documents.' }));
  }
  for (const m of msgs) msgsEl.append(renderMessage(m, ctx));
  msgsEl.scrollTop = msgsEl.scrollHeight;

  chipsEl.textContent = '';
  const asked = new Set(msgs.filter((m) => m.qaId).map((m) => m.qaId));
  const askedText = new Set(msgs.filter((m) => m.role === 'user').map((m) => m.text.toLowerCase()));
  const last = [...msgs].reverse().find((m) => m.role === 'assistant' && !m.pending);
  const suggestions = ctx.scope === 'case'
    ? engine.suggestionsForCase(asked).map((s) => s.q)
    : engine.suggestionsForDoc(ctx.docId, ctx.gap?.id, asked).map((s) => s.q);
  const follow = (last?.followUps || []);
  for (const q of [...follow, ...suggestions].filter((q) => !askedText.has(q.toLowerCase())).slice(0, 4)) {
    chipsEl.append(button(q, () => ask(ctx, q)));
  }
}

function renderMessage(m, ctx) {
  if (m.role === 'user') return el('div', { className: 'msg user', text: m.text });
  const node = el('div', { className: 'msg ai' }, el('div', { className: 'who', text: '✦ AI' }));
  if (m.pending) {
    node.append(el('span', { className: 'typing', text: ctx.scope === 'case' ? 'Searching your documents…' : 'Reading the document…' }));
    return node;
  }
  if (m.error) {
    node.classList.add('err');
    node.append(el('span', { text: `Something went wrong: ${m.error}` }));
    return node;
  }
  node.append(el('div', { className: 'msg-text', text: m.text }));

  if (m.cites?.length) {
    const cs = el('div', { className: 'cites' }, 'Source: ');
    for (const n of m.cites) cs.append(button(`¶${n}`, () => flashParagraph(n, $(`.chatbox[data-key="${CSS.escape(ctx.key)}"]`)?.parentElement), 'cite'));
    node.append(cs);
  }
  if (m.citations?.length) {
    const cs = el('div', { className: 'cites' }, 'Sources: ');
    for (const c of m.citations) {
      const d = doc(c.docId);
      if (!d) continue;
      cs.append(button(`${d.title} ¶${c.paragraph}`, () => openInLibrary(c.docId, c.paragraph), 'cite', { title: d.title }));
    }
    node.append(cs);
  }
  if (m.keyFinding) {
    const onBoard = m.insightId && state.insights.some((i) => i.id === m.insightId);
    node.append(el('div', { className: 'kf' },
      el('div', { className: 'label', text: 'Key finding' }),
      el('div', { text: m.keyFinding }),
      onBoard
        ? el('div', { className: 'kf-act', text: '✓ On your synthesis board' })
        : button('Save to board', () => saveFinding(m, ctx), 'pin-btn'),
    ));
  }
  return node;
}

function originFor(m, ctx) {
  return ctx.scope === 'case'
    ? { type: 'case-chat', citations: m.citations || [], threadKey: ctx.key }
    : { type: 'doc-chat', docId: ctx.docId, cites: m.cites || [], threadKey: ctx.key };
}

function saveFinding(m, ctx, how = 'pin') {
  if (m.insightId && state.insights.some((i) => i.id === m.insightId)) return;
  const ins = addInsight({ text: m.keyFinding, author: 'ai', origin: { ...originFor(m, ctx), how }, gapId: ctx.gap?.id || null });
  m.insightId = ins.id;
  refreshThread(ctx.key);
  changed('left');
}

async function ask(ctx, question) {
  const msgs = thread(ctx.key);
  const history = msgs.slice();
  msgs.push({ id: uid('m'), role: 'user', text: question });
  const pending = { id: uid('m'), role: 'assistant', pending: true };
  msgs.push(pending);
  refreshThread(ctx.key);
  log('question_asked', { scope: ctx.scope, docId: ctx.docId || null, gapId: ctx.gap?.id || null, question });
  try {
    const notes = readNotes();
    const r = ctx.scope === 'case'
      ? await engine.askCase({ question, history, notes })
      : await engine.askDocument({ docId: ctx.docId, gap: ctx.gap, question, history, notes });
    Object.assign(pending, {
      pending: false,
      text: r.text,
      cites: r.cites || [],
      citations: r.citations || [],
      keyFinding: r.keyFinding || null,
      followUps: r.followUps || [],
      qaId: r.qaId || null,
    });
    log('answer_received', { scope: ctx.scope, qaId: r.qaId || null, hasFinding: Boolean(r.keyFinding) });
    if (r.keyFinding && state.autoAdd) saveFinding(pending, ctx, 'auto');
  } catch (err) {
    pending.pending = false;
    pending.error = err.message;
    log('error', { where: 'chat', message: err.message });
  }
  refreshThread(ctx.key);
  changed('left');
}

// ================================================================ navigation

export function flashParagraph(n, root = document) {
  const p = $(`#para-${n}`, root || document);
  if (!p) return;
  p.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flash(p);
}

/** Open a document in the Library tab and highlight a paragraph. */
export function openInLibrary(docId, paragraph) {
  if (!doc(docId)) return;
  state.rightTab = 'library';
  state.libraryDocId = docId;
  log('doc_opened', { docId, gapId: null, via: 'citation' });
  changed('right');
  if (paragraph) requestAnimationFrame(() => flashParagraph(paragraph, $('#src-body')));
}

/** Open the chat a saved insight came from. */
export function openOrigin(insight) {
  const o = insight.origin || {};
  if (o.type === 'case-chat') {
    state.rightTab = 'ask';
    changed('right');
    return;
  }
  if (o.type === 'doc-chat' && o.docId) {
    const [gapPart] = (o.threadKey || '').split('::');
    const gap = gapPart && gapPart !== 'library' ? gapById(gapPart) : null;
    if (gap && gap.status === 'open') {
      state.rightTab = 'gaps';
      state.selectedGapId = gap.id;
      state.gapDocId[gap.id] = o.docId;
      changed('left', 'right');
    } else {
      // Gap closed or library chat: show the document in the library.
      state.rightTab = 'library';
      state.libraryDocId = o.docId;
      changed('right');
    }
    const n = o.cites?.[0];
    if (n) requestAnimationFrame(() => flashParagraph(n, $('#src-body')));
  }
}
