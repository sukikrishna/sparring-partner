// Entry point: picks the case, role and mode, loads data, wires the columns.

import { detectBackend, hasBackend, hasModel, listCases, loadCase, loadDemoScript, modelName } from './api.js';
import { initEditor, loadNotes, readNotes, refreshPlaceholder, setStatus, syncMarks } from './editor.js';
import { initSources, renderSources } from './sources.js';
import {
  changed, exportSession, log, registerRenderer, resetSession, restore, save, state,
} from './store.js';
import { initSynthesis, renderStale, renderSynthesis } from './synthesis.js';
import { $, $$, download, el } from './util.js';

const DEFAULT = { caseId: 'qiso', roleId: 'mayor' };

function selectGap(id) {
  const gap = state.gaps.find((g) => g.id === id);
  if (!gap || gap.status !== 'open') return;
  state.selectedGapId = id;
  state.rightTab = 'gaps';
  state.expanded[id] = true;
  syncMarks();
  log('gap_selected', { gapId: id, n: gap.n });
  changed('left', 'right');
  reveal('src');
}

registerRenderer('left', renderSynthesis);
registerRenderer('right', renderSources);
registerRenderer('leftStale', renderStale);
registerRenderer('steps', renderSteps);

// ------------------------------------------------------------- step guide

/** Write → Find gaps → Investigate → Revise, derived from session state. */
function renderSteps() {
  const done = {
    write: readNotes().trim().length > 0,
    gaps: state.gapsChecked,
    investigate: state.insights.length > 0
      || Object.values(state.threads).some((t) => t.some((m) => m.role === 'user')),
    revise: state.gaps.some((g) => g.status === 'resolved'),
  };
  let current = false;
  for (const li of $$('#steps li')) {
    const key = li.dataset.step;
    li.removeAttribute('aria-current');
    if (done[key]) li.dataset.state = 'done';
    else if (!current) { li.dataset.state = 'current'; li.setAttribute('aria-current', 'step'); current = true; }
    else delete li.dataset.state;
    const label = li.dataset.label || (li.dataset.label = li.textContent.trim());
    li.setAttribute('aria-label', `${label}: ${done[key] ? 'done' : li.dataset.state === 'current' ? 'current step' : 'not started'}`);
  }
}

// ------------------------------------------------------- collapsible panels

const LAYOUT_KEY = 'sparring-partner:layout';

const STACKED = window.matchMedia('(max-width: 1180px)');

function applyLayout(layout) {
  for (const side of ['ai', 'src']) {
    const collapsed = Boolean(layout[side]);
    $('#app').classList.toggle(`${side}-collapsed`, collapsed);
    $(`#col-${side}`).classList.toggle('collapsed', collapsed);
    for (const btn of $$(`[data-collapse="${side}"]`)) btn.setAttribute('aria-expanded', String(!collapsed));
  }
}

function readLayout() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; } catch { return {}; }
}

let layout = {};

function setCollapsed(side, collapsed, { focus = false } = {}) {
  if (Boolean(layout[side]) === collapsed) return;
  layout = { ...layout, [side]: collapsed };
  applyLayout(layout);
  log('layout', { panel: side, collapsed });
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* ignore */ }
  // Keep keyboard focus on the visible counterpart of the control that was used.
  if (focus) $(collapsed ? `#col-${side} .rail` : `#col-${side} .collapse-btn`)?.focus();
}

/** Make sure a side panel is visible (expanded, and on screen when panels are stacked). */
function reveal(side) {
  setCollapsed(side, false);
  if (STACKED.matches) $(`#col-${side}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function wireLayout() {
  layout = readLayout();
  applyLayout(layout);
  for (const btn of $$('[data-collapse]')) {
    btn.addEventListener('click', () => setCollapsed(btn.dataset.collapse, !layout[btn.dataset.collapse], { focus: true }));
  }
}

// ------------------------------------------------------------------ routing

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { caseId: p.get('case'), roleId: p.get('role'), mode: p.get('mode') };
}

function writeHash() {
  const p = new URLSearchParams({ case: state.caseId, role: state.roleId, mode: state.mode });
  history.replaceState(null, '', `#${p}`);
}

// ------------------------------------------------------------------ topbar

let cases = [];

function renderTopbar() {
  const select = $('#case-select');
  select.textContent = '';
  for (const c of cases) {
    const group = el('optgroup', { label: c.title });
    for (const r of c.roles) {
      group.append(el('option', {
        value: `${c.id}/${r.id}`,
        text: `${c.title} — ${r.name}`,
        selected: c.id === state.caseId && r.id === state.roleId,
      }));
    }
    select.append(group);
  }

  const demoBtn = $('#mode-demo'), liveBtn = $('#mode-live');
  demoBtn.setAttribute('aria-pressed', String(state.mode === 'demo'));
  liveBtn.setAttribute('aria-pressed', String(state.mode === 'live'));
  liveBtn.disabled = !hasModel();
  liveBtn.title = hasModel()
    ? `Answers generated by ${modelName()} from your case documents`
    : hasBackend()
      ? 'No model configured on the server (set ANTHROPIC_API_KEY and restart)'
      : 'Live mode needs the Python server (see README)';
  demoBtn.title = state.demo
    ? 'Prepared gaps and answers for this scenario, plus passage search'
    : 'No script for this role: passage search only';
  $('#mode-note').textContent = state.mode === 'live' ? modelName() : state.demo ? '' : 'No script for this role: passage search only';
}

// ------------------------------------------------------------------ loading

async function loadSession({ caseId, roleId, mode }, { saveCurrent = true } = {}) {
  document.body.classList.add('loading');
  if (saveCurrent) save();
  state.caseId = caseId;
  state.roleId = roleId;
  state.mode = mode === 'live' && hasModel() ? 'live' : 'demo';
  resetSession();

  let data;
  try {
    data = await loadCase(caseId, roleId);
  } catch (err) {
    showFatal(`Could not load case “${caseId}”: ${err.message}`);
    return;
  }
  state.caseData = data;
  state.roleId = data.role.id;
  state.docsById = Object.fromEntries(data.documents.map((d) => [d.id, d]));
  state.demo = await loadDemoScript(caseId, data.role.id);

  const restored = restore();
  if (!restored) log('session_started', { caseId, roleId: data.role.id, mode: state.mode });

  $('#role-brief-title').textContent = `${data.role.name}`;
  $('#role-brief-text').textContent = data.role.brief;
  $('#case-summary').textContent = data.summary;

  loadNotes();
  writeHash();
  renderTopbar();
  renderSynthesis();
  renderSources();
  renderSteps();
  if (restored) setStatus('Session restored', 'ok');
  document.body.classList.remove('loading');
}

function showFatal(message) {
  document.body.classList.remove('loading');
  $('#app').replaceChildren(el('div', { className: 'fatal' },
    el('h2', { text: 'Something went wrong' }),
    el('p', { text: message }),
    el('p', { text: 'If you are running from a clone, build the corpus with `sparring-partner ingest` and serve the app with `sparring-partner serve`.' })));
}

// ------------------------------------------------------------------ actions

function wireTopbar() {
  $('#case-select').addEventListener('change', (e) => {
    const [caseId, roleId] = e.target.value.split('/');
    loadSession({ caseId, roleId, mode: state.mode });
  });
  $('#mode-demo').addEventListener('click', () => {
    if (state.mode !== 'demo') loadSession({ caseId: state.caseId, roleId: state.roleId, mode: 'demo' });
  });
  $('#mode-live').addEventListener('click', () => {
    if (state.mode !== 'live' && hasModel()) loadSession({ caseId: state.caseId, roleId: state.roleId, mode: 'live' });
  });
  $('#reset').addEventListener('click', () => {
    if (!confirm('Start over? This clears your notes, chats and saved insights for this case and role.')) return;
    log('session_reset');
    resetSession({ clearStorage: true });
    loadSession({ caseId: state.caseId, roleId: state.roleId, mode: state.mode }, { saveCurrent: false });
  });
  $('#export').addEventListener('click', () => {
    log('session_exported');
    const data = exportSession(readNotes());
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    download(`sparring-partner-${state.caseId}-${state.roleId}-${stamp}.json`, JSON.stringify(data, null, 2));
  });
  $('#help').addEventListener('click', () => $('#help-dialog').showModal());
  $('#brief-toggle').addEventListener('click', () => {
    const open = $('#role-brief').toggleAttribute('open');
    $('#brief-toggle').setAttribute('aria-expanded', String(open));
  });
  window.addEventListener('beforeunload', save);
}

// ------------------------------------------------------------------ boot

async function boot() {
  initEditor({ selectGap });
  initSources({ selectGap });
  initSynthesis({ selectGap });
  wireTopbar();
  wireLayout();

  await detectBackend();
  try {
    cases = await listCases();
  } catch (err) {
    showFatal(`No case index found (${err.message}).`);
    return;
  }
  if (!cases.length) { showFatal('No cases have been built yet.'); return; }

  const wanted = readHash();
  const caseEntry = cases.find((c) => c.id === wanted.caseId) || cases.find((c) => c.id === DEFAULT.caseId) || cases[0];
  const roleEntry = caseEntry.roles.find((r) => r.id === wanted.roleId)
    || caseEntry.roles.find((r) => r.id === DEFAULT.roleId) || caseEntry.roles[0];
  await loadSession({ caseId: caseEntry.id, roleId: roleEntry.id, mode: wanted.mode || 'demo' });
  refreshPlaceholder();

  let seen = true;
  try {
    seen = Boolean(localStorage.getItem('sparring-partner:seen-help'));
    localStorage.setItem('sparring-partner:seen-help', '1');
  } catch { /* storage unavailable: skip the welcome */ }
  if (!seen) $('#help-dialog').showModal();
}

boot();
