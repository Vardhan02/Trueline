'use strict';

/**
 * Passwords: scrypt (memory-hard), per-user random salt, parameters stored with the hash so they can be raised later.
 * Secrets at rest (Google refresh tokens, webhook URLs): AES-256-GCM with a key derived from ENCRYPTION_KEY.
 * Tokens we only need to recognise (API keys, inbound links): stored as SHA-256, never in clear.
 */
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };

async function hashPassword(password, params = SCRYPT) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const expected = Buffer.from(parts[5], 'base64url');
  const key = await scrypt(String(password), Buffer.from(parts[4], 'base64url'), expected.length, { N, r, p, maxmem: 128 * N * r * 2 });
  return crypto.timingSafeEqual(key, expected);
}

/** A hash to verify against when the email is unknown, so a wrong email takes as long as a wrong password. */
let decoy;
const decoyHash = async () => (decoy = decoy || (await hashPassword(crypto.randomBytes(16).toString('hex'))));

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (prefix, bytes = 24) => prefix + crypto.randomBytes(bytes).toString('base64url');

function createVault(material) {
  if (!material) throw new Error('An encryption key is required');
  const key = Buffer.from(crypto.hkdfSync('sha256', String(material), 'trueline', 'secrets-v1', 32));
  return {
    seal(value) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
      return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
    },
    open(sealed) {
      const [v, iv, tag, ct] = String(sealed).split('.');
      if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unreadable secret');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'));
    }
  };
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9.-]{1,180}\.[a-z]{2,24}$/i;
const normalEmail = (e) =>
  String(e || '')
    .trim()
    .toLowerCase();
const validEmail = (e) => EMAIL.test(normalEmail(e)) && normalEmail(e).length <= 254;
/** Length beats complexity rules (NIST 800-63B): 10+ characters, not an obvious pick, not the email itself. */
function passwordProblem(pw, email) {
  const s = String(pw || '');
  if (s.length < 10) return 'Use at least 10 characters.';
  if (s.length > 200) return 'Use at most 200 characters.';
  if (/^(.)\1+$/.test(s) || /^(0123456789|1234567890|password\d*|qwertyuiop)$/i.test(s)) return 'That password is too easy to guess.';
  if (email && s.toLowerCase() === normalEmail(email)) return 'Do not use your email as the password.';
  return null;
}

module.exports = { hashPassword, verifyPassword, decoyHash, sha256, randomToken, createVault, normalEmail, validEmail, passwordProblem, SCRYPT };
