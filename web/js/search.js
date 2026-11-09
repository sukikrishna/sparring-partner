// Client-side BM25 over document paragraphs (mirrors sparring_partner/retrieval.py).
// Used when no backend model is available: answers become "here are the
// best-matching passages" instead of generated text.

const STOP = new Set(`a an and are as at be been but by can could did do does for from had has have he her his
how i if in into is it its me my no not of on or our she so than that the their them then there these they
this those to was we were what when where which who why will with would you your about after all also am any
because before being both each few further here more most other out over own same should some such through
too under until up very just`.split(/\s+/));

function stem(t) {
  if (t.endsWith('ies') && t.length >= 5) return t.slice(0, -3) + 'y';
  for (const [s, min] of [['ing', 6], ['ed', 5], ['es', 5], ['s', 4]]) {
    if (t.endsWith(s) && t.length >= min) return t.slice(0, -s.length);
  }
  return t;
}

export function tokenize(text) {
  const toks = (text || '').toLowerCase().replace(/’/g, "'").match(/[a-z0-9]+(?:'[a-z]+)?/g) || [];
  return toks.filter((t) => !STOP.has(t)).map(stem);
}

export class Index {
  constructor(documents) {
    this.passages = [];
    for (const d of documents) {
      d.paragraphs.forEach((text, i) => this.passages.push({ docId: d.id, title: d.title, paragraph: i + 1, text }));
    }
    this.tfs = this.passages.map((p) => {
      const tf = new Map();
      for (const t of tokenize(p.text + ' ' + p.title)) tf.set(t, (tf.get(t) || 0) + 1);
      return tf;
    });
    this.lens = this.tfs.map((tf) => [...tf.values()].reduce((a, b) => a + b, 0));
    this.avg = this.lens.reduce((a, b) => a + b, 0) / (this.lens.length || 1);
    const df = new Map();
    for (const tf of this.tfs) for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    const n = this.passages.length;
    this.idf = new Map([...df].map(([t, f]) => [t, Math.log(1 + (n - f + 0.5) / (f + 0.5))]));
  }

  search(query, k = 6, minChars = 25) {
    const q = new Set(tokenize(query));
    if (!q.size) return [];
    const k1 = 1.4, b = 0.75, out = [];
    this.passages.forEach((p, i) => {
      if (p.text.length < minChars) return;
      let score = 0;
      for (const t of q) {
        const f = this.tfs[i].get(t);
        if (!f) continue;
        score += this.idf.get(t) * f * (k1 + 1) / (f + k1 * (1 - b + b * this.lens[i] / this.avg));
      }
      if (score > 0) out.push({ ...p, score });
    });
    return out.sort((x, y) => y.score - x.score).slice(0, k);
  }
}

export function excerpt(text, limit = 200) {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1).replace(/\s+\S*$/, '') + '…';
}
