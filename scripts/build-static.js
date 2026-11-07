'use strict';

/**
 * Builds a single self-contained HTML file (dist/trueline-demo.html) with a sample workspace baked in.
 * It needs no server, so it can be hosted anywhere static files can. It is read-only: no uploads.
 * Usage: node scripts/build-static.js [sample-name]
 */
const fs = require('node:fs');
const path = require('node:path');
const { ingest } = require('../src/ingest');
const { buildDataset } = require('../src/ingest/build');
const { loadSample, listSamples } = require('../src/samples');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const inline = (text) => text.replace(/<\/script/gi, '<\\/script'); // never let data close the script tag early

async function main() {
  const name = process.argv[2] || 'online-retail-ii';
  const meta = listSamples().find((s) => s.name === name);
  const sample = await loadSample(name, ingest);
  if (!meta || !sample) throw new Error('Unknown sample: ' + name);
  const stamp = '2011-11-09T06:00:00Z';
  const sources = sample.sources.map((s, i) =>
    Object.assign({ id: 's_' + i, uploadedAt: sample.settings.asOf ? sample.settings.asOf + 'T06:00:00Z' : stamp }, s)
  );
  const dataset = buildDataset({ settings: sample.settings, sources });
  const summary = (s) => ({ id: s.id, kind: s.kind, file: s.file, uploadedAt: s.uploadedAt, stats: s.stats, notes: s.notes, issues: s.issues, range: s.range });
  const payload = { title: meta.title, description: meta.description, dataset, workspace: { settings: sample.settings, sources: sources.map(summary) } };

  // Replacement functions, not strings: code contains "$&" and "$'", which String.replace would expand.
  const html = read('public/index.html')
    .replace('<link rel="stylesheet" href="app.css" />', () => '<style>' + read('public/app.css') + '</style>')
    .replace(
      '<script src="/engine.js"></script>',
      () => '<script>window.TRUELINE_STATIC = ' + inline(JSON.stringify(payload)) + ';</script>\n<script>' + inline(read('src/engine/engine.js')) + '</script>'
    )
    .replace('<script src="/app.js"></script>', () => '<script>' + inline(read('public/app.js')) + '</script>');
  if (/<(link|script)[^>]+(href|src)="\/?(app\.css|app\.js|engine\.js)"/.test(html)) throw new Error('Static build left an external asset reference.');
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const out = path.join(root, 'dist', 'trueline-demo.html');
  fs.writeFileSync(out, html);
  process.stdout.write('Wrote ' + out + ' (' + Math.round(html.length / 1024) + ' KB)\n');
}

main().catch((err) => {
  process.stderr.write(err.message + '\n');
  process.exit(1);
});
