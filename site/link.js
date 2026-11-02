// Browser side of the reveal link. Mirrors decryptToken() in
// extensions/models/secret_santa.ts; secret_santa_test.ts encrypts with the
// model and decrypts with this file, so the two can't drift apart.

const TOKEN_VERSION = "v1";

function fromBase64Url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Decrypt a `v1.<key>.<iv>.<ciphertext>` token into `{ g, r, y }`
 * (giver, receiver, year). Rejects if the token is malformed or was altered.
 * @param {string} token
 * @returns {Promise<{ g: string, r: string, y: number }>}
 */
export async function decryptToken(token) {
  const [version, k, iv, ct] = token.split(".");
  if (version !== TOKEN_VERSION || !k || !iv || !ct) {
    throw new Error("not a Secret Santa link token");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64Url(k),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(iv) },
    key,
    fromBase64Url(ct),
  );
  const p = JSON.parse(new TextDecoder().decode(plain));
  if (
    typeof p?.g !== "string" || typeof p?.r !== "string" ||
    typeof p?.y !== "number"
  ) {
    throw new Error("link token has an unexpected shape");
  }
  return p;
}

/**
 * Read the reveal from a URL hash. `#demo` gives sample names for trying
 * the page out; anything else must be a token.
 * @param {string} hash e.g. location.hash
 * @returns {Promise<{ giver: string, receiver: string, year: number, demo: boolean }>}
 */
export async function revealFromHash(hash) {
  const token = decodeURIComponent(hash.replace(/^#/, "")).trim();
  if (token === "demo") {
    return {
      giver: "Rudolph",
      receiver: "Mrs Claus",
      year: new Date().getFullYear(),
      demo: true,
    };
  }
  const p = await decryptToken(token);
  return { giver: p.g, receiver: p.r, year: p.y, demo: false };
}
