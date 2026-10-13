'use strict';

/*
 * Provably fair randomness (same scheme as the original game site):
 *   - Before betting, the player sees SHA-256(server seed). The seed itself stays secret on the server.
 *   - Each bet uses HMAC-SHA256(server seed, "clientSeed:nonce:block"); every 4 bytes make one float in [0, 1).
 *   - Rotating the seed pair reveals the old server seed, so every past bet can be re-computed and checked.
 */

const crypto = require('node:crypto');

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Deterministic number stream for one bet. `used` counts floats drawn, so a stream can be resumed with skip(). */
function rngFor(serverSeed, clientSeed, nonce) {
  let block = 0;
  let buf = null;
  let pos = 32;
  let used = 0;
  const rng = {
    nonce,
    float() {
      if (pos >= 32) {
        buf = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:${block++}`).digest();
        pos = 0;
      }
      const f = buf[pos] / 256 + buf[pos + 1] / 65536 + buf[pos + 2] / 16777216 + buf[pos + 3] / 4294967296;
      pos += 4;
      used++;
      return f;
    },
    int(n) { return Math.floor(rng.float() * n); },
    /** Remove and return a random element (draws without replacement). */
    pick(pool) { return pool.splice(Math.floor(rng.float() * pool.length), 1)[0]; },
    skip(n) { for (let i = 0; i < n; i++) rng.float(); return rng; },
    get used() { return used; },
  };
  return rng;
}

module.exports = { randomHex, sha256hex, rngFor };
