'use strict';
// Desa el guió editat a l'editor visual sense perdre els comentaris ni el format
// del show.yaml: els elements que no han canviat es conserven tal com eren (amb
// els seus comentaris) i només es reescriuen els que s'han modificat.

const YAML = require('yaml');

// JSON amb les claus ordenades, per comparar sense que importi l'ordre.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

const same = (a, b) => canonical(a) === canonical(b);

let currentDoc = null;
function nodeJS(node) {
  if (node && typeof node.toJS === 'function') return node.toJS(currentDoc); // resol àlies
  return node && typeof node.toJSON === 'function' ? node.toJSON() : node;
}

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Actualitza un mapa clau a clau: els comentaris de les claus que no canvien es conserven.
function mergeMap(doc, node, obj) {
  for (const pair of node.items.slice()) {
    const k = nodeJS(pair.key);
    if (!(k in obj)) node.delete(k);
  }
  for (const key of Object.keys(obj)) {
    const cur = node.get(key, true);
    if (same(nodeJS(cur), obj[key])) continue;
    if (YAML.isMap(cur) && plain(obj[key])) mergeMap(doc, cur, obj[key]);
    else node.set(key, doc.createNode(obj[key]));
  }
}

function mergeSeq(doc, key, list) {
  const old = doc.get(key, true);
  const oldItems = old && YAML.isSeq(old) ? old.items : [];
  const used = new Set();
  const items = list.map((item) => {
    const match = oldItems.find((n) => !used.has(n) && same(nodeJS(n), item));
    if (match) {
      used.add(match);
      return match;
    }
    // El mateix element (per id) modificat: s'actualitza clau a clau (conserva format i comentaris).
    const prev = item && item.id != null
      ? oldItems.find((n) => !used.has(n) && YAML.isMap(n) && String(n.get('id')) === String(item.id)) : null;
    if (prev && plain(item)) {
      used.add(prev);
      mergeMap(doc, prev, item);
      return prev;
    }
    const node = doc.createNode(item);
    node.flow = key === 'participants';
    node.spaceBefore = key === 'cues';
    return node;
  });
  if (old && YAML.isSeq(old)) old.items = items;
  else doc.set(key, doc.createNode(list));
  if (old && YAML.isSeq(old) && !old.items.length) old.flow = true;
}

/**
 * @param {string} text  show.yaml actual
 * @param {object} raw   guió editat (claus en català, com al fitxer)
 * @returns {string} show.yaml nou
 */
function mergeShow(text, raw) {
  try {
    if (same(YAML.parse(text || ''), raw)) return text; // sense canvis: el fitxer queda igual
  } catch (err) {
    // YAML il·legible: es reescriu sencer
  }
  const doc = YAML.parseDocument(text || '');
  currentDoc = doc;
  if (!doc.contents || !YAML.isMap(doc.contents)) doc.contents = doc.createNode({});
  for (const pair of doc.contents.items.slice()) {
    const k = nodeJS(pair.key);
    if (!(k in raw)) doc.delete(k);
  }
  for (const key of Object.keys(raw)) {
    if ((key === 'participants' || key === 'cues') && Array.isArray(raw[key])) {
      mergeSeq(doc, key, raw[key]);
    } else if (!same(nodeJS(doc.get(key, true)), raw[key])) {
      const cur = doc.get(key, true);
      if (YAML.isMap(cur) && plain(raw[key])) mergeMap(doc, cur, raw[key]);
      else doc.set(key, doc.createNode(raw[key]));
    }
  }
  return doc.toString({ lineWidth: 0 });
}

module.exports = { mergeShow, canonical };
