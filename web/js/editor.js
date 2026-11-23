// Your strategy notes (centre column): a plain contenteditable for free-flow notes. The AI never
// writes here; it only adds highlights that point at passages worth checking.

import * as engine from './engine.js?v=0.3.2';
import { changed, doc, gapById, log, openGaps, state } from './store.js?v=0.3.2';
import { $, $$, debounce, el, escapeHTML, normalize, plural, stripScaffold, uid } from './util.js?v=0.3.2';

const editor = () => $('#editor');
let onSelectGap = () => {};
let onFirstGaps = () => {};

export function initEditor({ selectGap, firstGaps }) {
  onSelectGap = selectGap;
  if (firstGaps) onFirstGaps = firstGaps;
  const ed = editor();
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* old browsers */ }

  // Text and new lines typed at the edge of a highlight belong outside it.
  ed.addEventListener('beforeinput', (e) => {
    if (e.inputType.startsWith('insert')) escapeMarkEdge();
  });
  ed.addEventListener('input', (e) => {
    tidyMarks(e.inputType || '');
    updatePlaceholder();
    persist();
    if (openGaps().length) setStatus('Edited · press “Find gaps” to re-check');
  });
  ed.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });
  ed.addEventListener('click', (e) => {
    const mark = e.target.closest('mark[data-gap]');
    if (mark) onSelectGap(mark.dataset.gap);
  });
  ed.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); findGaps(); }
  });
  $('#find-gaps').addEventListener('click', findGaps);
}

const persist = debounce(() => {
  state.notesHTML = editor().innerHTML;
  changed('leftStale');
}, 400);

export function setStatus(text, tone = '') {
  const s = $('#status');
  s.textContent = text;
  s.dataset.tone = tone;
}

// ---------------------------------------------------------------- content

export function loadNotes() {
  const ed = editor();
  if (state.notesHTML) {
    ed.innerHTML = state.notesHTML;
  } else {
    const text = state.caseData.role.starter_notes || '';
    ed.innerHTML = SCAFFOLD_HTML + text
      .split(/\n\s*\n/)
      .filter((p) => p.trim())
      .map((p) => `<p>${escapeHTML(p.trim()).replace(/\n/g, '<br>')}</p>`)
      .join('');
    state.notesHTML = ed.innerHTML;
  }
  syncMarks();
  setStatus('');
  updatePlaceholder();
}

// Pre-filled prompts: real content (they stay once the writer starts), not a placeholder. Each is a
// bold line with an empty line under it for the answer. Keep in step with SCAFFOLD_LABELS in util.js.
const SCAFFOLD_HTML = [
  'What do I want?',
  'What does the other side want?',
  'What’s my plan?',
].map((q) => `<p><b>${q}</b></p><p><br></p>`).join('');

/** True while the writer has written nothing beyond the pre-filled headings. */
export function isBlank(text = readNotes()) {
  return !stripScaffold(text);
}

// The hint shows only while there is nothing but the headings, and goes with the first character.
function updatePlaceholder() {
  editor().classList.toggle('is-empty', isBlank());
}

/** The notes as plain text, paragraphs separated by blank lines. */
export function readNotes() {
  const ed = editor();
  const BLOCK = /^(P|DIV|UL|OL|H[1-6]|BLOCKQUOTE)$/;
  const out = [];
  let loose = ''; // text typed straight into the editor, outside any paragraph
  const flush = () => { if (loose.trim()) out.push(loose.trim()); loose = ''; };
  for (const node of ed.childNodes) {
    if (node.nodeType === 1 && BLOCK.test(node.tagName)) {
      flush();
      const t = node.innerText.trim();
      if (t) out.push(t);
    } else if (node.nodeType === 3) loose += node.data;
    else if (node.nodeType === 1) loose += node.tagName === 'BR' ? '\n' : node.textContent;
  }
  flush();
  return out.join('\n\n').replace(/\u200b/g, '').replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------- marks

/** Locate `quote` in the editor's text nodes. Returns [{node, start, end}] segments or null. */
function locate(quote, root = editor()) {
  const chars = []; // [node, offset] per character, null for block boundaries
  let full = '';
  let lastBlock = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const block = node.parentElement.closest('p, div, li, h1, h2, h3') || root;
    if (lastBlock && block !== lastBlock) { full += '\n'; chars.push(null); }
    lastBlock = block;
    for (let i = 0; i < node.data.length; i++) {
      if (node.data[i] === ZWSP) continue; // hidden caret-room characters are not text
      full += node.data[i];
      chars.push([node, i]);
    }
  }
  const tokens = normalize(quote).split(' ').filter(Boolean);
  if (!tokens.length) return null;
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['\u2019]").replace(/"/g, '["\u201c\u201d]');
  const re = new RegExp(tokens.map(esc).join('[ \\t\\u00a0]+'), 'i');
  const m = re.exec(full);
  if (!m) return null;
  const segments = [];
  for (let i = m.index; i < m.index + m[0].length; i++) {
    const c = chars[i];
    if (!c) continue;
    const [node, off] = c;
    const last = segments[segments.length - 1];
    if (last && last.node === node && last.end === off) last.end = off + 1;
    else segments.push({ node, start: off, end: off + 1 });
  }
  return segments;
}

// A highlight must not swallow what is typed next to it. Chrome extends an inline element when you
// type at its edge, and clones it into the new line when you press Enter, so before an insertion we
// move the caret just outside the highlight; afterwards empty clones and repeated badges are tidied.
// The number badge is drawn by CSS, so the caret could never stand behind it: each numbered
// highlight is followed by a zero-width character that gives the caret somewhere to go.

const ZWSP = '​';
const EDGE = 'mark[data-gap], span.supported';

function escapeMarkEdge() {
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed || !editor().contains(sel.anchorNode)) return;
  const origin = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
  const mark = origin && origin.closest(EDGE);
  if (!mark) return;
  const edge = (side) => {
    const r = document.createRange();
    r.selectNodeContents(mark);
    if (side === 'end') r.setStart(sel.anchorNode, sel.anchorOffset);
    else r.setEnd(sel.anchorNode, sel.anchorOffset);
    return r.toString() === '';
  };
  const atEnd = edge('end');
  if (!atEnd && !edge('start')) return; // inside the passage: editing it is the point
  const sibling = atEnd ? mark.nextSibling : mark.previousSibling;
  let target = sibling && sibling.nodeType === 3 ? sibling : null;
  if (!target) {
    target = document.createTextNode(ZWSP);
    if (atEnd) mark.after(target); else mark.before(target);
  }
  sel.collapse(target, atEnd ? (target.data.startsWith(ZWSP) ? 1 : 0) : target.data.length);
}

/** Put a hidden character behind every numbered highlight so the caret can stand after its badge. */
function ensureCaretRoom() {
  for (const mark of $$('mark[data-n]', editor())) {
    const next = mark.nextSibling;
    if (!(next && next.nodeType === 3 && next.data.startsWith(ZWSP))) mark.after(document.createTextNode(ZWSP));
  }
}

// Runs after every edit. It never moves the caret: restoring it by character offset used to throw
// it back to the end of the previous line after Enter.
function tidyMarks(inputType = '') {
  const ed = editor();
  const pieces = new Map();
  for (const m of $$('mark[data-gap]', ed)) {
    if (!m.textContent) { m.replaceWith(...m.childNodes); continue; } // empty clone left by Enter
    if (!pieces.has(m.dataset.gap)) pieces.set(m.dataset.gap, []);
    pieces.get(m.dataset.gap).push(m);
  }
  // Only the last piece of a split highlight carries the number badge.
  for (const list of pieces.values()) list.slice(0, -1).forEach((m) => m.removeAttribute('data-n'));
  // A green passage the writer has rewritten is no longer known to be supported.
  for (const span of $$('span.supported', ed)) {
    if (!span.textContent) span.replaceWith(...span.childNodes);
    else if (span.textContent !== span.dataset.orig) { span.classList.remove('supported'); span.removeAttribute('title'); }
  }
  // Not while deleting: a Backspace that removes the hidden character must not be undone.
  if (!inputType.startsWith('delete')) ensureCaretRoom();
}

function marksFor(gapId) {
  return $$(`mark[data-gap="${gapId}"]`, editor());
}

function wrap(gap) {
  const segments = locate(gap.quote);
  if (!segments) return false;
  segments.forEach((seg, i) => {
    const range = document.createRange();
    range.setStart(seg.node, seg.start);
    range.setEnd(seg.node, seg.end);
    const mark = el('mark', { dataset: { gap: gap.id } });
    if (i === segments.length - 1) mark.dataset.n = gap.n;
    mark.title = gap.question || gap.title;
    try { range.surroundContents(mark); } catch { /* range crosses an element; skip segment */ }
  });
  return true;
}

function unwrap(gapId) {
  for (const mark of marksFor(gapId)) {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
    parent.normalize();
  }
}

// ------------------------------------------------- passages the documents support

function supportTitle(item) {
  const refs = (item.citations || [])
    .map((c) => { const d = doc(c.docId); return d ? `${d.title} ¶${c.paragraph}` : null; })
    .filter(Boolean);
  return 'This is supported by documents!' + (refs.length ? ` (${refs.join('; ')})` : '');
}

function clearSupported() {
  for (const span of $$('span[data-support]', editor())) {
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    span.remove();
    parent.normalize();
  }
}

/** Mark passages the documents confirm in green. Never touches a gap's highlight. Returns the count. */
function applySupported(items) {
  let count = 0;
  for (const item of items) {
    const segments = locate(item.quote);
    if (!segments || segments.some((seg) => seg.node.parentElement.closest('mark[data-gap], span[data-support]'))) continue;
    const id = uid('sup');
    const title = supportTitle(item);
    for (const seg of segments) {
      const range = document.createRange();
      range.setStart(seg.node, seg.start);
      range.setEnd(seg.node, seg.end);
      const span = el('span', { className: 'supported', dataset: { support: id, orig: seg.node.data.slice(seg.start, seg.end) } });
      span.title = title;
      try { range.surroundContents(span); } catch { /* range crosses an element; skip segment */ }
    }
    count++;
  }
  return count;
}

/** Caret position as a count of visible characters, or null if it is not inside a text node. */
function saveCaret() {
  const sel = window.getSelection();
  const ed = editor();
  // A caret anchored on an element (an empty line) survives our edits as it is; restoring it by a
  // character offset would jump it back to the end of the previous line.
  if (!sel.rangeCount || !ed.contains(sel.anchorNode) || sel.anchorNode.nodeType !== 3) return null;
  const range = sel.getRangeAt(0);
  const pre = document.createRange();
  pre.selectNodeContents(ed);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().replace(/​/g, '').length;
}

function restoreCaret(offset) {
  if (offset == null) return;
  const walker = document.createTreeWalker(editor(), NodeFilter.SHOW_TEXT);
  let left = offset; // visible characters only, so hidden ones added meanwhile do not shift it
  while (walker.nextNode()) {
    const node = walker.currentNode;
    let seen = 0;
    for (let i = 0; i <= node.data.length; i++) {
      if (seen === left) { window.getSelection().collapse(node, i); return; }
      if (i < node.data.length && node.data[i] !== ZWSP) seen++;
    }
    left -= seen;
  }
}

/** Make the highlights match the gap list: open gaps marked, others not. */
export function syncMarks() {
  const caret = saveCaret();
  for (const mark of $$('mark[data-gap]', editor())) {
    const gap = gapById(mark.dataset.gap);
    if (!gap || gap.status !== 'open') unwrap(mark.dataset.gap);
  }
  for (const gap of openGaps()) {
    if (!marksFor(gap.id).length) wrap(gap);
  }
  ensureCaretRoom();
  for (const mark of $$('mark[data-gap]', editor())) {
    mark.classList.toggle('selected', mark.dataset.gap === state.selectedGapId);
  }
  restoreCaret(caret);
  state.notesHTML = editor().innerHTML;
}

export function scrollToGap(gapId) {
  const mark = marksFor(gapId)[0];
  if (mark) mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** Select a phrase from the notes (used by the structured view's provenance links). */
export function revealPhrase(phrase) {
  const segments = phrase && locate(phrase);
  if (!segments) return false;
  const first = segments[0], last = segments[segments.length - 1];
  const range = document.createRange();
  range.setStart(first.node, first.start);
  range.setEnd(last.node, last.end);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  first.node.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}

// ---------------------------------------------------------------- finding gaps
//
// One button does both jobs: highlights whose passage was edited are
// re-checked (and clear if the assumption is gone), and the whole text is read
// again for new passages worth examining.

let running = false;

export async function findGaps() {
  if (running) return;
  const notes = readNotes();
  if (isBlank(notes)) { setStatus('Write some notes first.', 'warn'); return; }
  running = true;
  log('find_gaps_requested', { chars: notes.length });
  const btn = $('#find-gaps');
  btn.disabled = true;
  const session = state.sessionId;
  setStatus(state.mode === 'live' ? 'Reading your notes against the case documents…' : 'Checking your notes…', 'busy');
  try {
    const rechecked = await recheckEdited(notes);
    if (state.sessionId !== session) return; // case, role or Reset changed mid-run
    const [found, supported] = await Promise.all([engine.findGaps(notes), engine.findSupported(notes)]);
    if (state.sessionId !== session) return;
    clearSupported(); // re-marked below, after the gaps, so a gap's highlight always wins
    const resolved = commitRechecks(rechecked);
    const added = commitNew(found);
    const first = !state.gapsChecked;
    state.gapsChecked = true;
    state.notesCheckedText = notes;
    // A fresh check starts from the overview: every section closed, no gap in focus, and the
    // right-hand side showing the list of all gaps.
    state.selectedGapId = null;
    state.expanded = { general: false };
    state.rightTab = 'gaps';
    syncMarks();
    const supportedCount = applySupported(supported);
    state.notesHTML = editor().innerHTML;
    if (first && added.count) onFirstGaps(); // make room for the highlights
    const stillOpen = rechecked.filter(([, , r]) => !r.resolved).length;
    const green = supportedCount ? ` · ${supportedCount} supported by documents (green)` : '';
    setStatus(summary(added.count, resolved, stillOpen, added.message) + green, added.message && !openGaps().length ? 'warn' : resolved ? 'ok' : '');
    changed('left', 'right');
  } catch (err) {
    setStatus(`Could not check notes: ${err.message}`, 'error');
    log('error', { where: 'find_gaps', message: err.message });
  } finally {
    running = false;
    btn.disabled = false;
  }
}

function summary(added, resolved, stillOpen, message) {
  const open = openGaps().length;
  if (!open && !resolved && message) return message;
  const parts = [];
  if (resolved) parts.push(`${plural(resolved, 'gap')} resolved by your edit`);
  if (stillOpen) parts.push(`${plural(stillOpen, 'edited passage')} still ${stillOpen === 1 ? 'rests' : 'rest'} on the assumption`);
  if (added) parts.push(`${plural(added, 'new gap')}`);
  parts.push(open ? `${open} open · click a highlight to examine it` : 'no open gaps');
  return parts.join(' · ');
}

/** Ask whether each edited highlight still rests on its assumption. Changes no state. */
async function recheckEdited(notes) {
  const edited = [];
  for (const gap of openGaps()) {
    let text = marksFor(gap.id).map((m) => m.textContent).join('');
    // Highlight lost (e.g. restored session) but the passage is still there: unchanged.
    if (!text && locate(gap.quote)) { wrap(gap); text = gap.quote; }
    if (normalize(text) !== normalize(gap.checkedText ?? gap.quote)) edited.push([gap, text]);
  }
  return Promise.all(edited.map(async ([gap, text]) => [gap, text, await engine.recheck(gap, text, notes)]));
}

function commitRechecks(results) {
  let resolved = 0;
  for (const [gap, text, r] of results) {
    gap.checkedText = text;
    if (r.resolved) {
      gap.status = 'resolved';
      gap.statusNote = r.explanation;
      resolved++;
      if (state.selectedGapId === gap.id) state.selectedGapId = null;
      log('gap_resolved', { gapId: gap.id, n: gap.n, explanation: r.explanation });
    } else if (r.explanation && r.explanation !== 'Unchanged.') {
      gap.statusNote = r.explanation;
    }
  }
  return resolved;
}

/** True if `quote` is, or overlaps, a passage that already has a gap (any status). */
function alreadyFlagged(quote) {
  const q = normalize(quote).toLowerCase();
  if (state.gaps.some((g) => {
    const k = normalize(g.quote).toLowerCase();
    const c = g.checkedText ? normalize(g.checkedText).toLowerCase() : '';
    return k === q || k.includes(q) || q.includes(k) || (c && (c.includes(q) || q.includes(c)));
  })) return true;
  // Overlaps a highlight that is on screen now.
  const segments = locate(quote) || [];
  return segments.some((seg) => seg.node.parentElement.closest('mark[data-gap]'));
}

/** Add newly found gaps, never re-raising a passage that is flagged, resolved or dismissed. */
function commitNew({ gaps, message }) {
  let count = 0;
  for (const g of gaps) {
    if (!locate(g.quote) || alreadyFlagged(g.quote)) continue;
    state.gaps.push({ ...g, scriptId: g.id || null, id: uid('gap'), n: ++state.gapCounter, status: 'open', statusNote: '' });
    count++;
  }
  log('find_gaps_result', { added: count, total: openGaps().length });
  return { count, message };
}

export function dismissGap(gapId) {
  const gap = gapById(gapId);
  if (!gap) return;
  gap.status = 'dismissed';
  gap.statusNote = 'Dismissed by you';
  if (state.selectedGapId === gapId) state.selectedGapId = null;
  syncMarks();
  log('gap_dismissed', { gapId, n: gap.n });
  changed('left', 'right');
}

export function reopenGap(gapId) {
  const gap = gapById(gapId);
  if (!gap) return;
  if (!locate(gap.quote)) { setStatus('That passage is no longer in your notes.', 'warn'); return; }
  gap.status = 'open';
  gap.statusNote = '';
  syncMarks();
  log('gap_reopened', { gapId, n: gap.n });
  changed('left', 'right');
}

export function refreshPlaceholder() { updatePlaceholder(); }
