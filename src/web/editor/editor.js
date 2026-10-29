'use strict';
// Editor visual del guió: edita el show.yaml amb formularis, el revisa mentre
// s'escriu i el desa (amb còpia de seguretat) aplicant-lo al moment.

(function () {
  const $ = (id) => document.getElementById(id);
  const el = Gala.el;
  const S = window.EditorSchema;
  const LETTERS = 'ABCD';
  const VALIDATE_MS = 500;

  let raw = null; // guió editat (claus en català)
  let mtime = null;
  let dirty = false;
  let selected = 'general'; // general | participants | índex de cue
  let problems = [];
  let validateTimer = null;

  const pin = new URLSearchParams(location.search).get('pin');
  const socket = new Gala.GalaSocket('control', {
    pin,
    onState: (s) => {
      $('live-banner').classList.toggle('hidden', !(s.state && s.state.started && !s.state.ended && s.mode !== 'assaig'));
      if (raw === null) load();
    },
  });

  function toast(msg, kind) {
    const node = el('div', { class: 'toast ' + (kind || ''), text: msg });
    $('toasts').append(node);
    setTimeout(() => node.remove(), 4000);
  }

  function setStatus(text, kind) {
    $('status').textContent = text;
    $('status').className = 'pill ' + (kind || '');
  }

  function markDirty() {
    dirty = true;
    setStatus('Canvis sense desar', 'warn');
    clearTimeout(validateTimer);
    validateTimer = setTimeout(validate, VALIDATE_MS);
  }

  async function load() {
    const r = await socket.cmd({ name: 'show.get' });
    if (!r.ok) {
      setStatus('Error', 'bad');
      toast(r.error);
      return;
    }
    raw = r.raw;
    if (!Array.isArray(raw.cues)) raw.cues = [];
    if (!Array.isArray(raw.participants)) raw.participants = [];
    mtime = r.mtime;
    dirty = false;
    fillDatalists(r.media);
    setProblems(r.problems);
    setStatus('Desat', 'ok');
    $('conflict').classList.add('hidden');
    render();
  }

  function fillDatalists(media) {
    const byExt = (exts) => media.files.filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)));
    const fill = (id, list) => {
      $(id).textContent = '';
      list.forEach((f) => $(id).append(el('option', { value: f })));
    };
    fill('dl-video', byExt(S.EXT.video));
    fill('dl-image', byExt(S.EXT.image));
    fill('dl-audio', byExt(S.EXT.audio));
    fill('dl-folder', media.dirs);
  }

  async function validate() {
    if (!raw) return;
    const r = await socket.cmd({ name: 'show.validate', raw });
    if (r.ok) setProblems(r.problems);
  }

  async function save(force) {
    if (!raw) return;
    clearTimeout(validateTimer);
    setStatus('Desant…');
    const r = await socket.cmd({ name: 'show.save', raw, mtime, force: !!force });
    if (r.conflict) {
      $('conflict').classList.remove('hidden');
      setStatus('Conflicte', 'bad');
      return;
    }
    if (r.problems) setProblems(r.problems);
    if (!r.ok) {
      setStatus('No desat', 'bad');
      toast(r.error || 'No s\'ha pogut desar');
      return;
    }
    mtime = r.mtime;
    dirty = false;
    $('conflict').classList.add('hidden');
    setStatus('Desat i aplicat', 'ok');
    toast('Guió desat i aplicat (còpia anterior a dades/guio-copies)', 'info');
  }

  $('btn-save').addEventListener('click', () => save(false));
  $('btn-overwrite').addEventListener('click', () => save(true));
  $('btn-reload-file').addEventListener('click', load);
  $('btn-discard').addEventListener('click', () => {
    if (!dirty || $('btn-discard').classList.contains('armed')) {
      $('btn-discard').classList.remove('armed');
      $('btn-discard').textContent = 'Descartar canvis';
      load();
      return;
    }
    $('btn-discard').classList.add('armed');
    $('btn-discard').textContent = 'Segur? Clica de nou';
    setTimeout(() => {
      $('btn-discard').classList.remove('armed');
      $('btn-discard').textContent = 'Descartar canvis';
    }, 3000);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save(false);
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // --- Revisió ---
  function setProblems(list) {
    problems = list || [];
    const errors = problems.filter((p) => p.level === 'error').length;
    const warns = problems.length - errors;
    $('problem-count').textContent = errors || warns ? '– ' + errors + ' errors, ' + warns + ' avisos' : '– cap problema';
    $('problem-count').className = errors ? 'bad' : warns ? 'warn' : 'ok';
    const ul = $('problems');
    ul.textContent = '';
    problems.forEach((p) => {
      const li = el('li', { class: p.level, text: (p.cueId ? '[' + p.cueId + '] ' : '') + p.msg });
      if (p.cueId) {
        li.addEventListener('click', () => {
          const i = raw.cues.findIndex((c) => String(c.id) === p.cueId);
          if (i >= 0) select(i);
        });
      }
      ul.append(li);
    });
    $('btn-save').disabled = errors > 0;
    $('btn-save').title = errors ? 'Corregeix els errors per poder desar' : 'Ctrl+S';
    renderCueList();
  }

  // --- Navegació ---
  function select(sel) {
    selected = sel;
    render();
  }
  Array.from(document.querySelectorAll('.nav-item')).forEach((b) => b.addEventListener('click', () => select(b.dataset.sel)));

  Object.keys(S.TYPES).forEach((t) => $('new-type').append(el('option', { value: t, text: S.TYPES[t].label })));
  $('btn-add-cue').addEventListener('click', () => {
    const tipus = $('new-type').value;
    const cue = { id: uniqueId(tipus), tipus, titol: 'Nova ' + S.TYPES[tipus].label.toLowerCase() };
    if (tipus === 'votacio') cue.opcions = [{ text: 'Opció A', va_a: '' }, { text: 'Opció B', va_a: '' }];
    if (tipus === 'questionari') cue.preguntes = [{ pregunta: '', opcions: ['', '', '', ''], correcta: 'A' }];
    const at = typeof selected === 'number' ? selected + 1 : raw.cues.length;
    raw.cues.splice(at, 0, cue);
    markDirty();
    select(at);
  });

  function uniqueId(base) {
    const ids = new Set(raw.cues.map((c) => String(c.id)));
    let n = 1;
    while (ids.has(base + n)) n += 1;
    return base + n;
  }

  function problemLevel(cueId) {
    const mine = problems.filter((p) => p.cueId === String(cueId));
    return mine.some((p) => p.level === 'error') ? 'error' : mine.length ? 'warn' : '';
  }

  function renderCueList() {
    if (!raw) return;
    $('n-participants').textContent = '(' + raw.participants.length + ')';
    Array.from(document.querySelectorAll('.nav-item')).forEach((b) => b.classList.toggle('on', b.dataset.sel === selected));
    const ol = $('cue-list');
    ol.textContent = '';
    raw.cues.forEach((c, i) => {
      const type = S.TYPES[c.tipus];
      const level = problemLevel(c.id);
      const li = el('li', { class: (selected === i ? 'on ' : '') + level }, [
        el('span', { class: 'n', text: String(i + 1) }),
        el('span', { class: 't' }, [
          el('span', { class: 'type', text: type ? type.label : String(c.tipus) }),
          el('span', { text: c.titol || c.id }),
        ]),
        level ? el('span', { class: 'dot ' + level }) : null,
      ]);
      li.addEventListener('click', () => select(i));
      ol.append(li);
    });
  }

  // --- Camps ---
  function setKey(obj, key, value, def) {
    const empty = value === '' || value == null || (Array.isArray(value) && value.length === 0);
    if (empty || (def !== undefined && value === def)) delete obj[key];
    else obj[key] = value;
    markDirty();
  }

  function cueOptions(includeEmpty, emptyLabel) {
    const opts = includeEmpty ? [el('option', { value: '', text: emptyLabel || '— (la de sota)' })] : [];
    raw.cues.forEach((c) => opts.push(el('option', { value: String(c.id), text: c.id + (c.titol ? ' – ' + c.titol : '') })));
    return opts;
  }

  function input(field, value, onChange) {
    let node;
    if (field.type === 'textarea') {
      node = el('textarea', { rows: 3 });
      node.value = value == null ? '' : String(value);
      node.addEventListener('input', () => onChange(node.value));
    } else if (field.type === 'bool') {
      node = el('input', { type: 'checkbox' });
      node.checked = value == null ? !!field.default : !!value;
      node.addEventListener('change', () => onChange(node.checked));
    } else if (field.type === 'number') {
      node = el('input', { type: 'number', min: field.min, max: field.max, step: field.step || 1, placeholder: field.default != null ? String(field.default) : '' });
      node.value = value == null ? '' : String(value);
      node.addEventListener('input', () => onChange(node.value === '' ? '' : Number(node.value)));
    } else if (field.type === 'select') {
      node = el('select');
      field.options.forEach(([v, t]) => node.append(el('option', { value: v, text: t })));
      node.value = value == null ? field.default : String(value);
      node.addEventListener('change', () => onChange(node.value));
    } else if (field.type === 'cue') {
      node = el('select', {}, cueOptions(true, field.required ? '— tria una cue —' : null));
      node.value = value == null ? '' : String(value);
      node.addEventListener('change', () => onChange(node.value));
    } else {
      const list = field.type === 'folder' ? 'dl-folder' : field.type === 'file' ? 'dl-' + field.accept : null;
      node = el('input', { type: 'text', list, placeholder: field.placeholder || (list ? 'Escriu o tria un fitxer…' : '') });
      node.value = value == null ? '' : String(value);
      node.addEventListener('input', () => onChange(node.value.trim() === '' ? '' : node.value));
    }
    return node;
  }

  function row(field, control) {
    return el('label', { class: 'row' + (field.required ? ' required' : '') }, [
      el('span', { class: 'lbl', text: field.label }),
      control,
      field.help ? el('span', { class: 'help', text: field.help }) : null,
    ]);
  }

  function simpleField(obj, field, onAfter) {
    return row(field, input(field, obj[field.key], (v) => {
      setKey(obj, field.key, v, field.default);
      if (onAfter) onAfter(v);
    }));
  }

  function moveButtons(list, i, rerender) {
    const mk = (text, title, fn, disabled) => {
      const b = el('button', { class: 'mini', text, title, type: 'button' });
      b.disabled = !!disabled;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        fn();
        markDirty();
        rerender();
      });
      return b;
    };
    return [
      mk('↑', 'Pujar', () => list.splice(i - 1, 0, list.splice(i, 1)[0]), i === 0),
      mk('↓', 'Baixar', () => list.splice(i + 1, 0, list.splice(i, 1)[0]), i === list.length - 1),
      mk('✕', 'Treure', () => list.splice(i, 1)),
    ];
  }

  // Canviar l'id d'una cue actualitza totes les referències.
  function renameCue(oldId, newId) {
    if (!oldId || oldId === newId) return;
    raw.cues.forEach((c) => {
      ['seguent', 'si_exit', 'si_no'].forEach((k) => { if (c[k] === oldId) c[k] = newId; });
      (c.opcions || []).forEach((o) => { if (o && o.va_a === oldId) o.va_a = newId; });
    });
  }

  function renameParticipant(oldId, newId) {
    if (!oldId || oldId === newId) return;
    raw.cues.forEach((c) => {
      if (Array.isArray(c.ordre)) c.ordre = c.ordre.map((x) => (String(x) === oldId ? newId : x));
      if (c.mencions && c.mencions[oldId] != null) {
        c.mencions[newId] = c.mencions[oldId];
        delete c.mencions[oldId];
      }
    });
  }

  function optionsEditor(cue) {
    if (!Array.isArray(cue.opcions)) cue.opcions = [];
    const box = el('div', { class: 'sublist' });
    const draw = () => {
      box.textContent = '';
      cue.opcions.forEach((o, i) => {
        const text = el('input', { type: 'text', placeholder: 'Text de l\'opció' });
        text.value = o.text || '';
        text.addEventListener('input', () => { o.text = text.value; markDirty(); });
        const goto = el('select', {}, cueOptions(true, '— va a… —'));
        goto.value = o.va_a || '';
        goto.addEventListener('change', () => { o.va_a = goto.value; markDirty(); });
        box.append(el('div', { class: 'subrow' }, [el('b', { text: LETTERS[i] || String(i + 1) }), text, el('span', { text: '→' }), goto]
          .concat(moveButtons(cue.opcions, i, () => { draw(); renderPerDefault(); }))));
      });
      const add = el('button', { class: 'mini', text: '+ Opció', type: 'button' });
      add.disabled = cue.opcions.length >= 4;
      add.addEventListener('click', () => { cue.opcions.push({ text: '', va_a: '' }); markDirty(); draw(); renderPerDefault(); });
      box.append(add);
    };
    let renderPerDefault = () => {};
    box.setPerDefault = (fn) => { renderPerDefault = fn; };
    draw();
    return box;
  }

  function questionsEditor(cue) {
    if (!Array.isArray(cue.preguntes)) cue.preguntes = [];
    const box = el('div', { class: 'sublist' });
    const draw = () => {
      box.textContent = '';
      cue.preguntes.forEach((q, i) => {
        if (!Array.isArray(q.opcions)) q.opcions = [];
        while (q.opcions.length < 4) q.opcions.push('');
        const card = el('div', { class: 'qcard' });
        const head = el('div', { class: 'subrow' }, [el('b', { text: 'Pregunta ' + (i + 1) })].concat(moveButtons(cue.preguntes, i, draw)));
        const text = el('input', { type: 'text', placeholder: 'Pregunta' });
        text.value = q.pregunta || '';
        text.addEventListener('input', () => { q.pregunta = text.value; markDirty(); });
        const opts = el('div', { class: 'qopts' });
        q.opcions.slice(0, 4).forEach((o, k) => {
          const inp = el('input', { type: 'text', placeholder: 'Opció ' + LETTERS[k] + (k > 1 ? ' (opcional)' : '') });
          inp.value = o || '';
          inp.addEventListener('input', () => { q.opcions[k] = inp.value; markDirty(); });
          opts.append(el('label', {}, [el('b', { text: LETTERS[k] }), inp]));
        });
        const correct = el('select', {}, LETTERS.split('').map((L) => el('option', { value: L, text: 'Correcta: ' + L })));
        correct.value = typeof q.correcta === 'number' ? LETTERS[q.correcta] : String(q.correcta || 'A').toUpperCase();
        correct.addEventListener('change', () => { q.correcta = correct.value; markDirty(); });
        const time = el('input', { type: 'number', min: 1, placeholder: 'temps (s)' });
        time.value = q.temps == null ? '' : q.temps;
        time.addEventListener('input', () => { setKey(q, 'temps', time.value === '' ? '' : Number(time.value)); });
        const img = el('input', { type: 'text', list: 'dl-image', placeholder: 'Imatge (opcional)' });
        img.value = q.imatge || '';
        img.addEventListener('input', () => setKey(q, 'imatge', img.value.trim()));
        card.append(head, text, opts, el('div', { class: 'subrow' }, [correct, time, img]));
        box.append(card);
      });
      const add = el('button', { class: 'mini', text: '+ Pregunta', type: 'button' });
      add.addEventListener('click', () => { cue.preguntes.push({ pregunta: '', opcions: ['', '', '', ''], correcta: 'A' }); markDirty(); draw(); });
      box.append(add);
    };
    draw();
    return box;
  }

  // Les opcions buides de les preguntes no s'han d'escriure al fitxer.
  function cleanForSave() {
    raw.cues.forEach((c) => {
      (c.preguntes || []).forEach((q) => {
        if (Array.isArray(q.opcions)) {
          while (q.opcions.length && !String(q.opcions[q.opcions.length - 1] || '').trim()) q.opcions.pop();
        }
      });
    });
  }

  function diplomaEditor(cue) {
    const d = cue.diploma && typeof cue.diploma === 'object' ? cue.diploma : {};
    const commit = () => {
      if (Object.keys(d).length) cue.diploma = d;
      else delete cue.diploma;
      markDirty();
    };
    const fields = [
      { key: 'titol', label: 'Títol', type: 'text', placeholder: 'Diploma' },
      { key: 'text', label: 'Text abans del nom', type: 'text', placeholder: 's\'atorga a' },
      { key: 'peu', label: 'Peu', type: 'text', placeholder: 'Títol de la gala' },
      { key: 'data', label: 'Data', type: 'text', placeholder: 'Juny de 2027' },
    ];
    const box = el('div', { class: 'sublist' });
    fields.forEach((f) => box.append(row(f, input(f, d[f.key], (v) => {
      if (v === '' || v == null) delete d[f.key];
      else d[f.key] = v;
      commit();
    }))));
    const sig = { label: 'Signatures (separades per comes)', type: 'text', placeholder: 'La tutora, La direcció' };
    box.append(row(sig, input(sig, Array.isArray(d.signatures) ? d.signatures.join(', ') : '', (v) => {
      const list = String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (list.length) d.signatures = list;
      else delete d.signatures;
      commit();
    })));
    return box;
  }

  function cueField(cue, field) {
    if (field.type === 'options') {
      const editor = optionsEditor(cue);
      return row(field, editor);
    }
    if (field.type === 'questions') return row(field, questionsEditor(cue));
    if (field.type === 'diploma') return row(field, diplomaEditor(cue));
    if (field.type === 'optionIndex') {
      const sel = el('select');
      const fill = () => {
        sel.textContent = '';
        (cue.opcions || []).forEach((o, i) => sel.append(el('option', { value: String(i), text: (LETTERS[i] || i) + '. ' + (o.text || '') })));
        sel.value = String(cue[field.key] != null ? cue[field.key] : field.default);
      };
      fill();
      sel.addEventListener('change', () => setKey(cue, field.key, Number(sel.value), field.default));
      return row(field, sel);
    }
    if (field.type === 'ids') {
      const f = Object.assign({}, field, { type: 'text', placeholder: raw.participants.map((p) => p.id).slice(0, 4).join(', ') + '…' });
      return row(f, input(f, Array.isArray(cue[field.key]) ? cue[field.key].join(', ') : '', (v) => {
        setKey(cue, field.key, String(v || '').split(',').map((x) => x.trim()).filter(Boolean));
      }));
    }
    if (field.key === 'id') {
      return simpleField(cue, field, () => {});
    }
    return simpleField(cue, field, field.key === 'titol' ? renderCueList : null);
  }

  // --- Formularis ---
  function renderGeneral(form) {
    form.append(el('h2', { text: 'General' }));
    S.GENERAL.forEach((f) => form.append(simpleField(raw, f)));
    if (!raw.xarxa || typeof raw.xarxa !== 'object') raw.xarxa = {};
    form.append(el('h3', { text: 'Xarxa' }));
    S.NETWORK.forEach((f) => form.append(row(f, input(f, raw.xarxa[f.key], (v) => {
      const val = f.key.startsWith('pin_') && v !== '' ? String(v) : v;
      setKey(raw.xarxa, f.key, val, f.default);
    }))));
  }

  function renderParticipants(form) {
    form.append(el('h2', { text: 'Participants (' + raw.participants.length + ')' }));
    form.append(el('p', { class: 'help', text: 'L\'id no ha de tenir espais (s\'usa per a les carpetes de fonts dels vídeos d\'entrada i per a l\'ordre). Els fitxers són relatius a la carpeta show/.' }));
    const table = el('table', { class: 'people' });
    table.append(el('tr', {}, S.PARTICIPANT.map((f) => el('th', { text: f.label })).concat([el('th')])));
    raw.participants.forEach((p, i) => {
      const cells = S.PARTICIPANT.map((f) => {
        const node = input(f, p[f.key], (v) => {
          const old = p.id;
          setKey(p, f.key, v);
          if (f.key === 'id') renameParticipant(String(old), String(v));
        });
        if (f.width) node.style.width = f.width + 'px';
        return el('td', {}, [node]);
      });
      table.append(el('tr', {}, cells.concat([el('td', { class: 'nowrap' }, moveButtons(raw.participants, i, render))])));
    });
    form.append(table);
    const add = el('button', { text: '+ Afegir participant', type: 'button' });
    add.addEventListener('click', () => {
      const ids = new Set(raw.participants.map((p) => String(p.id)));
      let n = raw.participants.length + 1;
      while (ids.has('nen' + n)) n += 1;
      raw.participants.push({ id: 'nen' + n, nom: 'Nen ' + n });
      markDirty();
      render();
    });
    form.append(add);
  }

  function renderCue(form, i) {
    const cue = raw.cues[i];
    const type = S.TYPES[cue.tipus];
    const actions = el('div', { class: 'actions' });
    const mk = (text, fn, cls) => {
      const b = el('button', { text, type: 'button', class: cls || '' });
      b.addEventListener('click', fn);
      actions.append(b);
      return b;
    };
    mk('↑ Pujar', () => { if (i > 0) { raw.cues.splice(i - 1, 0, raw.cues.splice(i, 1)[0]); markDirty(); select(i - 1); } });
    mk('↓ Baixar', () => { if (i < raw.cues.length - 1) { raw.cues.splice(i + 1, 0, raw.cues.splice(i, 1)[0]); markDirty(); select(i + 1); } });
    mk('⧉ Duplicar', () => {
      const copy = JSON.parse(JSON.stringify(cue));
      copy.id = uniqueId(String(cue.id) + '_');
      raw.cues.splice(i + 1, 0, copy);
      markDirty();
      select(i + 1);
    });
    const del = mk('✕ Eliminar', () => {
      if (!del.classList.contains('armed')) {
        del.classList.add('armed');
        del.textContent = 'Segur? Clica de nou';
        setTimeout(() => { del.classList.remove('armed'); del.textContent = '✕ Eliminar'; }, 3000);
        return;
      }
      raw.cues.splice(i, 1);
      markDirty();
      select(Math.min(i, raw.cues.length - 1) >= 0 ? Math.min(i, raw.cues.length - 1) : 'general');
    }, 'danger');
    form.append(el('h2', {}, [(type ? type.label : 'Tipus desconegut') + ' · ', el('span', { text: cue.titol || cue.id })]), actions);
    if (!type) {
      form.append(el('p', { class: 'help', text: 'Tipus «' + cue.tipus + '» desconegut: edita aquesta cue directament al show.yaml.' }));
      return;
    }
    const idField = S.COMMON_START[0];
    const idInput = input(idField, cue.id, () => {});
    idInput.addEventListener('change', () => {
      const newId = idInput.value.trim();
      if (!newId) { idInput.value = cue.id; return; }
      const old = String(cue.id);
      cue.id = newId;
      renameCue(old, newId);
      markDirty();
      renderCueList();
    });
    form.append(row(idField, idInput));
    form.append(simpleField(cue, S.COMMON_START[1], renderCueList));
    const optionsRow = [];
    type.fields.forEach((f) => {
      const r = cueField(cue, f);
      form.append(r);
      if (f.type === 'options') optionsRow.push(r);
    });
    // Si canvien les opcions d'una votació, es refà el desplegable «si ningú vota».
    if (optionsRow.length) {
      const editor = optionsRow[0].querySelector('.sublist');
      editor.setPerDefault(() => render());
    }
    // A les votacions i els reptes, on es va ho decideixen les opcions.
    S.COMMON_END.forEach((f) => {
      if (f.key === 'seguent' && (cue.tipus === 'votacio' || cue.tipus === 'repte')) return;
      form.append(cueField(cue, f));
    });
    const mine = problems.filter((p) => p.cueId === String(cue.id));
    if (mine.length) {
      form.append(el('ul', { class: 'cue-problems' }, mine.map((p) => el('li', { class: p.level, text: p.msg }))));
    }
  }
  function render() {
    renderCueList();
    const form = $('form');
    form.textContent = '';
    if (selected === 'general') renderGeneral(form);
    else if (selected === 'participants') renderParticipants(form);
    else if (raw.cues[selected]) renderCue(form, selected);
    else renderGeneral(form);
  }

  // Abans d'enviar (validar o desar), treure les opcions buides de les preguntes.
  const originalCmd = socket.cmd.bind(socket);
  socket.cmd = (cmd) => {
    if (cmd.name === 'show.validate' || cmd.name === 'show.save') cleanForSave();
    return originalCmd(cmd);
  };
})();
