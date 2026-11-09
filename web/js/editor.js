// Human-Only column: a plain contenteditable for free-flow notes. The AI never
// writes here; it only adds highlights that point at passages worth checking.

import * as engine from './engine.js';
import { changed, gapById, log, openGaps, state } from './store.js';
import { $, $$, debounce, el, escapeHTML, normalize, plural, uid } from './util.js';

const editor = () => $('#editor');
let onSelectGap = () => {};

export function initEditor({ selectGap }) {
  onSelectGap = selectGap;
  const ed = editor();
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* old browsers */ }

  ed.addEventListener('input', () => {
    setStatus('Unsubmitted changes');
    $('#submit').disabled = !openGaps().length;
    updatePlaceholder();
    persist();
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
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  $('#find-gaps').addEventListener('click', runFindGaps);
  $('#submit').addEventListener('click', submit);
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
    ed.innerHTML = text
      .split(/\n\s*\n/)
      .filter((p) => p.trim())
      .map((p) => `<p>${escapeHTML(p.trim()).replace(/\n/g, '<br>')}</p>`)
      .join('');
    state.notesHTML = ed.innerHTML;
  }
  syncMarks();
  setStatus('');
  $('#submit').disabled = true;
  updatePlaceholder();
}

function updatePlaceholder() {
  editor().classList.toggle('is-empty', !readNotes().trim());
}

/** The notes as plain text, paragraphs separated by blank lines. */
export function readNotes() {
  const ed = editor();
  const blocks = $$(':scope > p, :scope > div, :scope > ul, :scope > ol, :scope > h1, :scope > h2, :scope > h3', ed);
  const text = blocks.length && blocks.length === ed.children.length
    ? blocks.map((b) => b.innerText.trim()).filter(Boolean).join('\n\n')
    : ed.innerText;
  return text.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
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
    for (let i = 0; i < node.data.length; i++) { full += node.data[i]; chars.push([node, i]); }
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

/** Make the highlights match the gap list: open gaps marked, others not. */
export function syncMarks() {
  for (const mark of $$('mark[data-gap]', editor())) {
    const gap = gapById(mark.dataset.gap);
    if (!gap || gap.status !== 'open') unwrap(mark.dataset.gap);
  }
  for (const gap of openGaps()) {
    if (!marksFor(gap.id).length) wrap(gap);
  }
  for (const mark of $$('mark[data-gap]', editor())) {
    mark.classList.toggle('selected', mark.dataset.gap === state.selectedGapId);
  }
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

// ---------------------------------------------------------------- actions

export async function runFindGaps() {
  const notes = readNotes();
  if (!notes) { setStatus('Write some notes first.', 'warn'); return; }
  const btn = $('#find-gaps');
  btn.disabled = true;
  setStatus(state.mode === 'live' ? 'Reading your notes against the case documents…' : 'Checking your notes…', 'busy');
  log('find_gaps_requested', { chars: notes.length });
  try {
    const { gaps, message } = await engine.findGaps(notes);
    let added = 0;
    for (const g of gaps) {
      const dup = state.gaps.find((x) => x.status === 'open' && normalize(x.quote).toLowerCase() === normalize(g.quote).toLowerCase());
      if (dup) continue;
      const gap = {
        ...g,
        scriptId: g.id || null,
        id: uid('gap'),
        n: ++state.gapCounter,
        status: 'open',
        statusNote: '',
      };
      if (!locate(gap.quote)) { state.gapCounter--; continue; }
      state.gaps.push(gap);
      added++;
    }
    state.gapsChecked = true;
    syncMarks();
    log('find_gaps_result', { added, total: openGaps().length });
    const n = openGaps().length;
    setStatus(message || (added ? `${plural(added, 'passage')} flagged · click a highlight to examine it` : n ? 'No new gaps found' : 'No gaps found'), message ? 'warn' : '');
    if (state.rightTab !== 'gaps') state.rightTab = 'gaps';
    changed('left', 'right');
  } catch (err) {
    setStatus(`Could not check notes: ${err.message}`, 'error');
    log('error', { where: 'find_gaps', message: err.message });
  } finally {
    btn.disabled = false;
  }
}

export async function submit() {
  const notes = readNotes();
  const open = openGaps();
  if (!open.length) { setStatus('Saved'); return; }
  const btn = $('#submit');
  btn.disabled = true;
  setStatus('Re-checking edited passages…', 'busy');
  try {
    const results = await Promise.all(open.map(async (gap) => {
      let revised = marksFor(gap.id).map((m) => m.textContent).join('');
      if (!revised && locate(gap.quote)) { wrap(gap); revised = gap.quote; }
      return [gap, await engine.recheck(gap, revised, notes)];
    }));
    const resolved = [];
    for (const [gap, r] of results) {
      if (r.resolved) {
        gap.status = 'resolved';
        gap.statusNote = r.explanation;
        resolved.push(gap);
        log('gap_resolved', { gapId: gap.id, n: gap.n, explanation: r.explanation });
      } else if (r.explanation && r.explanation !== 'Unchanged.') {
        gap.statusNote = r.explanation;
      }
    }
    if (resolved.some((g) => g.id === state.selectedGapId)) state.selectedGapId = null;
    syncMarks();
    state.notesSubmittedText = notes;
    const left = openGaps().length;
    setStatus(
      resolved.length
        ? `${plural(resolved.length, 'gap')} resolved · ${left} still open`
        : `No flagged passage changed enough · ${left} still open`,
      resolved.length ? 'ok' : '',
    );
    log('notes_submitted', { resolved: resolved.map((g) => g.n), open: left });
    changed('left', 'right');
  } catch (err) {
    setStatus(`Re-check failed: ${err.message}`, 'error');
    btn.disabled = false;
  }
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
