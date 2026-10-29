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

function nodeJS(node) {
  return node && typeof node.toJSON === 'function' ? node.toJSON() : node;
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
    // El mateix element (per id) modificat: node nou amb el format i els comentaris de l'anterior.
    const prev = item && item.id != null
      ? oldItems.find((n) => !used.has(n) && YAML.isMap(n) && String(n.get('id')) === String(item.id)) : null;
    const node = doc.createNode(item);
    if (prev) {
      used.add(prev);
      node.flow = prev.flow;
      node.commentBefore = prev.commentBefore;
      node.comment = prev.comment;
      node.spaceBefore = prev.spaceBefore;
    } else {
      node.flow = key === 'participants';
      node.spaceBefore = key === 'cues';
    }
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
  if (!doc.contents || !YAML.isMap(doc.contents)) doc.contents = doc.createNode({});
  for (const pair of doc.contents.items.slice()) {
    const k = nodeJS(pair.key);
    if (!(k in raw)) doc.delete(k);
  }
  for (const key of Object.keys(raw)) {
    if ((key === 'participants' || key === 'cues') && Array.isArray(raw[key])) {
      mergeSeq(doc, key, raw[key]);
    } else if (!same(nodeJS(doc.get(key, true)), raw[key])) {
      doc.set(key, doc.createNode(raw[key]));
    }
  }
  return doc.toString({ lineWidth: 0 });
}

module.exports = { mergeShow, canonical };
