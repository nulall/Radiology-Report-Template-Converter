/* UI wiring for the Report Template Converter. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    sources: [],   // [{ name, raw, fmt }] — one per loaded file (or one for pasted text)
    items: [],     // [{ t, srcIdx }] — every parsed template, across all sources
    selected: 0
  };

  function baseName(fileName) { return (fileName || '').replace(/\.[^.]+$/, ''); }

  function fmtOptions(selectEl, includeAuto) {
    selectEl.innerHTML = '';
    if (includeAuto) {
      var o = document.createElement('option');
      o.value = 'auto'; o.textContent = 'Auto-detect';
      selectEl.appendChild(o);
    }
    Object.keys(RTC.FORMATS).forEach(function (k) {
      var opt = document.createElement('option');
      opt.value = k; opt.textContent = RTC.FORMATS[k].label;
      selectEl.appendChild(opt);
    });
  }

  function setStatus(msg, kind) {
    var el = $('status');
    el.textContent = msg || '';
    el.className = 'status ' + (kind || '');
  }

  function selectedItem() {
    return state.items[state.selected] || state.items[0] || null;
  }

  function updateDetectedHint() {
    var el = $('detected');
    if ($('inFormat').value !== 'auto' || !state.sources.length) { el.textContent = ''; return; }
    var it = selectedItem();
    var src = it ? state.sources[it.srcIdx] : state.sources[0];
    el.textContent = '→ detected: ' + RTC.FORMATS[src.fmt].label;
  }

  // Re-parse every loaded source. `fromFiles` means the sources came from the
  // file picker / drag-drop, so the input pane should be refreshed from them.
  function reparse(fromFiles) {
    state.items = [];
    state.selected = 0;
    var explicit = $('inFormat').value;
    var errs = [];
    state.sources.forEach(function (src, si) {
      src.fmt = explicit === 'auto' ? RTC.detectFormat(src.raw) : explicit;
      try {
        RTC.parse(src.raw, src.fmt, baseName(src.name)).forEach(function (t) {
          state.items.push({ t: t, srcIdx: si });
        });
      } catch (e) {
        errs.push((src.name || 'pasted input') + ': ' + e.message);
      }
    });

    if (!state.sources.length) {
      setStatus('');
    } else if (errs.length) {
      setStatus('Parse error — ' + errs.join(' · '), state.items.length ? '' : 'err');
    } else if (state.sources.length > 1) {
      setStatus('Parsed ' + state.items.length + ' template(s) from ' + state.sources.length + ' files.', 'ok');
    } else if (state.sources.length === 1) {
      setStatus('Parsed ' + state.items.length + ' template(s) as ' +
        RTC.FORMATS[state.sources[0].fmt].label + '.', 'ok');
    }

    renderTemplatePicker();
    if (fromFiles) showSelectedSource();
    updateDetectedHint();
    convert();
  }

  function renderTemplatePicker() {
    var wrap = $('templatePicker');
    if (state.items.length <= 1) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var sel = $('templateSelect');
    sel.innerHTML = '';
    state.items.forEach(function (it, i) {
      var o = document.createElement('option');
      var label = (i + 1) + '. ' + it.t.name;
      var srcName = state.sources.length > 1 ? state.sources[it.srcIdx].name : '';
      if (srcName && baseName(srcName) !== it.t.name) label += ' (' + srcName + ')';
      o.value = i; o.textContent = label;
      sel.appendChild(o);
    });
    sel.value = state.selected;
  }

  // Show the selected template's source file in the input pane (bulk mode
  // loads several files; the pane always reflects the one being viewed).
  function showSelectedSource() {
    var it = selectedItem();
    var src = it ? state.sources[it.srcIdx] : state.sources[0];
    $('inputText').value = src ? src.raw : '';
  }

  function convert() {
    var out = $('output');
    var many = state.items.length > 1;
    $('downloadAllBtn').style.display = many ? '' : 'none';
    $('downloadAllBtn').textContent = 'Download all (' + state.items.length + ')';
    if (!state.items.length) {
      out.value = ''; updatePreview(''); $('downloadBtn').disabled = true;
      return;
    }
    var it = selectedItem();
    var outFmt = $('outFormat').value;
    try {
      out.value = RTC.serialize(it.t, outFmt);
      updatePreview(RTC.serialize(it.t, 'text'));
      $('downloadBtn').disabled = false;
    } catch (e) {
      out.value = '';
      $('downloadBtn').disabled = true;
      setStatus('Convert error: ' + e.message, 'err');
    }
  }

  function updatePreview(text) {
    $('preview').textContent = text || '(empty)';
  }

  // "Chest CT_PS360.rtf" — the format tag keeps converted files visibly
  // distinct from their sources even when the extension matches.
  function outFileName(t, fmt) {
    var base = (t.name || 'template').replace(/[^\w\- ]+/g, '').trim() || 'template';
    return base + '_' + fmt.tag + '.' + fmt.ext;
  }

  function uniqueName(used, name) {
    if (!used[name]) { used[name] = 1; return name; }
    var m = name.match(/^(.*)\.([^.]+)$/);
    var stem = m ? m[1] : name, ext = m ? '.' + m[2] : '';
    var n = 2, cand;
    do { cand = stem + ' (' + n + ')' + ext; n++; } while (used[cand]);
    used[cand] = 1;
    return cand;
  }

  function triggerDownload(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  function download() {
    var it = selectedItem();
    if (!it) return;
    var fmt = RTC.FORMATS[$('outFormat').value];
    triggerDownload(new Blob([$('output').value], { type: fmt.mime }), outFileName(it.t, fmt));
  }

  // Convert every loaded template and download the lot as one ZIP.
  function downloadAll() {
    if (!state.items.length) return;
    var outFmt = $('outFormat').value;
    var fmt = RTC.FORMATS[outFmt];
    var used = {}, entries = [], errs = [];
    state.items.forEach(function (it) {
      try {
        entries.push({ name: uniqueName(used, outFileName(it.t, fmt)), data: RTC.serialize(it.t, outFmt) });
      } catch (e) {
        errs.push(it.t.name + ': ' + e.message);
      }
    });
    if (!entries.length) {
      setStatus('Bulk convert failed — ' + errs.join(' · '), 'err');
      return;
    }
    triggerDownload(ZIP.make(entries), 'templates_' + fmt.tag + '.zip');
    setStatus('Downloaded ' + entries.length + ' converted template(s) as a ZIP.' +
      (errs.length ? ' Skipped ' + errs.length + ': ' + errs.join(' · ') : ''),
      errs.length ? 'err' : 'ok');
  }

  function loadFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    setStatus('Reading ' + files.length + ' file(s)…');
    var remaining = files.length;
    var results = new Array(files.length);
    var failures = [];
    files.forEach(function (file, i) {
      var reader = new FileReader();
      reader.onload = function () {
        results[i] = { name: file.name, raw: String(reader.result) };
        done();
      };
      reader.onerror = function () {
        failures.push(file.name);
        done();
      };
      reader.readAsText(file);
    });
    function done() {
      if (--remaining > 0) return;
      var sources = results.filter(Boolean);
      if (!sources.length) {
        setStatus('Could not read: ' + failures.join(', '), 'err');
        return;
      }
      state.sources = sources;
      reparse(true);
      if (failures.length) {
        setStatus($('status').textContent + ' Could not read: ' + failures.join(', '), 'err');
      }
    }
  }

  function copyOutput() {
    var ta = $('output');
    ta.select();
    navigator.clipboard.writeText(ta.value).then(function () {
      setStatus('Output copied to clipboard.', 'ok');
    }, function () {
      document.execCommand('copy');
      setStatus('Output copied.', 'ok');
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    fmtOptions($('inFormat'), true);
    fmtOptions($('outFormat'), false);
    $('inFormat').value = 'auto';
    $('outFormat').value = 'ps360';

    $('inputText').addEventListener('input', function () {
      state.sources = this.value.trim() ? [{ name: '', raw: this.value }] : [];
      reparse(false);
    });
    $('inFormat').addEventListener('change', function () { reparse(false); });
    $('outFormat').addEventListener('change', convert);
    $('templateSelect').addEventListener('change', function () {
      state.selected = parseInt(this.value, 10) || 0;
      if (state.sources.length > 1) showSelectedSource();
      updateDetectedHint();
      convert();
    });

    $('browseBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function () {
      if (this.files && this.files.length) loadFiles(this.files);
      // Reset so picking the same file again re-fires `change` (without this,
      // re-loading a file after Clear silently does nothing on Edge/Chrome).
      this.value = '';
    });

    $('downloadBtn').addEventListener('click', download);
    $('downloadAllBtn').addEventListener('click', downloadAll);
    $('copyBtn').addEventListener('click', copyOutput);
    $('clearBtn').addEventListener('click', function () {
      state.sources = [];
      $('inputText').value = '';
      reparse(false);
      setStatus('');
    });

    // drag & drop (multiple files supported)
    var drop = document.body;
    ['dragover', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
    });

    setStatus('Paste a template, choose files, or drag & drop them in.');
  });
})();
