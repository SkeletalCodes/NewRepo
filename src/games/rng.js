'use strict';

/* Random numbers for every game: plain CSPRNG draws. There are no seeds to publish or verify. */
const crypto = require('node:crypto');

let buf = crypto.randomBytes(1024);
let pos = 0;
function float() {
  if (pos + 4 > buf.length) { buf = crypto.randomBytes(1024); pos = 0; }
  const v = buf.readUInt32BE(pos) / 4294967296;
  pos += 4;
  return v;
}

/** A fresh source for one bet or one action. The methods are what the game rules use. */
function makeRng() {
  return {
    float,
    int: (n) => Math.floor(float() * n),
    /** Remove and return a random element (draws without replacement). */
    pick: (pool) => pool.splice(Math.floor(float() * pool.length), 1)[0],
  };
}

module.exports = { makeRng };
