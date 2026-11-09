// AI-Synthesis column.
//
// Board: a free-flow collection of insights. Each card shows where it came
// from: a document chat, the case-wide chat, or the negotiator's own note.
// Cards can be attached to a gap or kept as general insights.
//
// Structured view: the negotiator's free-flow notes (plus, optionally, saved
// insights) restated in negotiation-framework terms. Every item links back to
// the phrase in the notes, the insight it came from, or is marked as a
// question the framework raises.

import * as engine from './engine.js';
import { readNotes, revealPhrase, setStatus } from './editor.js';
import { openOrigin } from './sources.js';
import {
  addInsight, changed, doc, gapById, log, moveInsight, removeInsight, state,
} from './store.js';
import { $, button, el, flash, hash, plural } from './util.js';

let selectGap = () => {};
export function initSynthesis(opts) { selectGap = opts.selectGap; }

export function renderSynthesis() {
  renderTabs();
  const body = $('#ai-body');
  const scroll = body.scrollTop;
  body.textContent = '';
  body.append(state.leftTab === 'structured' ? renderStructured() : renderBoard());
  body.scrollTop = scroll;
}

/** Cheap update when only the notes changed: refresh the "out of date" banner. */
export function renderStale() {
  const banner = $('#stale-banner');
  if (banner) banner.hidden = !isStale();
}

function isStale() {
  return Boolean(state.structured && state.structured.notesHash !== hash(readNotes()));
}

function renderTabs() {
  const tabs = $('#ai-tabs');
  tabs.textContent = '';
  for (const [id, label] of [['board', 'Board'], ['structured', 'Structured view']]) {
    tabs.append(el('button', {
      type: 'button',
      className: 'tab-btn',
      attrs: { role: 'tab', 'aria-selected': String(state.leftTab === id) },
      onClick: () => { state.leftTab = id; log('tab', { column: 'synthesis', tab: id }); changed('left'); },
    }, label, id === 'board' && state.insights.length ? el('span', { className: 'count', text: state.insights.length }) : null));
  }
}

// ==================================================================== board

function gapLabel(g) { return `Gap ${g.n}: ${g.title}`; }

function linkableGaps() { return state.gaps.filter((g) => g.status !== 'dismissed' || state.insights.some((i) => i.gapId === g.id)); }

function renderBoard() {
  const wrap = el('div', { className: 'board' });

  // Controls
  const seg = el('div', { className: 'seg', attrs: { role: 'group', 'aria-label': 'Saving key findings' } });
  for (const [val, label] of [[true, 'Save automatically'], [false, 'Ask me first']]) {
    seg.append(el('button', {
      type: 'button',
      attrs: { 'aria-pressed': String(state.autoAdd === val) },
      onClick: () => { state.autoAdd = val; log('setting', { autoAdd: val }); changed('left'); },
    }, label));
  }
  wrap.append(el('div', { className: 'board-controls' }, el('span', { className: 'small', text: 'Key findings from chats:' }), seg));

  // Quick note: the human's own free-flow ideas live here too, clearly labelled.
  const text = el('textarea', {
    className: 'note-input',
    rows: 2,
    placeholder: 'Jot a note, idea or question to keep…',
    attrs: { 'aria-label': 'New note' },
  });
  const target = el('select', { className: 'note-target', attrs: { 'aria-label': 'Attach note to' } },
    el('option', { value: '', text: 'General' }),
    ...linkableGaps().map((g) => el('option', { value: g.id, text: gapLabel(g), selected: g.id === state.selectedGapId })),
  );
  const add = () => {
    const v = text.value.trim();
    if (!v) return;
    addInsight({ text: v, author: 'human', origin: { type: 'note' }, gapId: target.value || null });
    changed('left');
  };
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } });
  wrap.append(el('div', { className: 'note-composer' }, text, el('div', { className: 'note-row' }, target, button('Save note', add, 'btn-small'))));

  // Sections: one per gap, then General.
  const sections = [];
  for (const g of state.gaps) {
    const items = state.insights.filter((i) => i.gapId === g.id);
    if (g.status === 'dismissed' && !items.length) continue;
    sections.push(renderGapSection(g, items));
  }
  sections.push(renderGeneralSection(state.insights.filter((i) => !i.gapId || !gapById(i.gapId))));
  wrap.append(el('div', { className: 'sections' }, sections));

  if (!state.insights.length && !state.gaps.length) {
    wrap.append(el('p', { className: 'muted small board-hint', text:
      'Insights collect here as you work: findings from document chats, answers from the case-wide chat, and notes you jot yourself. Each card says where it came from.' }));
  }
  return wrap;
}

function renderGapSection(g, items) {
  const open = Boolean(state.expanded[g.id]);
  const section = el('div', { className: 'tab' + (open ? ' open' : '') + (state.selectedGapId === g.id ? ' active' : '') });
  const status = g.status === 'resolved' ? 'Resolved by your edit' : g.status === 'dismissed' ? 'Dismissed' : items.length ? plural(items.length, 'insight') : 'Open';
  section.append(el('button', {
    type: 'button',
    className: 'tab-head',
    attrs: { 'aria-expanded': String(open) },
    onClick: () => { state.expanded[g.id] = !open; changed('left'); },
  },
  el('span', { className: 'num' + (g.status !== 'open' ? ' done' : ''), text: g.status === 'resolved' ? '✓' : g.n }),
  el('span', { className: 'tab-title', text: g.title }),
  el('span', { className: 'badge' + (g.status === 'resolved' ? ' resolved' : ''), text: status }),
  el('span', { className: 'tab-quote', text: g.quote }),
  ));
  const body = el('div', { className: 'tab-body' },
    el('p', { className: 'full-quote', text: `“${g.quote}”` }),
    el('p', { className: 'small' }, el('span', { className: 'ai-mark', text: '✦ ' }), g.question),
    g.status === 'open' && state.selectedGapId !== g.id ? button('Work on this gap →', () => selectGap(g.id), 'link-btn') : null,
    renderCards(items, g.status === 'resolved'
      ? 'You resolved this gap before saving any insights.'
      : 'Nothing saved yet. Open this gap’s documents and ask the chat, or add a note.'),
  );
  section.append(body);
  return section;
}

function renderGeneralSection(items) {
  const open = state.expanded.general !== false;
  const section = el('div', { className: 'tab general' + (open ? ' open' : '') });
  section.append(el('button', {
    type: 'button',
    className: 'tab-head',
    attrs: { 'aria-expanded': String(open) },
    onClick: () => { state.expanded.general = !open; changed('left'); },
  },
  el('span', { className: 'num general', text: '◇' }),
  el('span', { className: 'tab-title', text: 'General insights' }),
  el('span', { className: 'badge', text: items.length ? plural(items.length, 'insight') : 'Empty' }),
  el('span', { className: 'tab-quote plain', text: 'Not tied to a flagged passage: library and case-wide chats, and your own notes.' }),
  ));
  section.append(el('div', { className: 'tab-body' },
    renderCards(items, 'Findings from the Library or “Ask all documents”, and notes you add, appear here.')));
  return section;
}

function renderCards(items, emptyText) {
  if (!items.length) return el('p', { className: 'empty', text: emptyText });
  const ul = el('ul', { className: 'findings' });
  for (const ins of items) ul.append(renderCard(ins));
  return ul;
}

function provenance(ins) {
  const o = ins.origin || {};
  if (ins.author === 'human') return el('span', { className: 'prov human', text: '✎ Your note' });
  const wrap = el('span', { className: 'prov ai' }, '✦ AI · ');
  if (o.type === 'doc-chat') {
    const d = doc(o.docId);
    const label = `${d ? d.title : o.docId}${o.cites?.length ? ' ¶' + o.cites.join(', ') : ''}`;
    wrap.append(button(label, () => openOrigin(ins), 'link-btn src-link', { title: 'Open the chat this came from' }));
    wrap.append(o.how === 'auto' ? ' · saved automatically' : ' · saved by you');
  } else if (o.type === 'case-chat') {
    const docs = [...new Set((o.citations || []).map((c) => doc(c.docId)?.title).filter(Boolean))];
    wrap.append(button(`case chat (${plural(docs.length, 'source')})`, () => openOrigin(ins), 'link-btn src-link', { title: docs.join('\n') }));
  } else {
    wrap.append('generated');
  }
  return wrap;
}

function renderCard(ins) {
  const li = el('li', { className: `finding ${ins.author}`, id: `ins-${ins.id}` });
  li.append(el('div', { className: 'finding-text', text: ins.text }));
  const move = el('select', {
    className: 'move',
    attrs: { 'aria-label': 'Attach to' },
    onChange: (e) => { moveInsight(ins.id, e.target.value); changed('left'); },
  },
  el('option', { value: '', text: 'General', selected: !ins.gapId }),
  ...linkableGaps().map((g) => el('option', { value: g.id, text: `Gap ${g.n}`, selected: g.id === ins.gapId })));
  li.append(el('div', { className: 'finding-meta' },
    provenance(ins),
    el('span', { className: 'spacer' }),
    move,
    button('×', () => { removeInsight(ins.id); changed('left', 'right'); }, 'icon-btn', { 'aria-label': 'Remove insight', title: 'Remove' }),
  ));
  return li;
}

// =============================================================== structured

const SECTION_HELP = {
  objective: 'What you are trying to achieve.',
  parties: 'Iceberg: what each party asks for (position), why (interests), and the norms underneath (values).',
  island: 'Island of agreement: what both sides could accept as a starting point, and what is in dispute.',
  stakeholders: 'Who else shapes the outcome, and how.',
  red_lines: 'What you will not concede.',
  alternatives: 'What you will do if there is no agreement (your BATNA).',
  options: 'Trades and packages your notes mention.',
  open_questions: 'What the framework asks that your notes do not yet answer.',
};

function renderStructured() {
  const wrap = el('div', { className: 'structured' });
  const s = state.structured;

  const runBtn = button(s ? 'Restructure my notes' : 'Structure my notes', runStructure, 'btn-primary small-btn');
  const include = el('label', { className: 'small check' },
    el('input', {
      type: 'checkbox',
      checked: state.includeInsights,
      onChange: (e) => { state.includeInsights = e.target.checked; changed('left'); },
    }),
    ` include saved insights (${state.insights.length})`);
  wrap.append(el('div', { className: 'struct-controls' }, runBtn, include,
    s?.view ? button('Copy', copyStructured, 'link-btn', { title: 'Copy as Markdown' }) : null));

  wrap.append(el('p', { className: 'muted small', text:
    'Restates your own notes in negotiation terms. It may rephrase and organise, but not add facts: every item links to the phrase it came from, a saved insight, or is marked as an open question.' }));

  const banner = el('div', { className: 'banner warn', id: 'stale-banner', text: 'Your notes have changed since this view was generated.' });
  banner.hidden = !isStale();
  wrap.append(banner);
  if (s?.message) wrap.append(el('div', { className: 'banner', text: s.message }));
  if (!s?.view) {
    wrap.append(el('div', { className: 'empty-struct' },
      el('p', { text: 'Write freely in the Human-Only column: fragments, worries, half-formed plans. When you want to see it organised, press “Structure my notes”.' })));
    return wrap;
  }
  const v = s.view;
  wrap.append(section('Objective', 'objective', items(v.objective)));
  const parties = el('div', { className: 'parties' });
  for (const p of v.parties) {
    parties.append(el('div', { className: 'party' },
      el('div', { className: 'party-name', text: p.party }),
      el('div', { className: 'iceberg' },
        iceRow('Position', p.position),
        iceRow('Interests', p.interests),
        iceRow('Values', p.values),
      )));
  }
  wrap.append(section('Parties', 'parties', parties));
  const ioa = v.island_of_agreement;
  wrap.append(section('Island of agreement', 'island', el('div', { className: 'ioa' },
    quad('Convergent facts', ioa.convergent_facts), quad('Contested facts', ioa.contested_facts),
    quad('Shared norms', ioa.shared_norms), quad('Divergent norms', ioa.divergent_norms))));
  wrap.append(section('Stakeholders', 'stakeholders', items(v.stakeholders)));
  wrap.append(section('Red lines', 'red_lines', items(v.red_lines)));
  wrap.append(section('If there is no agreement', 'alternatives', items(v.alternatives)));
  wrap.append(section('Options', 'options', items(v.options)));
  wrap.append(section('Open questions', 'open_questions', items(v.open_questions), 'questions'));
  return wrap;
}

function section(title, key, content, extra = '') {
  return el('section', { className: `struct-section ${extra}` },
    el('h4', { title: SECTION_HELP[key] || '' }, title),
    el('p', { className: 'struct-help', text: SECTION_HELP[key] || '' }),
    content);
}

function iceRow(label, list) {
  return el('div', { className: 'ice-row' }, el('div', { className: 'ice-label', text: label }), items(list, true));
}

function quad(label, list) {
  return el('div', { className: 'quad' }, el('div', { className: 'ice-label', text: label }), items(list, true));
}

function items(list, compact = false) {
  if (!list?.length) return el('p', { className: 'empty' + (compact ? ' compact' : ''), text: compact ? '—' : 'Nothing in your notes yet.' });
  const ul = el('ul', { className: 'frame-items' });
  for (const it of list) ul.append(el('li', { className: `frame-item basis-${it.basis}` }, el('span', { text: it.text }), basisChip(it)));
  return ul;
}

function basisChip(it) {
  if (it.basis === 'notes') {
    return button('✎', () => {
      if (!revealPhrase(it.ref)) setStatus('That phrase is no longer in your notes.', 'warn');
      log('provenance_clicked', { basis: 'notes' });
    }, 'basis-chip notes', { title: it.ref ? `From your notes: “${it.ref}”` : 'From your notes' });
  }
  if (it.basis === 'insight') {
    return button('✦', () => {
      state.leftTab = 'board';
      changed('left');
      requestAnimationFrame(() => { const card = $(`#ins-${CSS.escape(it.ref)}`); card?.scrollIntoView({ block: 'center' }); flash(card); });
    }, 'basis-chip insight', { title: 'From a saved insight' });
  }
  return el('span', { className: 'basis-chip framework', title: 'A question the framework raises', text: '?' });
}

async function runStructure() {
  const notes = readNotes();
  if (!notes) { setStatus('Write some notes first.', 'warn'); return; }
  const btn = $('.struct-controls .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Structuring…'; }
  log('structure_requested', { includeInsights: state.includeInsights });
  try {
    const { view, source, message } = await engine.structureNotes(notes, state.includeInsights ? state.insights : []);
    state.structured = view ? { view, source, message, notesHash: hash(notes), generatedAt: new Date().toISOString() } : { view: null, message };
  } catch (err) {
    state.structured = { ...(state.structured || {}), message: `Could not structure notes: ${err.message}` };
  }
  changed('left');
}

function copyStructured() {
  const v = state.structured?.view;
  if (!v) return;
  const md = [];
  const list = (title, xs) => { md.push(`## ${title}`); (xs || []).forEach((x) => md.push(`- ${x.text}${x.basis === 'framework' ? ' (open)' : ''}`)); md.push(''); };
  list('Objective', v.objective);
  for (const p of v.parties) {
    md.push(`## ${p.party}`);
    for (const [k, xs] of [['Position', p.position], ['Interests', p.interests], ['Values', p.values]]) {
      if (xs.length) md.push(`**${k}:** ` + xs.map((x) => x.text).join(' '));
    }
    md.push('');
  }
  const i = v.island_of_agreement;
  list('Convergent facts', i.convergent_facts); list('Contested facts', i.contested_facts);
  list('Shared norms', i.shared_norms); list('Divergent norms', i.divergent_norms);
  list('Stakeholders', v.stakeholders); list('Red lines', v.red_lines);
  list('If there is no agreement', v.alternatives); list('Options', v.options); list('Open questions', v.open_questions);
  navigator.clipboard?.writeText(md.join('\n')).then(
    () => setStatus('Structured view copied as Markdown', 'ok'),
    () => setStatus('Copy failed', 'error'),
  );
}

export function focusInsight(id) {
  const card = $(`#ins-${CSS.escape(id)}`);
  card?.scrollIntoView({ block: 'center' });
  flash(card);
}
