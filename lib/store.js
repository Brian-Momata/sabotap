'use strict';

const fs = require('fs');
const path = require('path');

// Single-file JSON persistence with atomic, debounced writes.
class Store {
  constructor(file) {
    this.file = file;
    this.data = { players: {}, friendships: [] };
    this.saveTimer = null;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { players: {}, friendships: [], ...parsed };
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('store: failed to load, starting fresh:', e.message);
    }
  }

  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 200);
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('store: save failed:', e.message);
    }
  }
}

module.exports = Store;
