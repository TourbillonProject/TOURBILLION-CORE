import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Random URL-safe token. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Passphrase hashing — scrypt with per-hash salt. Format: scrypt$N$r$p$salt$hash
// ---------------------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassphrase(passphrase: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(passphrase, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassphrase(passphrase: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(passphrase, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Symmetric encryption for stored credentials — AES-256-GCM.
// The master key comes from TC_MASTER_KEY or is generated once into
// <dataDir>/master.key with 0600 permissions.
// ---------------------------------------------------------------------------

export class Cipher {
  private key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('Master key must be 32 bytes');
    this.key = key;
  }

  static fromConfig(masterKey: string | null, dataDir: string): Cipher {
    if (masterKey) {
      const buf = decodeKey(masterKey);
      return new Cipher(buf);
    }
    const file = path.join(dataDir, 'master.key');
    if (fs.existsSync(file)) {
      return new Cipher(decodeKey(fs.readFileSync(file, 'utf8').trim()));
    }
    fs.mkdirSync(dataDir, { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
    return new Cipher(key);
  }

  encrypt(plaintext: string): { ciphertext: string; iv: string; tag: string } {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
  }

  decrypt(box: { ciphertext: string; iv: string; tag: string }): string {
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(box.ciphertext, 'base64')), d.final()]).toString('utf8');
  }
}

function decodeKey(s: string): Buffer {
  const trimmed = s.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const b = Buffer.from(trimmed, 'base64');
  if (b.length !== 32) throw new Error('TC_MASTER_KEY must be 32 bytes, encoded as base64 or 64 hex characters');
  return b;
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
