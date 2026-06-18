# Radiology Report Template Converter

A zero-install, browser-only tool that converts radiology **report templates**
(a.k.a. AutoText / report templates) between dictation-platform file formats —
in **any direction**. Everything runs client-side, so no PHI ever leaves the
browser, which makes it safe to host as a static site (e.g. GitHub Pages).

## Supported formats

| Key     | Platform / standard            | File          | Read | Write |
|---------|--------------------------------|---------------|:----:|:-----:|
| `psone` | Nuance **PowerScribe One**     | `.xml` (`PortalAutoTextExport`) | ✅ | ✅ |
| `ps360` | Nuance **PowerScribe 360**     | `.rtf` (RichEdit + embedded `{\xml}`) | ✅ | ✅ |
| `mrrt`  | IHE **MRRT** report template   | `.html`       | ✅ | ✅ |
| `text`  | Plain text (preview / generic) | `.txt`        | ✅ | ✅ |

Because every format is parsed into one shared intermediate representation (IR)
and every output is generated from that IR, all combinations work
(e.g. PowerScribe One → 360, MRRT → 360, 360 → MRRT, …).

## How to use

1. Open `index.html` (locally or via the hosted GitHub Pages URL).
2. Paste a template into the **Input** box, **Load** a file, or drag a file
   anywhere onto the page.
3. Leave **Input format** on *Auto-detect* (or set it explicitly).
4. Choose your **Output format**.
5. **Copy** or **Download** the result.

If the input file contains multiple templates (PowerScribe One exports often
bundle a main template plus add-ons), a **Template** picker appears so you can
choose which one to convert.

## How the conversion works

Every format encodes the *same* underlying structure: a report body made of
**literal text** interleaved with **fields**. Fields use Nuance's numbering,
which PowerScribe One and 360 share:

| Type | Meaning        | Example |
|:----:|----------------|---------|
| 1 | free-text field   | `Mastoid` → "Ultrasound was also performed…" |
| 2 | measurement field | `Anterior Horn Width Right` |
| 3 | pick list         | `Comparison: None. / Previous day. / …` |
| 4 | merge field       | `Procedures`, `Reason For Study` (system fields) |

The converter measures each field's position in the report's plain-text
"coordinate space" (the `start`/`length` offsets that PowerScribe relies on to
locate fields) and regenerates those offsets correctly for the target format.
This offset math has been verified by round-tripping real PowerScribe One, 360,
and MRRT templates and confirming every regenerated field offset lands exactly
on its token.

### Lossy edges (by design)

- **MRRT** (HTML) does not distinguish free-text (type 1) from merge (type 4)
  fields, and carries no merge-field IDs. Converting *to* MRRT drops the
  merge-ID; converting *from* MRRT maps well-known names (`Procedures`,
  `Reason For Study`) back to merge fields and treats the rest as free text.
- MRRT **section** grouping is heuristic: paragraphs whose leading text is a
  major report heading (`EXAMINATION`, `FINDINGS`, `IMPRESSION`) start a new
  `<section>`. The output is valid MRRT but won't be byte-identical to a
  specific vendor's exporter.
- **Plain text** is a one-way-ish preview: it keeps the text and field tokens
  but not field metadata.

PowerScribe One ↔ PowerScribe 360 conversions preserve field types, choices,
defaults, and custom properties.

## Running locally

It's a static site — any web server works. Two easy options:

```bash
# Python (no dependencies)
python3 -m http.server 3000
# then open http://localhost:3000/
```

> Opening `index.html` directly via `file://` works too, since you paste or
> drag in your own content rather than fetching anything.

## Deploying to GitHub Pages

1. Create a repo and push these files.
2. In **Settings → Pages**, set the source to your default branch, root (`/`).
3. Your converter will be live at `https://<user>.github.io/<repo>/`.

No build step is required.

## Adding another platform (e.g. RadAI, Fluency, etc.)

The architecture is pluggable. To add a format, register it in
`js/converter.js`:

```js
FORMATS.myformat = {
  label: 'My Platform',
  ext: 'json',
  mime: 'application/json',
  parse: function (input, name) { /* return [ {name, nodes, meta} ] */ },
  serialize: function (template) { /* return a string */ }
};
```

A parser turns the platform's file into IR templates (`nodes` is a flat list of
`{kind:'text', text}` and `{kind:'field', field}` items); a serializer turns one
IR template back into that platform's file. Reuse the existing helpers
(`fieldToken`, `toParagraphs`, `buildFieldXml`, etc.).

> **RadAI / other vendors:** these aren't included yet because their template
> *file* formats aren't publicly documented (RadAI in particular is an
> AI-assisted reporting layer rather than a fixed template-interchange file).
> Provide a sample export and the format can be added against the same IR.

## File layout

```
index.html          # the app
styles.css
js/converter.js     # parsers + serializers + IR (the engine)
js/app.js           # UI wiring
```
