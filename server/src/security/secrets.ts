import type { Database } from '../db.js';
import { nowIso } from '../db.js';
import type { Cipher } from './crypto.js';

/**
 * Encrypted credential store. Values never leave the server: API routes only
 * ever expose whether a secret exists and a masked preview.
 */
export class SecretStore {
  constructor(
    private db: Database,
    private cipher: Cipher,
  ) {}

  set(name: string, value: string) {
    const box = this.cipher.encrypt(value);
    this.db.run(
      `INSERT INTO secrets(name, ciphertext, iv, tag, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at`,
      name,
      box.ciphertext,
      box.iv,
      box.tag,
      nowIso(),
    );
  }

  get(name: string): string | null {
    const row = this.db.get<{ ciphertext: string; iv: string; tag: string }>('SELECT ciphertext, iv, tag FROM secrets WHERE name = ?', name);
    if (!row) return null;
    try {
      return this.cipher.decrypt(row);
    } catch {
      // Wrong master key or tampered data. Treat as missing rather than crash.
      return null;
    }
  }

  getJson<T>(name: string): T | null {
    const v = this.get(name);
    if (!v) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }

  setJson(name: string, value: unknown) {
    this.set(name, JSON.stringify(value));
  }

  has(name: string): boolean {
    return !!this.db.get('SELECT 1 FROM secrets WHERE name = ?', name);
  }

  updatedAt(name: string): string | null {
    return this.db.get<{ updated_at: string }>('SELECT updated_at FROM secrets WHERE name = ?', name)?.updated_at ?? null;
  }

  delete(name: string) {
    this.db.run('DELETE FROM secrets WHERE name = ?', name);
  }
}
