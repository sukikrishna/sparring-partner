// Data access. Works in two deployments:
//  - served by the Python app: role-filtered data and model calls via /api
//  - static hosting (e.g. GitHub Pages): reads web/data/ directly, demo mode only

let backend = null; // health payload, or null when there is no backend

export async function detectBackend() {
  try {
    const res = await fetch('api/health', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    backend = await res.json();
  } catch {
    backend = null;
  }
  return backend;
}

export const hasBackend = () => backend !== null;
export const hasModel = () => Boolean(backend && backend.llm);
export const modelName = () => (backend && backend.model) || null;

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

export async function listCases() {
  return (await getJSON(hasBackend() ? 'api/cases' : 'data/cases/index.json')).cases;
}

/** The case as seen by one role: only documents that role may read. */
export async function loadCase(caseId, roleId) {
  if (hasBackend()) {
    return getJSON(`api/cases/${encodeURIComponent(caseId)}?role=${encodeURIComponent(roleId)}`);
  }
  // Static hosting: the full file is public, so filtering here is a convenience,
  // not a barrier. Use the Python server for studies where roles must not see
  // each other's documents.
  const full = await getJSON(`data/cases/${encodeURIComponent(caseId)}.json`);
  const role = full.roles.find((r) => r.id === roleId) || full.roles[0];
  return {
    id: full.id,
    title: full.title,
    summary: full.summary,
    role,
    roles: full.roles.map((r) => ({ id: r.id, name: r.name })),
    documents: full.documents.filter((d) => d.visible_to.includes(role.id)),
  };
}

let demoIndex = null;

/** The hand-written demo script for this case and role, if one exists. */
export async function loadDemoScript(caseId, roleId) {
  try {
    demoIndex ||= (await getJSON('data/demo/index.json')).scripts;
    const name = `${caseId}-${roleId}`;
    return demoIndex.includes(name) ? await getJSON(`data/demo/${name}.json`) : null;
  } catch {
    return null;
  }
}

async function post(path, body) {
  const res = await fetch(`api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch { /* ignore */ }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return res.json();
}

export const api = {
  gaps: (b) => post('gaps', b),
  docChat: (b) => post('chat/document', b),
  caseChat: (b) => post('chat/case', b),
  structure: (b) => post('structure', b),
  recheck: (b) => post('recheck', b),
};
