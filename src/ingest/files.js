'use strict';

const path = require('node:path');

const TEXT_EXTENSIONS = new Set(['.csv', '.tsv', '.txt']);

class UnsupportedFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedFileError';
  }
}

const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b);

/**
 * Work out what a file is from its extension AND its contents, so a renamed file is not trusted blindly.
 * Returns 'csv' | 'xlsx' | 'ofx' | 'eml'. Throws UnsupportedFileError with a message the user can act on.
 */
function identifyFile(buffer, filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (!buffer || buffer.length === 0) throw new UnsupportedFileError('The file is empty.');
  const isZip = startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]);
  const isOle = startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0]);
  const isPdf = startsWith(buffer, [0x25, 0x50, 0x44, 0x46]);

  if (isOle) throw new UnsupportedFileError('Old .xls files are not supported. Open it in Excel and save as .xlsx or .csv.');
  if (isPdf || ext === '.pdf') throw new UnsupportedFileError('PDFs are not supported yet. Export the data as .csv or .xlsx from your accounting system.');
  if (isZip) {
    if (ext === '.xlsx' || ext === '.xlsm') return 'xlsx';
    throw new UnsupportedFileError('This looks like a zip archive. Unzip it and upload the files inside.');
  }
  if (ext === '.xlsx' || ext === '.xlsm') throw new UnsupportedFileError('This file has an Excel extension but is not a valid .xlsx workbook.');

  const head = buffer.subarray(0, 4096).toString('latin1');
  if (head.includes('\u0000')) throw new UnsupportedFileError('This does not look like a text or spreadsheet file.');
  if (ext === '.ofx' || ext === '.qfx' || /OFXHEADER|<OFX>/i.test(head)) return 'ofx';
  if (ext === '.eml' || /^(received|from|return-path|delivered-to|mime-version|subject|date):/im.test(head.split(/\r?\n\r?\n/)[0] || '')) {
    if (ext === '.eml' || ext === '.txt') return 'eml';
  }
  if (TEXT_EXTENSIONS.has(ext) || ext === '') return 'csv';
  throw new UnsupportedFileError('Unsupported file type "' + ext + '". Upload .csv, .tsv, .xlsx, .ofx or .eml files.');
}

/** Decode bytes to text: UTF-8 (with or without BOM), falling back to Windows-1252, which Excel CSV exports often use. */
function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

module.exports = { identifyFile, decodeText, UnsupportedFileError };
