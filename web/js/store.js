// Application state, persistence (per case/role/mode in localStorage) and the
// interaction event log used for exports and user studies.

import { uid } from './util.js';

const VERSION = 2;

export const state = {
  // session identity
  sessionId: uid('session'),
  mode: 'demo', // 'demo' | 'live'
  caseId: null,
  roleId: null,

  // loaded data (not persisted)
  caseData: null,
  docsById: {},
  demo: null,

  // human-only
  notesHTML: '',
  notesSubmittedText: '',

  // gaps
  gaps: [], // {id, n, quote, title, question, assumption, lens, doc_ids, severity, status, statusNote}
  gapCounter: 0,
  gapsChecked: false,
  selectedGapId: null,

  // right column
  rightTab: 'gaps', // 'gaps' | 'library' | 'ask'
  libraryDocId: null,
  gapDocId: {}, // gapId -> docId currently open for that gap
  libraryFilter: '',

  // chats: threadKey -> [{id, role, text, cites, citations, keyFinding, followUps, insightId, pending, error}]
  threads: {},

  // synthesis board
  insights: [], // {id, text, author:'human'|'ai', origin:{type, docId, cites, citations, threadKey}, gapId, createdAt}
  autoAdd: true,
  leftTab: 'board', // 'board' | 'structured'
  expanded: { general: true },
  includeInsights: true,
  structured: null, // {view, notesHash, generatedAt, source}

  events: [],
};

const PERSISTED = [
  'sessionId', 'notesHTML', 'notesSubmittedText', 'gaps', 'gapCounter', 'gapsChecked', 'selectedGapId',
  'rightTab', 'libraryDocId', 'gapDocId', 'threads', 'insights', 'autoAdd', 'leftTab', 'expanded',
  'includeInsights', 'structured', 'events',
];

const storageKey = () => `sparring-partner:v${VERSION}:${state.caseId}:${state.roleId}:${state.mode}`;

function storage() {
  try { return window.localStorage; } catch { return null; }
}

export function save() {
  const s = storage();
  if (!s || !state.caseId) return;
  const data = {};
  for (const k of PERSISTED) data[k] = state[k];
  try { s.setItem(storageKey(), JSON.stringify(data)); } catch { /* quota or privacy mode */ }
}

/** Restore a saved session for the current case/role/mode. Returns true if found. */
export function restore() {
  const s = storage();
  if (!s) return false;
  let raw = null;
  try { raw = s.getItem(storageKey()); } catch { return false; }
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    for (const k of PERSISTED) if (k in data) state[k] = data[k];
    // Chats that were waiting when the page closed will never resolve.
    for (const msgs of Object.values(state.threads)) {
      for (const m of msgs) if (m.pending) { m.pending = false; m.error = 'Interrupted before an answer arrived.'; }
    }
    return true;
  } catch {
    return false;
  }
}

/** Reset in-memory session state. With clearStorage, also forget the saved copy. */
export function resetSession({ clearStorage = false } = {}) {
  if (clearStorage) {
    const s = storage();
    try { s && s.removeItem(storageKey()); } catch { /* ignore */ }
  }
  Object.assign(state, {
    sessionId: uid('session'),
    notesHTML: '', notesSubmittedText: '',
    gaps: [], gapCounter: 0, gapsChecked: false, selectedGapId: null,
    rightTab: 'gaps', libraryDocId: null, gapDocId: {}, libraryFilter: '',
    threads: {}, insights: [], autoAdd: true, leftTab: 'board', expanded: { general: true },
    includeInsights: true, structured: null, events: [],
  });
}

// ---------------------------------------------------------------- rendering

const renderers = {};
export function registerRenderer(name, fn) { renderers[name] = fn; }

/** Re-render the named parts (default: both side columns) and persist. */
export function changed(...parts) {
  const list = parts.length ? parts : ['left', 'right'];
  for (const p of list) renderers[p] && renderers[p]();
  renderers.steps && renderers.steps();
  save();
}

// ---------------------------------------------------------------- event log

export function log(type, data = {}) {
  state.events.push({ t: new Date().toISOString(), type, ...data });
  if (state.events.length > 5000) state.events.splice(0, state.events.length - 5000);
}

// ---------------------------------------------------------------- selectors

export const gapById = (id) => state.gaps.find((g) => g.id === id) || null;
export const openGaps = () => state.gaps.filter((g) => g.status === 'open');
export const doc = (id) => state.docsById[id] || null;
export const thread = (key) => (state.threads[key] ||= []);

export function threadKey({ gapId = null, docId = null, scope = 'doc' }) {
  if (scope === 'case') return 'case';
  return `${gapId || 'library'}::${docId}`;
}

// ---------------------------------------------------------------- insights

export function addInsight({ text, author, origin = {}, gapId = null }) {
  const insight = { id: uid('ins'), text, author, origin, gapId, createdAt: new Date().toISOString() };
  state.insights.push(insight);
  if (gapId) state.expanded[gapId] = true; else state.expanded.general = true;
  log('insight_added', { insightId: insight.id, author, originType: origin.type, gapId });
  return insight;
}

export function removeInsight(id) {
  state.insights = state.insights.filter((i) => i.id !== id);
  for (const msgs of Object.values(state.threads)) for (const m of msgs) if (m.insightId === id) m.insightId = null;
  log('insight_removed', { insightId: id });
}

export function moveInsight(id, gapId) {
  const ins = state.insights.find((i) => i.id === id);
  if (!ins) return;
  ins.gapId = gapId || null;
  log('insight_moved', { insightId: id, gapId: ins.gapId });
}

export function exportSession(notesText) {
  return {
    format: 'sparring-partner-session',
    version: VERSION,
    exported_at: new Date().toISOString(),
    session_id: state.sessionId,
    mode: state.mode,
    case_id: state.caseId,
    role_id: state.roleId,
    notes: notesText,
    gaps: state.gaps,
    insights: state.insights,
    threads: state.threads,
    structured: state.structured,
    events: state.events,
  };
}
