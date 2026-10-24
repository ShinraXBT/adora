// Persists every X account seen linked on pump.fun, and which alerts were already sent.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(file, { log = console.log, saveDelayMs = 2000 } = {}) {
    this.file = file;
    this.log = log;
    this.saveDelayMs = saveDelayMs;
    this.data = { version: 1, linked: {} };
    this.timer = null;
    if (!file) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed?.linked) this.data = parsed;
    } catch (e) {
      if (e.code !== 'ENOENT') this.log(`[store] ${file} illisible (${e.message}), départ à vide`);
    }
  }

  get size() {
    return Object.keys(this.data.linked).length;
  }

  get(key) {
    return this.data.linked[key];
  }

  set(key, rec) {
    this.data.linked[key] = rec;
    this.scheduleSave();
  }

  scheduleSave() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.saveDelayMs);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
    } catch (e) {
      this.log(`[store] sauvegarde impossible: ${e.message}`);
    }
  }
}
