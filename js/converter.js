/*
 * Radiology Report Template Converter — core engine.
 *
 * Converts radiology report *templates* (a.k.a. AutoText / report templates)
 * between dictation-platform file formats, in any direction.
 *
 * Supported formats:
 *   - psone : Nuance PowerScribe One  "PortalAutoTextExport" XML
 *   - ps360 : Nuance PowerScribe 360   RTF (RichEdit) with embedded {\xml} autotext
 *   - mrrt  : IHE MRRT report template (HTML)
 *   - text  : plain text (lossy preview / generic export)
 *
 * Everything is parsed into one Intermediate Representation (IR) and every
 * output format is generated from that IR, so N parsers + M serializers give
 * N x M conversions.
 *
 *   IR Template = { name, nodes:[ Node ], meta:{} }
 *   Node        = { kind:'text', text }            // literal text, may contain \n
 *               | { kind:'field', field:Field }
 *   Field       = { type, name, value, defaultValue, choices:[Choice], props:{},
 *                   mergeId, mergeName }
 *   Choice      = { name, text, autotextId, autotextName }
 *
 * Field types (Nuance numbering, shared by psone & ps360):
 *   1 = free-text field        (value = inline token, defaultValue = expansion)
 *   2 = data / measurement field
 *   3 = pick list              (choices)
 *   4 = merge field            (system field, mergeId / mergeName)
 *
 * Runs in the browser (uses DOMParser / no build step).
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  // Windows-1252 high range (0x80-0x9F) -> Unicode, for RTF \'hh decoding.
  var CP1252 = {
    0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
    0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
    0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
    0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
    0x9E: 0x017E, 0x9F: 0x0178
  };

  function escXml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escRtf(s) {
    var out = '';
    s = String(s == null ? '' : s);
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      var code = s.charCodeAt(i);
      if (ch === '\\') out += '\\\\';
      else if (ch === '{') out += '\\{';
      else if (ch === '}') out += '\\}';
      else if (ch === '\n') out += '\\par\n';
      else if (ch === '\r') { /* drop */ }
      else if (ch === '\t') out += '\\tab ';
      else if (code > 127) {
        if (code < 256) out += "\\'" + code.toString(16).padStart(2, '0');
        else out += '\\u' + code + '?';
      } else out += ch;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // RTF -> plain text (used to recover the plain-text coordinate space that the
  // embedded {\xml} field offsets are measured against).
  // ---------------------------------------------------------------------------

  var RTF_DEST = {
    fonttbl: 1, colortbl: 1, stylesheet: 1, generator: 1, info: 1, pict: 1,
    object: 1, themedata: 1, colorschememapping: 1, latentstyles: 1,
    datastore: 1, listtable: 1, listoverridetable: 1, rsidtbl: 1, mmathPr: 1,
    fldinst: 1, xmlnstbl: 1
  };
  var RTF_BREAK = { par: 1, line: 1, sect: 1, row: 1, lbr: 1 };

  function rtfToText(rtf) {
    var out = [];
    var stack = [];
    var ignore = false;
    var ucskip = 1;
    var i = 0, n = rtf.length;

    while (i < n) {
      var c = rtf[i];

      if (c === '{') { stack.push(ignore); i++; continue; }
      if (c === '}') { ignore = stack.length ? stack.pop() : false; i++; continue; }

      if (c === '\\') {
        var next = rtf[i + 1];
        if (next === undefined) break;

        // Control symbol (non-alphabetic)
        if (!/[a-zA-Z]/.test(next)) {
          i += 2;
          if (next === '\\' || next === '{' || next === '}') { if (!ignore) out.push(next); }
          else if (next === '~') { if (!ignore) out.push(' '); }
          else if (next === '_') { if (!ignore) out.push('‑'); }
          else if (next === '-') { /* optional hyphen */ }
          else if (next === '*') { ignore = true; }
          else if (next === "'") {
            var hex = rtf.substr(i, 2); i += 2;
            var b = parseInt(hex, 16);
            if (!isNaN(b) && !ignore) {
              var cp = CP1252[b] || b;
              out.push(String.fromCharCode(cp));
            }
          }
          continue;
        }

        // Control word
        var m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i + 1));
        var word = m[1];
        var param = m[2] !== undefined ? parseInt(m[2], 10) : null;
        i += 1 + m[0].length;

        if (RTF_DEST[word]) { ignore = true; continue; }
        if (ignore) continue;

        if (word === 'uc') { ucskip = param == null ? 1 : param; }
        else if (word === 'u') {
          var code = param < 0 ? param + 65536 : param;
          out.push(String.fromCharCode(code));
          // skip the following ucskip fallback chars
          var skipped = 0;
          while (skipped < ucskip && i < n) {
            if (rtf[i] === '\\') { i += 2; }
            else if (rtf[i] === '{' || rtf[i] === '}') { break; }
            else { i++; }
            skipped++;
          }
        }
        else if (RTF_BREAK[word]) out.push('\n');
        else if (word === 'tab') out.push('\t');
        else if (word === 'cell' || word === 'nestcell') out.push('\t');
        // all other control words: ignore
        continue;
      }

      // raw newlines in the RTF source are not content
      if (c === '\r' || c === '\n') { i++; continue; }

      if (!ignore) out.push(c);
      i++;
    }
    return out.join('');
  }

  // ---------------------------------------------------------------------------
  // IR model helpers
  // ---------------------------------------------------------------------------

  // The inline token a field renders as inside the report's plain text.
  function fieldToken(f) {
    if (f.type === 3) {
      var s = (f.name || '') + ':';
      (f.choices || []).forEach(function (c, idx) {
        var tok = (c.name !== undefined && c.name !== '') ? c.name : (c.text || '');
        s += (idx > 0 ? '/' : '') + tok;
      });
      return s;
    }
    if (f.type === 1) return (f.value != null ? f.value : (f.name || ''));
    return f.name || ''; // type 2 & 4
  }

  function plainOfNode(node) {
    return node.kind === 'text' ? node.text : fieldToken(node.field);
  }

  // Full plain text of a template (the offset coordinate space).
  function templatePlainText(t) {
    return t.nodes.map(plainOfNode).join('');
  }

  // Carve a flat node list out of plain text + offset-bearing field defs.
  function carve(plain, fields) {
    fields = fields.slice().sort(function (a, b) { return a.start - b.start; });
    var nodes = [];
    var cur = 0;
    fields.forEach(function (f) {
      if (f.start < cur) return; // overlap guard
      if (f.start > cur) nodes.push({ kind: 'text', text: plain.slice(cur, f.start) });
      nodes.push({ kind: 'field', field: f.field });
      cur = f.start + f.length;
    });
    if (cur < plain.length) nodes.push({ kind: 'text', text: plain.slice(cur) });
    return nodes;
  }

  // Split a node list into paragraphs (arrays of inline runs) on '\n'.
  function toParagraphs(nodes) {
    var paras = [[]];
    nodes.forEach(function (node) {
      if (node.kind === 'field') { paras[paras.length - 1].push(node); return; }
      var parts = node.text.split('\n');
      for (var i = 0; i < parts.length; i++) {
        if (i > 0) paras.push([]);
        if (parts[i] !== '') paras[paras.length - 1].push({ kind: 'text', text: parts[i] });
      }
    });
    return paras;
  }

  // ---------------------------------------------------------------------------
  // Embedded autotext <field> XML  ->  Field objects
  // ---------------------------------------------------------------------------

  function parseXml(str, mime) {
    var doc = new DOMParser().parseFromString(str, mime || 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('XML parse error: ' +
        doc.getElementsByTagName('parsererror')[0].textContent.slice(0, 200));
    }
    return doc;
  }

  function textOf(el, tag) {
    var c = el.getElementsByTagName(tag);
    return c.length ? c[0].textContent : null;
  }

  function readProps(fieldEl) {
    var props = {};
    var cps = fieldEl.getElementsByTagName('customproperties');
    if (!cps.length) return props;
    var ps = cps[0].getElementsByTagName('property');
    for (var i = 0; i < ps.length; i++) {
      var nm = textOf(ps[i], 'name');
      var vEls = ps[i].getElementsByTagName('value');
      var v = vEls.length ? vEls[0].textContent : '';
      if (nm) props[nm] = v;
    }
    return props;
  }

  // Parse one <autotext> element's <fields> into offset-bearing field records.
  function parseAutotextFields(autotextEl) {
    var fieldEls = autotextEl.getElementsByTagName('field');
    var out = [];
    for (var i = 0; i < fieldEls.length; i++) {
      var fe = fieldEls[i];
      var type = parseInt(fe.getAttribute('type'), 10);
      var start = parseInt(fe.getAttribute('start'), 10);
      var length = parseInt(fe.getAttribute('length'), 10);

      var valueEls = fe.getElementsByTagName('value');
      // value element directly under field (not the property values)
      var valueEl = null;
      for (var v = 0; v < valueEls.length; v++) {
        if (valueEls[v].parentNode === fe) { valueEl = valueEls[v]; break; }
      }

      var choices = [];
      var chEls = fe.getElementsByTagName('choice');
      for (var c = 0; c < chEls.length; c++) {
        choices.push({
          name: chEls[c].getAttribute('name') || '',
          text: chEls[c].textContent || '',
          autotextId: chEls[c].getAttribute('autotextId') || null,
          autotextName: chEls[c].getAttribute('autotextName') || null
        });
      }

      var field = {
        type: type,
        name: textOf(fe, 'name') || '',
        value: valueEl ? valueEl.textContent : null,
        valueDefaultAttr: valueEl ? valueEl.getAttribute('default') : null,
        defaultValue: textOf(fe, 'defaultvalue'),
        choices: choices,
        props: readProps(fe),
        mergeId: fe.getAttribute('mergeid'),
        mergeName: fe.getAttribute('mergename')
      };

      out.push({ start: start, length: length, field: field });
    }
    return out;
  }

  // Pull the embedded "<autotext>...</autotext>" string out of an RTF blob.
  function extractEmbeddedXml(rtf) {
    var idx = rtf.indexOf('{\\xml}');
    if (idx < 0) return null;
    var tail = rtf.slice(idx + 6);
    var s = tail.indexOf('<autotext');
    if (s < 0) return null;
    var e = tail.lastIndexOf('</autotext>');
    if (e < 0) return null;
    return tail.slice(s, e + '</autotext>'.length);
  }

  // ===========================================================================
  // PARSERS
  // ===========================================================================

  // --- PowerScribe One : PortalAutoTextExport XML ---------------------------
  function parsePsOne(xmlString) {
    var doc = parseXml(xmlString, 'text/xml');
    var atEls = doc.getElementsByTagName('AutoText');
    if (!atEls.length) throw new Error('No <AutoText> elements found.');

    var templates = [];
    for (var i = 0; i < atEls.length; i++) {
      var at = atEls[i];
      var name = textOf(at, 'Name') || ('Template ' + (i + 1));
      var contentRtf = textOf(at, 'ContentRTF') || '';
      var contentText = textOf(at, 'ContentText');
      var xml = extractEmbeddedXml(contentRtf);

      var fields = [];
      if (xml) {
        try { fields = parseAutotextFields(parseXml(xml).documentElement); }
        catch (e) { /* leave fields empty */ }
      }

      // ContentText is the authoritative offset space for PowerScribe One.
      var plain = contentText != null ? contentText : rtfToText(contentRtf.split('{\\xml}')[0]);
      plain = plain.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      templates.push({
        name: name,
        nodes: carve(plain, fields),
        meta: {
          guid: textOf(at, 'GUID'),
          autoTextId: textOf(at, 'AutoTextID'),
          isDefault: (textOf(at, 'IsDefault') || '').trim() === 'true'
        }
      });
    }
    // Primary template first.
    templates.sort(function (a, b) { return (b.meta.isDefault ? 1 : 0) - (a.meta.isDefault ? 1 : 0); });
    return templates;
  }

  // --- PowerScribe 360 : RTF with embedded {\xml} ---------------------------
  function parsePs360(rtfString, name) {
    var body = rtfString.split('{\\xml}')[0];
    // Drop anything after the RTF document's closing brace (e.g. the "\n "
    // separator that precedes the embedded {\xml} block) so it isn't treated
    // as trailing body text.
    var close = body.lastIndexOf('}');
    if (close >= 0) body = body.slice(0, close + 1);
    var xml = extractEmbeddedXml(rtfString);
    var fields = [];
    if (xml) fields = parseAutotextFields(parseXml(xml).documentElement);

    var plain = rtfToText(body);
    // PowerScribe trims a single trailing newline structure; keep as-is.
    return [{
      name: name || 'Converted Template',
      nodes: carve(plain, fields),
      meta: {}
    }];
  }

  // --- IHE MRRT : HTML ------------------------------------------------------
  var KNOWN_MERGE = { 'Procedures': '802', 'Reason For Study': '507' };

  function parseMrrt(htmlString, name) {
    var doc = parseXml(htmlString, 'text/html');
    var title = (doc.querySelector('title') && doc.querySelector('title').textContent) ||
      (doc.querySelector('meta[name="dcterms.title"]') &&
        doc.querySelector('meta[name="dcterms.title"]').getAttribute('content'));
    var body = doc.body || doc.documentElement;

    var nodes = [];
    function pushText(t) { if (t) nodes.push({ kind: 'text', text: t }); }

    var sections = body.querySelectorAll('section');
    var roots = sections.length ? sections : [body];

    for (var s = 0; s < roots.length; s++) {
      var sec = roots[s];
      var header = sec.querySelector('header');
      if (s > 0) pushText('\n\n');
      if (header && header.textContent.trim()) pushText(header.textContent.trim() + '\n');

      var ps = sec.querySelectorAll('p');
      for (var p = 0; p < ps.length; p++) {
        if (p > 0) pushText('\n');
        var kids = ps[p].childNodes;
        for (var k = 0; k < kids.length; k++) {
          var el = kids[k];
          if (el.nodeType === 3) { pushText(el.textContent); continue; }
          if (el.nodeType !== 1) continue;
          var tag = el.tagName.toLowerCase();
          if (tag === 'label') pushText(el.textContent);
          else if (tag === 'input') nodes.push({ kind: 'field', field: inputToField(el) });
          else if (tag === 'select') nodes.push({ kind: 'field', field: selectToField(el) });
          else pushText(el.textContent);
        }
      }
    }

    return [{ name: title || name || 'Converted Template', nodes: nodes, meta: {} }];
  }

  function inputToField(el) {
    var nm = el.getAttribute('name') || '';
    var val = el.getAttribute('value');
    var known = KNOWN_MERGE[nm];
    var f = {
      type: known ? 4 : 1,
      name: nm,
      value: nm,
      valueDefaultAttr: (val && val !== nm) ? '1' : null,
      defaultValue: (val != null && val !== nm) ? val : null,
      choices: [],
      props: {},
      mergeId: known || null,
      mergeName: known ? '' : null
    };
    return f;
  }

  function selectToField(el) {
    var nm = el.getAttribute('name') || '';
    var opts = el.getElementsByTagName('option');
    var choices = [];
    var def = null;
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      var cn = o.getAttribute('name') || '';
      var ct = o.textContent || '';
      choices.push({ name: cn, text: ct, autotextId: null, autotextName: null });
      if (o.hasAttribute('selected') && def == null) def = ct;
    }
    return {
      type: 3, name: nm, value: null, defaultValue: def != null ? def : (choices[0] ? choices[0].text : null),
      choices: choices, props: {}, mergeId: null, mergeName: null
    };
  }

  // --- Rad AI Reporting : Slate.js content array (JSON) ---------------------
  // Rad AI templates are a Slate document tree (a JSON array of block nodes with
  // inline field nodes and text leaves) rather than flat text + offsets. We map
  // its node types onto the same IR. Only structural/format mechanics are
  // handled here (not clinical formula recipes).
  //
  // Data-field formulas <-> merge fields (the cross-platform-meaningful subset):
  var DATA_FORMULA_TO_MERGE = {
    'reason()': { name: 'Reason For Study', mergeId: '507' },
    'procedureDescription()': { name: 'Procedures', mergeId: '802' }
  };
  var MERGE_TO_DATA_FORMULA = {
    'Reason For Study': 'reason()',
    'Procedures': 'procedureDescription()',
    'Accession Number': 'accession()',
    'Patient Name': 'fullName(patient())',
    'Study Date': 'studyDate()'
  };

  function parseRadai(input, name) {
    var data = JSON.parse(input);
    var content = Array.isArray(data) ? data : ((data && data.content) || []);
    var title = (!Array.isArray(data) && (data.title || data.name)) || name || 'Converted Template';
    var nodes = [];
    walkRadaiBlocks(content, nodes);
    return [{ name: title, nodes: nodes, meta: {} }];
  }

  function walkRadaiBlocks(blocks, nodes) {
    blocks.forEach(function (blk, i) {
      if (i > 0) nodes.push({ kind: 'text', text: '\n' });
      walkRadaiBlock(blk, nodes);
    });
  }

  function walkRadaiBlock(blk, nodes) {
    var t = blk.type;
    if (t === 'numbered-list' || t === 'bulleted-list' || t === 'ol' || t === 'ul') {
      var ordered = (t === 'numbered-list' || t === 'ol');
      (blk.children || []).forEach(function (li, idx) {
        if (idx > 0) nodes.push({ kind: 'text', text: '\n' });
        nodes.push({ kind: 'text', text: ordered ? (idx + 1) + '. ' : '- ' });
        (li.children || []).forEach(function (c) { radaiInline(c, nodes); });
      });
      return;
    }
    if (t === 'section' || t === 'impression-zone') {
      walkRadaiBlocks(blk.children || [], nodes);
      return;
    }
    // paragraph (no type) / headings / anything else: inline children
    (blk.children || []).forEach(function (c) { radaiInline(c, nodes); });
  }

  function radaiInline(node, nodes) {
    if (node.text !== undefined) {
      if (node.text) nodes.push({ kind: 'text', text: node.text });
      return;
    }
    var t = node.type;
    if (t === 'input') { nodes.push({ kind: 'field', field: radaiInputToField(node) }); return; }
    if (t === 'select' || t === 'select-block') { nodes.push({ kind: 'field', field: radaiSelectToField(node) }); return; }
    if (t === 'observation-input') {
      nodes.push({ kind: 'field', field: mkField(2, node.name || '', { value: node.templateDefaultValue || node.name || '' }) });
      return;
    }
    if (t === 'observation-select') {
      nodes.push({ kind: 'field', field: mkField(3, node.name || '', { choices: [] }) });
      return;
    }
    if (t === 'fragment') {
      nodes.push({ kind: 'field', field: mkField(1, node.name || 'fragment', { value: node.name || '' }) });
      return;
    }
    if (node.children) node.children.forEach(function (c) { radaiInline(c, nodes); });
  }

  function mkField(type, nm, extra) {
    var f = {
      type: type, name: nm, value: null, valueDefaultAttr: null, defaultValue: null,
      choices: [], props: {}, mergeId: null, mergeName: null
    };
    for (var k in extra) f[k] = extra[k];
    return f;
  }

  function radaiInputToField(node) {
    var formula = node.formula;
    var defText = (node.children && node.children[0] && node.children[0].text) || '';
    if (formula && DATA_FORMULA_TO_MERGE[formula]) {
      var m = DATA_FORMULA_TO_MERGE[formula];
      return mkField(4, m.name, { value: m.name, mergeId: m.mergeId, mergeName: '' });
    }
    if (formula) {
      // other data/formula field: keep the expression so it survives a round-trip
      return mkField(2, node.name || '', { value: node.name || '', radaiFormula: formula });
    }
    return mkField(1, node.name || '', {
      value: node.name || '',
      defaultValue: (defText && defText !== node.name) ? defText : (defText || null)
    });
  }

  function radaiSelectToField(node) {
    var choices = [], def = null;
    (node.options || []).forEach(function (o) {
      var text = typeof o.value === 'string' ? o.value : (o.name || '');
      choices.push({ name: o.name || '', text: text, autotextId: null, autotextName: null });
      if (o.default && def == null) def = text;
    });
    return mkField(3, node.name || '', {
      choices: choices,
      defaultValue: def != null ? def : (choices[0] ? choices[0].text : null)
    });
  }

  // --- plain text (very loose; treats whole thing as literal) ---------------
  function parseText(txt, name) {
    return [{ name: name || 'Converted Template', nodes: [{ kind: 'text', text: txt }], meta: {} }];
  }

  // ===========================================================================
  // SERIALIZERS
  // ===========================================================================

  // Choose which choice index is the "current value" of a pick list.
  function defaultChoiceIndex(f) {
    if (f.defaultValue != null) {
      for (var i = 0; i < f.choices.length; i++) {
        if (f.choices[i].text === f.defaultValue || f.choices[i].name === f.defaultValue) return i;
      }
    }
    return 0;
  }

  function choiceToken(c) {
    return (c.name !== undefined && c.name !== '') ? c.name : (c.text || '');
  }

  // --- plain text -----------------------------------------------------------
  function serializeText(t) { return templatePlainText(t); }

  // --- embedded autotext field XML (shared by psone & ps360) ----------------
  // `flavor` is 'psone' or 'ps360' (controls customproperties shape).
  function buildFieldXml(fieldRecs, flavor, withTextSource) {
    var parts = [];
    var ranges = [];
    fieldRecs.forEach(function (r) {
      var f = r.field, x = '';
      var attrs = ' type="' + f.type + '" start="' + r.start + '" length="' + r.length + '"';
      if (f.type === 4) {
        attrs += ' mergeid="' + escXml(f.mergeId || '') + '"' +
          ' mergename="' + escXml(f.mergeName != null ? f.mergeName : '') + '"';
      }
      x += '<field' + attrs + '>';
      x += '<name>' + escXml(f.name) + '</name>';

      if (f.type === 1 || f.type === 2) {
        var val = f.value != null ? f.value : f.name;
        var defAttr = (f.valueDefaultAttr === '1' || f.defaultValue) ? ' default="1"' : '';
        x += '<value' + defAttr + '>' + escXml(val) + '</value>';
      }
      if (f.defaultValue != null && f.defaultValue !== '') {
        x += '<defaultvalue>' + escXml(f.defaultValue) + '</defaultvalue>';
      }
      if (f.type === 3) {
        x += '<choices>';
        f.choices.forEach(function (c) {
          if (c.autotextId) {
            x += '<choice name="' + escXml(c.name) + '" autotextId="' + escXml(c.autotextId) +
              '" autotextName="' + escXml(c.autotextName || c.name) + '" />';
          } else {
            x += '<choice name="' + escXml(c.name) + '">' + escXml(c.text) + '</choice>';
          }
        });
        x += '</choices>';
      }

      x += buildProps(f, flavor);
      x += '</field>';
      parts.push(x);

      // textSource ranges (ps360)
      if (withTextSource) {
        if (f.type === 3) {
          var nameLen = (f.name || '').length;
          ranges.push('<range type="3" start="' + r.start + '" length="' + nameLen + '" />');
          var di = defaultChoiceIndex(f);
          var valTok = f.choices[di] ? choiceToken(f.choices[di]) : '';
          ranges.push('<range type="3" start="' + (r.start + nameLen + 1) + '" length="' + valTok.length + '" />');
        } else {
          ranges.push('<range type="' + f.type + '" start="' + r.start + '" length="' + r.length + '" />');
        }
      }
    });

    var ts = withTextSource ? '<textSource>' + ranges.join('') + '</textSource>' : '';
    var verAttr = flavor === 'psone'
      ? ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" version="2" editMode="2"'
      : ' version="2" editMode="2"';
    var enc = flavor === 'psone' ? 'utf-16' : 'utf8';
    return '<?xml version="1.0" encoding="' + enc + '"?>' +
      '<autotext' + verAttr + '><fields>' + parts.join('') + '</fields>' +
      '<links />' + ts + '<snippetGroups /></autotext>';
  }

  var PROP_DEFAULTS = {
    AllCaps: 'False', AllowEmpty: 'False', DoesNotIndicateFindings: 'False',
    FindingsCodes: '', ImpressionField: 'False', IsBold: 'False',
    IsItalic: 'False', IsUnderline: 'False', EnforcePickList: 'False'
  };

  function propVal(f, key) {
    return f.props && f.props[key] !== undefined ? f.props[key] : PROP_DEFAULTS[key];
  }

  function emitProps(f, keys) {
    var s = '<customproperties>';
    keys.forEach(function (k) {
      var v = propVal(f, k);
      s += '<property><name>' + k + '</name>' +
        (v === '' ? '<value />' : '<value>' + escXml(v) + '</value>') + '</property>';
    });
    return s + '</customproperties>';
  }

  function buildProps(f, flavor) {
    if (flavor === 'psone') {
      if (f.type === 4) return emitProps(f, ['IsBold', 'IsItalic', 'IsUnderline']);
      if (f.type === 3) return emitProps(f, ['AllowEmpty', 'DoesNotIndicateFindings', 'EnforcePickList', 'FindingsCodes', 'ImpressionField', 'IsBold', 'IsItalic', 'IsUnderline']);
      return emitProps(f, ['AllCaps', 'AllowEmpty', 'DoesNotIndicateFindings', 'FindingsCodes', 'ImpressionField', 'IsBold', 'IsItalic', 'IsUnderline']);
    }
    // ps360
    if (f.type === 4) return '';
    return emitProps(f, ['AllCaps', 'AllowEmpty', 'ImpressionField', 'DoesNotIndicateFindings', 'FindingsCodes', 'EnforcePickList']);
  }

  // --- PowerScribe 360 RTF --------------------------------------------------
  function serializePs360(t) {
    var paras = toParagraphs(t.nodes);
    var pos = 0;
    var fieldRecs = [];
    var body = '\\pard\\widctlpar\\f0\\fs24 ';
    var color = 0; // 0 = none emitted yet; 1 = literal black; 2 = field red
    function setColor(c) { if (color !== c) { body += '\\cf' + c + ' '; color = c; } }

    paras.forEach(function (runs, pi) {
      if (pi > 0) { setColor(1); body += '\\par\n'; pos += 1; }
      runs.forEach(function (run) {
        if (run.kind === 'text') {
          setColor(1); body += escRtf(run.text); pos += run.text.length; return;
        }
        var f = run.field;
        var tok = fieldToken(f);
        fieldRecs.push({ start: pos, length: tok.length, field: f });
        if (f.type === 3) {
          var di = defaultChoiceIndex(f);
          setColor(2); body += escRtf(f.name);
          setColor(1); body += ':';
          f.choices.forEach(function (c, idx) {
            var seg = (idx > 0 ? '/' : '') + choiceToken(c);
            setColor(idx === di ? 2 : 1); body += escRtf(seg);
          });
        } else {
          setColor(2); body += escRtf(tok);
        }
        pos += tok.length;
      });
    });
    setColor(1);

    var xml = buildFieldXml(fieldRecs, 'ps360', true);
    var rtf = '{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat\\deflang1033' +
      '{\\fonttbl{\\f0\\fnil Arial;}}\n' +
      '{\\colortbl ;\\red0\\green0\\blue0;\\red178\\green34\\blue34;}\n' +
      '{\\*\\generator RTConverter 1.0}\\viewkind4\\uc1 \n' +
      body + '}';
    return rtf + '\n {\\xml}' + xml;
  }

  // --- PowerScribe One PortalAutoTextExport XML -----------------------------
  var PS1_HEADER =
    '{\\rtf\\ansi\\ansicpg1252\\uc1\\deff0\\deflang1033' +
    '{\\fonttbl{\\f0 Times New Roman;}{\\f1 Verdana;}}' +
    '{\\colortbl\\red0\\green0\\blue0 ;}' +
    '{\\*\\defchp\\ltrch\\fs20\\i0\\b0\\strike0\\ulnone}' +
    '{\\*\\defpap\\sl240\\slmult1}' +
    '{\\stylesheet' +
    '{\\s0\\sqformat\\spriority0\\ltrch\\fs24\\i0\\b0\\strike0\\ulnone\\sl240\\slmult1 Normal;}' +
    '{\\s2\\sbasedon0\\ltrch\\fs24\\i0\\b0\\strike0\\ulnone\\sl240\\slmult1\\sb100\\sbauto1\\sa100\\saauto1 ___rtcgen;}' +
    '{\\*\\cs3\\additive\\ltrch\\fs20\\i0\\b0\\strike0\\ulnone content;}' +
    '{\\*\\cs4\\additive\\ltrch\\fs20\\i0\\b0\\strike0\\ulnone dropdown-toggle;}' +
    '{\\*\\cs5\\additive\\ltrch\\fs20\\i0\\b0\\strike0\\ulnone dropdown-item;}}' +
    '\\nouicompat\\viewkind1\\deftab720\\sectd\\pgwsxn12240\\pghsxn15840' +
    '\\marglsxn1440\\margrsxn1440\\margtsxn1440\\margbsxn1440\\vertalt\\headery720\\footery720';

  var PS1_PARD = '\\pard\\s2\\ltrpar\\sl240\\slmult1\\sb100\\sbauto1\\sa100\\saauto1';
  var PS1_LITERAL = '\\ltrch\\fs24\\i0\\b0\\strike0\\ulnone ';
  var PS1_CS3 = '\\cs3\\ltrch\\fs20\\i0\\b0\\strike0\\ulnone ';
  var PS1_CS4 = '\\cs4\\ltrch\\fs20\\i0\\b0\\strike0\\ulnone ';
  var PS1_CS5 = '\\cs5\\ltrch\\fs20\\i0\\b0\\strike0\\ulnone ';
  var PS1_PAREND = '{\\ltrch\\f1\\fs20\\i0\\b0\\strike0\\ulnone\\par}';

  function serializePsOneRtf(t, fieldRecsOut) {
    var paras = toParagraphs(t.nodes);
    var rtf = PS1_HEADER;
    var pos = 0;

    paras.forEach(function (runs, pi) {
      rtf += PS1_PARD;
      runs.forEach(function (run) {
        if (run.kind === 'text') {
          rtf += '{' + PS1_LITERAL + escRtf(run.text) + '}';
          pos += run.text.length;
          return;
        }
        var f = run.field;
        var tok = fieldToken(f);
        fieldRecsOut.push({ start: pos, length: tok.length, field: f });
        if (f.type === 3) {
          rtf += '{' + PS1_CS4 + escRtf(f.name) + ':}';
          f.choices.forEach(function (c, idx) {
            var seg = (idx > 0 ? '/' : '') + choiceToken(c);
            rtf += '{' + PS1_CS5 + escRtf(seg) + '}';
          });
        } else {
          rtf += '{' + PS1_CS3 + escRtf(tok) + '}';
        }
        pos += tok.length;
      });
      rtf += PS1_PAREND;
      if (pi < paras.length - 1) pos += 1; // newline between paragraphs
    });

    rtf += '}';
    return rtf;
  }

  function serializePsOne(t) {
    var fieldRecs = [];
    var contentRtf = serializePsOneRtf(t, fieldRecs);
    var xml = buildFieldXml(fieldRecs, 'psone', false);
    var contentText = templatePlainText(t);

    // ContentRTF carries the RTF + embedded xml (xml gets escaped once here,
    // then once more by the outer XML serialization -> matches export format).
    var fullRtf = contentRtf + ' {\\xml}' + xml;

    var guid = (t.meta && t.meta.guid) || newGuid();
    var out =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<PortalAutoTextExport>\n' +
      '  <AutoText>\n' +
      '    <Name>' + escXml(t.name) + '</Name>\n' +
      '    <ContentRTF>' + escXml(fullRtf) + '</ContentRTF>\n' +
      '    <ContentText>' + escXml(contentText) + '</ContentText>\n' +
      '    <AutoTextDefaultTypeID>2</AutoTextDefaultTypeID>\n' +
      '    <IsPrivate>false</IsPrivate>\n' +
      '    <GUID>' + guid + '</GUID>\n' +
      '    <AutoTextTypeID>1</AutoTextTypeID>\n' +
      '    <OwnerSystemID>1</OwnerSystemID>\n' +
      '    <IsDefault>true</IsDefault>\n' +
      '  </AutoText>\n' +
      '</PortalAutoTextExport>\n';
    return out;
  }

  function newGuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // --- IHE MRRT HTML --------------------------------------------------------
  // Section headers: leading literal text of a paragraph that matches a known
  // top-level report section becomes an MRRT <section>/<header>.
  var SECTION_WORDS = /^(EXAMINATION|FINDINGS|IMPRESSION|TECHNIQUE|COMPARISON|INDICATION|HISTORY|CLINICAL\s+INFORMATION)\b/i;
  var MAJOR_SECTIONS = /^(EXAMINATION|FINDINGS|IMPRESSION)\b/i;

  function serializeMrrt(t) {
    var paras = toParagraphs(t.nodes).filter(function (p) { return p.length > 0; });

    // Group paragraphs into sections at MAJOR_SECTIONS headers.
    var sections = [];
    var cur = { name: null, paras: [] };
    paras.forEach(function (runs) {
      var lead = runs[0] && runs[0].kind === 'text' ? runs[0].text.trim() : '';
      var onlyText = runs.length === 1 && runs[0].kind === 'text';
      var m = lead.match(MAJOR_SECTIONS);
      if (m) {
        if (cur.paras.length || cur.name) sections.push(cur);
        var title = m[0].charAt(0) + m[0].slice(1).toLowerCase();
        // strip the consumed header word + trailing ": " from the first run
        var rest = runs.slice();
        var trimmed = runs[0].text.replace(/^\s*[A-Za-z ]+:?\s*/, '');
        if (onlyText) rest = [];
        else rest = [{ kind: 'text', text: trimmed }].concat(runs.slice(1));
        rest = rest.filter(function (r) { return !(r.kind === 'text' && r.text === ''); });
        cur = { name: title, paras: rest.length ? [rest] : [] };
      } else {
        cur.paras.push(runs);
      }
    });
    if (cur.paras.length || cur.name) sections.push(cur);
    if (!sections.length) sections.push({ name: null, paras: paras });

    var html = '<html><head><meta charset="UTF-8">' +
      '<meta content="' + escXml(t.name) + '" name="dcterms.title">' +
      '<meta content="en" name="dcterms.language">' +
      '<title>' + escXml(t.name) + '</title></head><body>';

    sections.forEach(function (sec) {
      var secName = sec.name || t.name;
      html += '<section data-section-name="' + escXml(secName) + '">';
      html += '<header class="Level1">' + escXml(secName) + '</header>';
      sec.paras.forEach(function (runs) {
        html += '<p>' + runs.map(runToMrrt).join('') + '</p>';
      });
      html += '</section>';
    });

    html += '</body></html>';
    return html;
  }

  function runToMrrt(run) {
    if (run.kind === 'text') return '<label>' + escXml(run.text) + '</label>';
    var f = run.field;
    if (f.type === 3) {
      var di = defaultChoiceIndex(f);
      var s = '<select name="' + escXml(f.name) + '">';
      f.choices.forEach(function (c, idx) {
        s += '<option name="' + escXml(c.name) + '" value="' + escXml(c.name) + '"' +
          (idx === di ? ' selected=""' : '') + '>' + escXml(c.text) + '</option>';
      });
      return s + '</select>';
    }
    var val = f.defaultValue != null ? f.defaultValue : (f.value != null ? f.value : f.name);
    return '<input type="text" name="' + escXml(f.name) + '" value="' + escXml(val) + '">';
  }

  // --- Rad AI Reporting : Slate.js content array (JSON) ---------------------
  function serializeRadai(t) {
    var paras = toParagraphs(t.nodes);
    var blocks = [];
    paras.forEach(function (runs) {
      if (runs.length === 0) { blocks.push({ children: [{ text: '' }] }); return; }
      var children = [];
      runs.forEach(function (run) {
        if (run.kind === 'text') { children.push({ text: run.text }); }
        else { children.push(fieldToRadai(run.field)); }
      });
      // Slate invariant: children must start AND end with a text leaf.
      if (children.length === 0 || children[0].text === undefined) children.unshift({ text: '' });
      if (children[children.length - 1].text === undefined) children.push({ text: '' });
      blocks.push({ children: children });
    });
    if (blocks.length === 0) blocks.push({ children: [{ text: '' }] });
    return JSON.stringify(blocks, null, 2);
  }

  function fieldToRadai(f) {
    if (f.type === 3) {
      var di = defaultChoiceIndex(f);
      return {
        type: 'select', name: f.name || '',
        options: f.choices.map(function (c, i) {
          var o = {
            name: (c.name !== undefined && c.name !== '') ? c.name : (c.text || ''),
            value: c.text || ''
          };
          if (i === di) o.default = true;
          return o;
        }),
        children: [{ text: '' }]
      };
    }
    if (f.type === 4) {
      return {
        type: 'input', name: f.name || '',
        formula: MERGE_TO_DATA_FORMULA[f.name] || 'reason()',
        children: [{ text: '' }]
      };
    }
    if (f.type === 2 && f.radaiFormula) {
      return { type: 'input', name: f.name || '', formula: f.radaiFormula, children: [{ text: '' }] };
    }
    var def = f.defaultValue != null ? f.defaultValue : (f.value != null ? f.value : f.name);
    return { type: 'input', name: f.name || '', children: [{ text: def || '' }] };
  }

  // ===========================================================================
  // Registry / autodetect / public API
  // ===========================================================================

  // `tag` is appended to generated file names (e.g. "Chest CT_PS360.rtf") so
  // converted files are obviously converted and never collide with the source.
  var FORMATS = {
    psone: { label: 'PowerScribe One (XML)', ext: 'xml', mime: 'application/xml', tag: 'PSOne', parse: parsePsOne, serialize: serializePsOne },
    ps360: { label: 'PowerScribe 360 (RTF)', ext: 'rtf', mime: 'application/rtf', tag: 'PS360', parse: parsePs360, serialize: serializePs360 },
    mrrt: { label: 'MRRT (HTML)', ext: 'html', mime: 'text/html', tag: 'MRRT', parse: parseMrrt, serialize: serializeMrrt },
    radai: { label: 'Rad AI (Slate JSON)', ext: 'json', mime: 'application/json', tag: 'RadAI', parse: parseRadai, serialize: serializeRadai },
    text: { label: 'Plain text', ext: 'txt', mime: 'text/plain', tag: 'TXT', parse: parseText, serialize: serializeText }
  };

  function detectFormat(s) {
    var head = s.slice(0, 4000);
    if (/<PortalAutoTextExport/i.test(head)) return 'psone';
    if (/^\s*{\\rtf/.test(head)) return 'ps360';
    if (/<html[\s>]/i.test(head) || /<section[\s>]/i.test(head) || /<!doctype html/i.test(head)) return 'mrrt';
    if (/^\s*[\[{]/.test(head) && /"children"\s*:/.test(head)) return 'radai';
    return 'text';
  }

  // Parse `input` (string) of `inFmt` -> array of IR templates.
  function parse(input, inFmt, name) {
    var fmt = FORMATS[inFmt];
    if (!fmt) throw new Error('Unknown input format: ' + inFmt);
    return fmt.parse(input, name);
  }

  // Serialize one IR template -> string in `outFmt`.
  function serialize(template, outFmt) {
    var fmt = FORMATS[outFmt];
    if (!fmt) throw new Error('Unknown output format: ' + outFmt);
    return fmt.serialize(template);
  }

  global.RTC = {
    FORMATS: FORMATS,
    detectFormat: detectFormat,
    parse: parse,
    serialize: serialize,
    // exposed for testing
    _internals: {
      rtfToText: rtfToText, fieldToken: fieldToken, carve: carve,
      toParagraphs: toParagraphs, templatePlainText: templatePlainText
    }
  };
})(typeof window !== 'undefined' ? window : this);
