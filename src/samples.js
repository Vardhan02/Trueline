'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'samples');

/** A sample is a folder with sample.json: { title, description, settings, files:[{ file, kind?, options? }] }. */
function listSamples() {
  return fsSync
    .readdirSync(DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fsSync.existsSync(path.join(DIR, d.name, 'sample.json')))
    .map((d) => {
      const m = JSON.parse(fsSync.readFileSync(path.join(DIR, d.name, 'sample.json'), 'utf8'));
      return { name: d.name, title: m.title, description: m.description };
    });
}

async function loadSample(name, ingest) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const base = path.join(DIR, name);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(base, 'sample.json'), 'utf8'));
  } catch {
    return null;
  }
  const sources = [];
  for (const f of manifest.files) {
    const buffer = await fs.readFile(path.join(base, f.file));
    sources.push(await ingest(buffer, f.file, { kind: f.kind, options: f.options }));
  }
  return { settings: manifest.settings, sources };
}

module.exports = { listSamples, loadSample };
