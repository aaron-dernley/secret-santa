// Browser side of the reveal link. Mirrors decryptToken() in
// extensions/models/secret_santa.ts; secret_santa_test.ts encrypts with the
// model and decrypts with this file, so the two can't drift apart.

const KEY_BYTES = 16;
const TAG_BYTES = 16;
// Each token's key encrypts one message only, so the nonce can be fixed.
const ZERO_IV = new Uint8Array(12);

function fromBase64Url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Decrypt a base64url token (128-bit AES-GCM key, then the ciphertext of
 * `giver\nreceiver`) into `{ g, r }`. Rejects if the token is malformed or
 * was altered.
 * @param {string} token
 * @returns {Promise<{ g: string, r: string }>}
 */
export async function decryptToken(token) {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("not a Secret Santa link token");
  }
  const bytes = fromBase64Url(token);
  if (bytes.length < KEY_BYTES + TAG_BYTES + 3) {
    throw new Error("not a Secret Santa link token");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    bytes.slice(0, KEY_BYTES),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ZERO_IV },
    key,
    bytes.slice(KEY_BYTES),
  );
  const parts = new TextDecoder().decode(plain).split("\n");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("link token has an unexpected shape");
  }
  return { g: parts[0], r: parts[1] };
}

/**
 * Read the reveal from a URL hash. `#demo` gives sample names for trying
 * the page out; anything else must be a token.
 * @param {string} hash e.g. location.hash
 * @returns {Promise<{ giver: string, receiver: string, demo: boolean }>}
 */
export async function revealFromHash(hash) {
  const token = decodeURIComponent(hash.replace(/^#/, "")).trim();
  if (token === "demo") {
    return { giver: "Rudolph", receiver: "Mrs Claus", demo: true };
  }
  const p = await decryptToken(token);
  return { giver: p.g, receiver: p.r, demo: false };
}
