'use strict';

/**
 * Read-mostly JSON files, parsed once. Every signed-in request reads accounts.json and most read a workspace,
 * so parsing them each time cost ~15 ms per megabyte. A parsed copy is kept and reused while the file is unchanged.
 *
 * "Unchanged" is checked with fs.stat (inode, size, modification time) before every use, so a file replaced from
 * outside (a restore from backup) is picked up on the next request. The stores also drop their copy after every
 * write of their own. The kept copy is deep-frozen: it is shared by every reader, so a reader that tried to change
 * it would throw instead of quietly corrupting what the next request sees. Writers always start from a fresh read.
 */
const fs = require('node:fs/promises');

/** A value that changes whenever the file is replaced or rewritten; 'missing' when there is no file. */
async function fileKey(file) {
  try {
    const s = await fs.stat(file);
    return s.ino + ':' + s.size + ':' + s.mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return 'missing';
    throw err;
  }
}

/** Freeze an object graph (iteratively: no recursion limit on deep data). Returns the same object. */
function deepFreeze(root) {
  const stack = [root];
  while (stack.length) {
    const o = stack.pop();
    if (o === null || typeof o !== 'object' || Object.isFrozen(o)) continue;
    Object.freeze(o);
    for (const k of Object.keys(o)) stack.push(o[k]);
  }
  return root;
}

/**
 * Cache for one file: `get(load)` returns the cached value while the file key is unchanged, else calls load()
 * (once, even when many requests arrive together) and keeps its frozen result.
 */
class FileSnapshot {
  constructor(file) {
    this.file = file;
    this.entry = null; // { key, value }
    this.pending = null; // { key, promise }
  }

  async get(load) {
    const key = await fileKey(this.file); // stat first, then read: a write in between only causes one extra read
    if (this.entry && this.entry.key === key) return this.entry.value;
    if (this.pending && this.pending.key === key) return this.pending.promise;
    const promise = (async () => deepFreeze(await load(key === 'missing')))();
    this.pending = { key, promise };
    try {
      const value = await promise;
      if (this.pending && this.pending.promise === promise) this.entry = { key, value };
      return value;
    } finally {
      if (this.pending && this.pending.promise === promise) this.pending = null;
    }
  }

  /** Forget the cached value (after a write of our own). */
  clear() {
    this.entry = null;
    this.pending = null;
  }
}

module.exports = { FileSnapshot, deepFreeze, fileKey };
