/* UI wiring for the Report Template Converter. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    rawInput: '',
    fileName: '',
    templates: [],   // parsed IR templates
    selected: 0
  };

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

  function effectiveInFmt() {
    var v = $('inFormat').value;
    if (v === 'auto') {
      var d = state.rawInput ? RTC.detectFormat(state.rawInput) : 'text';
      $('detected').textContent = state.rawInput ? '→ detected: ' + RTC.FORMATS[d].label : '';
      return d;
    }
    $('detected').textContent = '';
    return v;
  }

  function reparse() {
    state.templates = [];
    state.selected = 0;
    if (!state.rawInput.trim()) { renderTemplatePicker(); convert(); return; }
    var inFmt = effectiveInFmt();
    try {
      state.templates = RTC.parse(state.rawInput, inFmt, state.fileName.replace(/\.[^.]+$/, ''));
      setStatus('Parsed ' + state.templates.length + ' template(s) as ' + RTC.FORMATS[inFmt].label + '.', 'ok');
    } catch (e) {
      setStatus('Parse error: ' + e.message, 'err');
    }
    renderTemplatePicker();
    convert();
  }

  function renderTemplatePicker() {
    var wrap = $('templatePicker');
    if (state.templates.length <= 1) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var sel = $('templateSelect');
    sel.innerHTML = '';
    state.templates.forEach(function (t, i) {
      var o = document.createElement('option');
      o.value = i; o.textContent = (i + 1) + '. ' + t.name;
      sel.appendChild(o);
    });
    sel.value = state.selected;
  }

  function convert() {
    var out = $('output');
    if (!state.templates.length) { out.value = ''; updatePreview(''); return; }
    var t = state.templates[state.selected] || state.templates[0];
    var outFmt = $('outFormat').value;
    try {
      var result = RTC.serialize(t, outFmt);
      out.value = result;
      updatePreview(RTC.serialize(t, 'text'));
      $('downloadBtn').disabled = false;
    } catch (e) {
      out.value = '';
      setStatus('Convert error: ' + e.message, 'err');
    }
  }

  function updatePreview(text) {
    $('preview').textContent = text || '(empty)';
  }

  function download() {
    if (!state.templates.length) return;
    var t = state.templates[state.selected] || state.templates[0];
    var outFmt = $('outFormat').value;
    var fmt = RTC.FORMATS[outFmt];
    var base = (t.name || 'template').replace(/[^\w\- ]+/g, '').trim() || 'template';
    var blob = new Blob([$('output').value], { type: fmt.mime });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = base + '.' + fmt.ext;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  function loadFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      state.rawInput = String(reader.result);
      state.fileName = file.name;
      $('inputText').value = state.rawInput;
      reparse();
    };
    reader.readAsText(file);
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
      state.rawInput = this.value; state.fileName = ''; reparse();
    });
    $('inFormat').addEventListener('change', reparse);
    $('outFormat').addEventListener('change', convert);
    $('templateSelect').addEventListener('change', function () {
      state.selected = parseInt(this.value, 10) || 0; convert();
    });
    $('fileInput').addEventListener('change', function () {
      if (this.files && this.files[0]) loadFile(this.files[0]);
    });
    $('downloadBtn').addEventListener('click', download);
    $('copyBtn').addEventListener('click', copyOutput);
    $('clearBtn').addEventListener('click', function () {
      state.rawInput = ''; state.fileName = '';
      $('inputText').value = ''; reparse(); setStatus('');
    });

    // drag & drop
    var drop = document.body;
    ['dragover', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });

    setStatus('Paste a template, choose a file, or drag & drop one in.');
  });
})();
