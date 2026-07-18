'use strict';

const fs = require('fs');
const path = require('path');

// Single-file JSON persistence with atomic, debounced writes.
class Store {
  constructor(file, defaults = { players: {}, friendships: [] }, debounceMs = 200) {
    this.file = file;
    this.debounceMs = debounceMs;
    this.data = { ...defaults };
    this.saveTimer = null;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...defaults, ...parsed };
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('store: failed to load, starting fresh:', e.message);
    }
  }

  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, this.debounceMs);
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
