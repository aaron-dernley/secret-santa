/**
 * Family Secret Santa as a typed, versioned Swamp model. The organiser keeps
 * the roster (names plus vault-referenced phone numbers), couple/household
 * exclusions and the event details in global arguments. Three methods then
 * run the year:
 *
 * - `draw` assigns everyone a person to buy for. Nobody draws themselves,
 *   nobody draws someone they're excluded from, and nobody gets the same
 *   person as in the last `avoidRepeatYears` years.
 * - `compose` turns each pairing into a personal reveal link plus an SMS
 *   body. The giver and receiver names are AES-GCM encrypted into the link's
 *   `#fragment`, which browsers never send to the web server, so the static
 *   reveal page hosts no names at all.
 * - `verify` decrypts every composed link again and checks that the set
 *   still forms a valid draw before anything is sent.
 *
 * Sending is done by the `send_outbox` method this package adds to
 * `@keeb/twilio/messaging` (see `twilio_outbox.ts`).
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Default SMS body. GSM-7 characters only, so each 153-character segment is used fully. */
export const DEFAULT_MESSAGE_TEMPLATE =
  "Ho ho ho {name}! Your {event} {year} Secret Santa has been drawn. Tap your secret link to find out who you're buying for (don't share it!): {link}";

/** Version prefix of the reveal token carried in each link's `#fragment`. */
export const TOKEN_VERSION = "v1";

const PairSchema = z.object({
  giver: z.string().describe("Name of the person buying the gift."),
  receiver: z.string().describe("Name of the person receiving the gift."),
});

/** One giver → receiver assignment. */
export interface Pair {
  /** Name of the person buying the gift. */
  giver: string;
  /** Name of the person receiving the gift. */
  receiver: string;
}

const ParticipantSchema = z.object({
  name: z.string().trim().min(1).max(24).describe(
    "First name or nickname as it should appear in the reveal, e.g. Grandma. Must be unique (case-insensitive).",
  ),
  phone: z.string().min(1).describe(
    "Mobile number. Store it in a vault and reference it, e.g. ${{ vault.get(santa, PHONE_GRANDMA) }}. UK formats (07…, +44…, 0044…) and E.164 are accepted.",
  ),
});

/** One person taking part in the draw. */
export interface Participant {
  /** Name as it appears in the reveal; unique, case-insensitive. */
  name: string;
  /** Mobile number (usually resolved from a vault reference). */
  phone: string;
}

const HistoryYearSchema = z.object({
  year: z.number().int().describe("The year this draw happened."),
  pairs: z.array(PairSchema).describe(
    "Who bought for whom that year. Used only to avoid repeats.",
  ),
});

/** A previous year's draw entered by hand, e.g. last year's before this model existed. */
export interface HistoryYear {
  /** The year this draw happened. */
  year: number;
  /** Who bought for whom that year. */
  pairs: Pair[];
}

const GlobalArgsSchema = z.object({
  eventName: z.string().min(1).max(40).default("Family Secret Santa").describe(
    "Event name used in the SMS body.",
  ),
  year: z.number().int().min(2000).max(2100).describe(
    "The year being drawn. Draws are stored per year, so last year's results can be avoided next time.",
  ),
  baseUrl: z.string().url().describe(
    "Public URL of the static reveal page, e.g. https://you.github.io/secret-santa/. The encrypted token is appended after #.",
  ),
  participants: z.array(ParticipantSchema).min(3).describe(
    "Everyone taking part. At least three people are needed for a draw where nobody gets themselves and exclusions can still be satisfied.",
  ),
  exclusions: z.array(z.tuple([z.string(), z.string()])).default([]).describe(
    "Pairs of names who must not draw each other, e.g. couples. Applies in both directions.",
  ),
  avoidRepeatYears: z.number().int().min(0).max(10).default(1).describe(
    "Nobody gets the same person they bought for in this many previous years. 0 turns repeat avoidance off.",
  ),
  history: z.array(HistoryYearSchema).default([]).describe(
    "Earlier draws entered by hand (e.g. last year's, done on paper). Draws made by this model are remembered automatically.",
  ),
  messageTemplate: z.string().min(1).default(DEFAULT_MESSAGE_TEMPLATE).describe(
    "SMS body. Placeholders: {name}, {event}, {year}, {link}. Must contain {link}.",
  ),
});

/** Validated global arguments for a `@aaronge/secret-santa` model instance. */
export interface GlobalArgs {
  /** Event name used in the SMS body. */
  eventName: string;
  /** The year being drawn. */
  year: number;
  /** Public URL of the static reveal page. */
  baseUrl: string;
  /** Everyone taking part. */
  participants: Participant[];
  /** Pairs who must not draw each other (both directions). */
  exclusions: [string, string][];
  /** How many previous years' pairs to avoid repeating. */
  avoidRepeatYears: number;
  /** Earlier draws entered by hand. */
  history: HistoryYear[];
  /** SMS body template with {name}, {event}, {year}, {link}. */
  messageTemplate: string;
}

const DrawSchema = z.object({
  year: z.number().describe("The year this draw is for."),
  eventName: z.string().describe("Event name at the time of the draw."),
  pairs: z.array(PairSchema).describe(
    "Every giver → receiver assignment, one per participant.",
  ),
  drawnAt: z.string().describe("ISO-8601 timestamp of the draw."),
});

const DrawSummarySchema = z.object({
  year: z.number().describe("The year this summary describes."),
  participantCount: z.number().describe("How many people were drawn."),
  exclusionCount: z.number().describe(
    "How many exclusion pairs were applied.",
  ),
  blockedRepeatCount: z.number().describe(
    "How many giver → receiver pairs were blocked because they happened in recent years.",
  ),
  attempts: z.number().describe(
    "Random shuffles tried before a valid draw was found (backtracking is used if shuffling fails).",
  ),
  drawnAt: z.string().describe("ISO-8601 timestamp of the draw."),
});

const OutboxMessageSchema = z.object({
  name: z.string().describe("Who this message is for (the giver)."),
  to: z.string().describe("Destination number in E.164 format."),
  body: z.string().describe("Full SMS text, including the reveal link."),
  segments: z.number().describe(
    "SMS segments this body will be billed as.",
  ),
});

/** One SMS ready to send. */
export interface OutboxMessage {
  /** Who this message is for (the giver). */
  name: string;
  /** Destination number in E.164 format. */
  to: string;
  /** Full SMS text, including the reveal link. */
  body: string;
  /** SMS segments this body will be billed as. */
  segments: number;
}

const OutboxSchema = z.object({
  year: z.number().describe("The year these messages are for."),
  messages: z.array(OutboxMessageSchema).describe(
    "One message per participant.",
  ),
  totalSegments: z.number().describe(
    "Sum of segments across all messages; multiply by your SMS rate for the cost.",
  ),
  composedAt: z.string().describe("ISO-8601 timestamp of composition."),
});

const LinkCheckSchema = z.object({
  year: z.number().describe("The year that was checked."),
  ok: z.boolean().describe(
    "True when every link decrypts and the set is a valid draw.",
  ),
  checked: z.number().describe("How many messages were checked."),
  problems: z.array(z.string()).describe(
    "Human-readable problems. Never contains who drew whom.",
  ),
  maxSegments: z.number().describe("Largest per-message segment count."),
  totalSegments: z.number().describe("Sum of segments across all messages."),
  checkedAt: z.string().describe("ISO-8601 timestamp of the check."),
});

/** Result of {@linkcode verifyOutbox}. */
export interface LinkCheck {
  /** The year that was checked. */
  year: number;
  /** True when every link decrypts and the set is a valid draw. */
  ok: boolean;
  /** How many messages were checked. */
  checked: number;
  /** Human-readable problems; never contains who drew whom. */
  problems: string[];
  /** Largest per-message segment count. */
  maxSegments: number;
  /** Sum of segments across all messages. */
  totalSegments: number;
  /** ISO-8601 timestamp of the check. */
  checkedAt: string;
}

/** Minimal logger shape methods depend on — matches `context.logger`. */
export interface MinimalLogger {
  /** Log a user-visible progress or state-transition message. */
  info(msg: string, props?: Record<string, unknown>): void;
  /** Log a recoverable issue or degraded-behavior message. */
  warn(msg: string, props?: Record<string, unknown>): void;
}

/** Returns a uniformly random integer in `[0, n)`. Injected in tests. */
export type RandomInt = (n: number) => number;

/** Cryptographically secure {@linkcode RandomInt}, rejection-sampled to avoid modulo bias. */
export const cryptoRandomInt: RandomInt = (n: number): number => {
  if (n <= 0) throw new Error("cryptoRandomInt needs n > 0");
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
};

/** Case- and whitespace-insensitive key for comparing names. */
export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Normalise a mobile number to E.164. Accepts E.164 (`+447700900123`),
 * UK national (`07700 900123`) and UK international-prefix (`0044 7700…`)
 * forms, with any spaces, dashes or brackets. Throws on anything else.
 */
export function normalisePhone(raw: string): string {
  const compact = raw.replace(/[\s\-().]/g, "");
  let e164 = compact;
  if (/^00[1-9]/.test(compact)) e164 = "+" + compact.slice(2);
  else if (/^07\d{9}$/.test(compact)) e164 = "+44" + compact.slice(1);
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) {
    throw new Error(
      "phone number is not a valid mobile number (use 07…, +44… or another E.164 number)",
    );
  }
  return e164;
}

/**
 * Check the roster for problems that would make a draw meaningless:
 * duplicate names, exclusions naming unknown people, or someone excluded
 * from themselves. Returns a list of human-readable problems (empty when OK).
 */
export function validateRoster(
  participants: Participant[],
  exclusions: [string, string][],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of participants) {
    const key = nameKey(p.name);
    if (seen.has(key)) problems.push(`"${p.name}" appears more than once`);
    seen.add(key);
    try {
      normalisePhone(p.phone);
    } catch {
      problems.push(`${p.name}'s phone number is not a valid mobile number`);
    }
  }
  for (const [a, b] of exclusions) {
    for (const n of [a, b]) {
      if (!seen.has(nameKey(n))) {
        problems.push(`exclusion names "${n}", who isn't a participant`);
      }
    }
    if (nameKey(a) === nameKey(b)) {
      problems.push(`exclusion pairs "${a}" with themselves`);
    }
  }
  return problems;
}

/**
 * Build the `allowed[giver][receiver]` matrix over `names` (by index).
 * A cell is false when giver and receiver are the same person, when they
 * are excluded from each other (either direction), or when the pair
 * appears in `blockedPairs` (recent years, giver → receiver only).
 */
export function buildConstraintMatrix(
  names: string[],
  exclusions: [string, string][],
  blockedPairs: Pair[],
): boolean[][] {
  const idx = new Map(names.map((n, i) => [nameKey(n), i]));
  const allowed = names.map((_, i) => names.map((_, j) => i !== j));
  for (const [a, b] of exclusions) {
    const i = idx.get(nameKey(a)), j = idx.get(nameKey(b));
    if (i === undefined || j === undefined) continue;
    allowed[i][j] = false;
    allowed[j][i] = false;
  }
  for (const { giver, receiver } of blockedPairs) {
    const i = idx.get(nameKey(giver)), j = idx.get(nameKey(receiver));
    if (i === undefined || j === undefined) continue;
    allowed[i][j] = false;
  }
  return allowed;
}

/** Outcome of {@linkcode solveDraw}. */
export interface DrawResult {
  /** One assignment per name, in the order of the input names. */
  pairs: Pair[];
  /** Random shuffles tried before success (0 when backtracking found it). */
  attempts: number;
}

/**
 * Find a random assignment of receivers to givers that respects `allowed`.
 *
 * Draws uniformly random permutations and keeps the first valid one, which
 * makes every valid draw equally likely. If none turns up within
 * `maxShuffles` (only when constraints are very tight), it falls back to a
 * randomised backtracking search. That search either finds a valid draw or
 * proves none exists, in which case this throws with the reason.
 */
export function solveDraw(
  names: string[],
  allowed: boolean[][],
  random: RandomInt = cryptoRandomInt,
  maxShuffles = 20_000,
): DrawResult {
  const n = names.length;
  const order = names.map((_, i) => i);
  const toPairs = (perm: number[]): Pair[] =>
    perm.map((r, g) => ({ giver: names[g], receiver: names[r] }));

  for (let attempt = 1; attempt <= maxShuffles; attempt++) {
    // Fisher–Yates shuffle
    for (let i = n - 1; i > 0; i--) {
      const j = random(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    if (order.every((r, g) => allowed[g][r])) {
      return { pairs: toPairs(order), attempts: attempt };
    }
  }

  const stuck = names.filter((_, g) => !allowed[g].some(Boolean));
  if (stuck.length) {
    throw new Error(
      `No valid draw: ${
        stuck.join(", ")
      } can't be given anyone. Relax their exclusions or set avoidRepeatYears to 0.`,
    );
  }

  // Randomised backtracking, most-constrained giver first
  const perm = new Array<number>(n).fill(-1);
  const used = new Array<boolean>(n).fill(false);
  const givers = order.slice().sort((a, b) =>
    allowed[a].filter(Boolean).length - allowed[b].filter(Boolean).length
  );
  const search = (k: number): boolean => {
    if (k === n) return true;
    const g = givers[k];
    const options = order.filter((r) => allowed[g][r] && !used[r]);
    for (let i = options.length - 1; i > 0; i--) {
      const j = random(i + 1);
      [options[i], options[j]] = [options[j], options[i]];
    }
    for (const r of options) {
      perm[g] = r;
      used[r] = true;
      if (search(k + 1)) return true;
      used[r] = false;
    }
    return false;
  };
  if (!search(0)) {
    throw new Error(
      "No valid draw exists with these exclusions and repeat rules. Remove an exclusion or set avoidRepeatYears to 0.",
    );
  }
  return { pairs: toPairs(perm), attempts: 0 };
}

// ---------- reveal links ----------

/** What a reveal link decrypts to. Short keys keep the URL (and SMS) short. */
export interface RevealPayload {
  /** Giver — the person opening the link. */
  g: string;
  /** Receiver — the person they're buying for. */
  r: string;
  /** Year of the draw. */
  y: number;
}

/** Encode bytes as unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode unpadded base64url. */
export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Encrypt a payload into a self-contained token, `v1.<key>.<iv>.<ciphertext>`.
 * Each token has its own random 128-bit AES-GCM key, so one link reveals
 * nothing about another. The key travels inside the token: the link is the
 * secret, and the encryption stops the name being read off the URL by eye.
 * The page decrypts it with {@linkcode decryptToken} in site/link.js.
 */
export async function encryptToken(payload: RevealPayload): Promise<string> {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
  ]);
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain),
  );
  return [TOKEN_VERSION, toBase64Url(raw), toBase64Url(iv), toBase64Url(ct)]
    .join(".");
}

/** Decrypt a token from {@linkcode encryptToken}. Throws if it was altered or is malformed. */
export async function decryptToken(token: string): Promise<RevealPayload> {
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
  return p as RevealPayload;
}

/** Join the reveal page URL and a token: everything after `#` stays in the browser. */
export function buildLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/#.*$/, "")}#${token}`;
}

/** Pull the token back out of a link (or a whole SMS body containing one). */
export function extractToken(text: string): string | null {
  const m = text.match(/#(v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/** Fill the message template's placeholders. */
export function renderMessage(
  template: string,
  values: { name: string; event: string; year: number; link: string },
): string {
  return template
    .replaceAll("{name}", values.name)
    .replaceAll("{event}", values.event)
    .replaceAll("{year}", String(values.year))
    .replaceAll("{link}", values.link);
}

const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "^{}\\[~]|€";

/**
 * How many SMS segments a body is billed as. GSM-7 text fits 160
 * characters in one segment or 153 per segment when split (extension
 * characters like `{` count double). Anything else, such as emoji or curly
 * quotes, switches to UCS-2: 70 characters, or 67 per segment.
 */
export function smsSegments(body: string): number {
  let units = 0;
  let gsm = true;
  for (const c of body) {
    if (GSM7.includes(c)) units += 1;
    else if (GSM7_EXT.includes(c)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (!gsm) {
    const len = [...body].reduce((n, c) => n + (c.length > 1 ? 2 : 1), 0);
    return len <= 70 ? 1 : Math.ceil(len / 67);
  }
  return units <= 160 ? 1 : Math.ceil(units / 153);
}

/**
 * Re-check a composed outbox against the draw and rules. It decrypts every
 * link and confirms that:
 * - each link names its own recipient as the giver,
 * - the receivers match the stored draw and are a permutation of everyone,
 * - nobody has themselves or someone they're excluded from.
 *
 * Problems never mention who drew whom, so they're safe to print.
 */
export async function verifyOutbox(
  args: GlobalArgs,
  draw: { year: number; pairs: Pair[] },
  outbox: { year: number; messages: OutboxMessage[] },
): Promise<LinkCheck> {
  const problems: string[] = [];
  const names = args.participants.map((p) => p.name);
  const drawn = new Map(
    draw.pairs.map((p) => [nameKey(p.giver), nameKey(p.receiver)]),
  );
  const excluded = new Set(
    args.exclusions.flatMap(([a, b]) => [
      `${nameKey(a)}>${nameKey(b)}`,
      `${nameKey(b)}>${nameKey(a)}`,
    ]),
  );
  const receivers = new Set<string>();

  if (outbox.year !== args.year || draw.year !== args.year) {
    problems.push(
      `outbox/draw are for ${outbox.year}/${draw.year} but the model is set to ${args.year}`,
    );
  }
  if (outbox.messages.length !== names.length) {
    problems.push(
      `${outbox.messages.length} messages for ${names.length} participants`,
    );
  }
  for (const m of outbox.messages) {
    const token = extractToken(m.body);
    if (!token) {
      problems.push(`${m.name}'s message has no reveal link`);
      continue;
    }
    if (!m.body.includes(args.baseUrl.replace(/#.*$/, ""))) {
      problems.push(`${m.name}'s link doesn't point at baseUrl`);
    }
    let p: RevealPayload;
    try {
      p = await decryptToken(token);
    } catch {
      problems.push(`${m.name}'s link doesn't decrypt`);
      continue;
    }
    const g = nameKey(p.g), r = nameKey(p.r);
    if (g !== nameKey(m.name)) {
      problems.push(`${m.name}'s link is addressed to someone else`);
    }
    if (p.y !== args.year) problems.push(`${m.name}'s link is for ${p.y}`);
    if (drawn.get(g) !== r) {
      problems.push(`${m.name}'s link doesn't match the stored draw`);
    }
    if (g === r) problems.push(`${m.name}'s link gives them themselves`);
    if (excluded.has(`${g}>${r}`)) {
      problems.push(`${m.name}'s link breaks an exclusion`);
    }
    receivers.add(r);
    try {
      normalisePhone(m.to);
    } catch {
      problems.push(`${m.name}'s phone number is invalid`);
    }
  }
  if (
    receivers.size !== names.length ||
    names.some((n) => !receivers.has(nameKey(n)))
  ) {
    problems.push("not everyone is being bought for exactly once");
  }
  const segs = outbox.messages.map((m) => smsSegments(m.body));
  return {
    year: args.year,
    ok: problems.length === 0,
    checked: outbox.messages.length,
    problems,
    maxSegments: segs.length ? Math.max(...segs) : 0,
    totalSegments: segs.reduce((a, b) => a + b, 0),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Undo vault round-tripping. A `sensitiveOutput` resource stores each
 * top-level field in the vault as a string, so reading it back gives `"2026"`
 * for a number and a JSON string for an array. Non-strings pass through, and
 * strings that aren't JSON are left alone.
 */
export function revive(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Read an outbox resource as stored (possibly vault-resolved strings) into its real shape. */
export function readOutbox(
  raw: Record<string, unknown>,
): { year: number; messages: OutboxMessage[] } {
  const year = Number(revive(raw.year));
  const messages = revive(raw.messages);
  if (!Array.isArray(messages) || !Number.isFinite(year)) {
    throw new Error(
      "The stored outbox isn't readable (is the vault that holds it configured?); run compose again",
    );
  }
  return { year, messages: messages as OutboxMessage[] };
}

/** Collect giver → receiver pairs from the last `years` years, from hand-entered history and stored draws. */
export function recentPairs(
  year: number,
  years: number,
  history: HistoryYear[],
  storedDraws: { year: number; pairs: Pair[] }[],
): Pair[] {
  const inWindow = (y: number) => y < year && y >= year - years;
  return [...history, ...storedDraws]
    .filter((h) => inWindow(h.year))
    .flatMap((h) => h.pairs);
}

/** Write-side of the method context, typed to just what these methods use. */
interface SantaContext {
  globalArgs: GlobalArgs;
  logger: MinimalLogger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
}

/** Instance name of the stored draw for a year. */
export const drawInstance = (year: number): string => `draw-${year}`;

/** Swamp model definition for `@aaronge/secret-santa`. */
export const model = {
  type: "@aaronge/secret-santa",
  version: "2026.11.02.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    draw: {
      description:
        "Who buys for whom, one instance per year (draw-<year>). Kept so later years can avoid repeats.",
      schema: DrawSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    drawSummary: {
      description:
        "Non-secret facts about the latest draw: headcount, constraints applied, solver attempts.",
      schema: DrawSummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    outbox: {
      description:
        "The SMS for each participant, with phone numbers and reveal links. Stored in the vault (sensitive), never in plain data.",
      schema: OutboxSchema,
      sensitiveOutput: true,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    linkCheck: {
      description:
        "Pass/fail result of decrypting every composed link and re-validating the draw. Never names pairings.",
      schema: LinkCheckSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    draw: {
      description:
        "Draw this year's Secret Santa. Keeps an existing draw for the year unless redraw is true, so re-running the workflow never reshuffles after links have gone out.",
      arguments: z.object({
        redraw: z.boolean().default(false).describe(
          "Throw away this year's existing draw and draw again. Anyone already sent a link will have a stale one.",
        ),
      }),
      execute: async (
        args: { redraw: boolean },
        context: SantaContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const g = context.globalArgs;
        const problems = validateRoster(g.participants, g.exclusions);
        if (problems.length) {
          throw new Error(`Roster problems: ${problems.join("; ")}`);
        }

        const existing = await context.readResource(drawInstance(g.year));
        if (existing && !args.redraw) {
          context.logger.info(
            "{year} is already drawn (at {drawnAt}); keeping it. Pass redraw=true to draw again.",
            { year: g.year, drawnAt: existing.drawnAt },
          );
          return { dataHandles: [] };
        }

        const stored: { year: number; pairs: Pair[] }[] = [];
        for (let y = g.year - g.avoidRepeatYears; y < g.year; y++) {
          const d = await context.readResource(drawInstance(y));
          if (d) stored.push(d as { year: number; pairs: Pair[] });
        }
        const blocked = recentPairs(
          g.year,
          g.avoidRepeatYears,
          g.history,
          stored,
        );
        const names = g.participants.map((p) => p.name.trim());
        const allowed = buildConstraintMatrix(names, g.exclusions, blocked);
        const { pairs, attempts } = solveDraw(names, allowed);

        const drawnAt = new Date().toISOString();
        context.logger.info(
          "Drew {count} people for {year} ({attempts} shuffles). Pairings are stored, not logged.",
          { count: names.length, year: g.year, attempts },
        );
        const drawHandle = await context.writeResource(
          "draw",
          drawInstance(g.year),
          { year: g.year, eventName: g.eventName, pairs, drawnAt },
        );
        const summaryHandle = await context.writeResource(
          "drawSummary",
          "summary",
          {
            year: g.year,
            participantCount: names.length,
            exclusionCount: g.exclusions.length,
            blockedRepeatCount: blocked.length,
            attempts,
            drawnAt,
          },
        );
        return { dataHandles: [drawHandle, summaryHandle] };
      },
    },
    compose: {
      description:
        "Turn this year's draw into one SMS per participant, each with a personal encrypted reveal link. Writes the sensitive outbox resource.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: SantaContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const g = context.globalArgs;
        if (!g.messageTemplate.includes("{link}")) {
          throw new Error("messageTemplate must contain {link}");
        }
        const draw = await context.readResource(drawInstance(g.year)) as
          | { year: number; pairs: Pair[] }
          | null;
        if (!draw) {
          throw new Error(
            `No draw for ${g.year} yet; run the draw method first`,
          );
        }
        const byGiver = new Map(draw.pairs.map((p) => [nameKey(p.giver), p]));
        const messages: OutboxMessage[] = [];
        for (const person of g.participants) {
          const pair = byGiver.get(nameKey(person.name));
          if (!pair) {
            throw new Error(
              `${person.name} isn't in the ${g.year} draw (the roster changed). Run draw with redraw=true.`,
            );
          }
          const token = await encryptToken({
            g: pair.giver,
            r: pair.receiver,
            y: g.year,
          });
          const body = renderMessage(g.messageTemplate, {
            name: person.name.trim(),
            event: g.eventName,
            year: g.year,
            link: buildLink(g.baseUrl, token),
          });
          messages.push({
            name: person.name.trim(),
            to: normalisePhone(person.phone),
            body,
            segments: smsSegments(body),
          });
        }
        if (draw.pairs.length !== messages.length) {
          throw new Error(
            `The ${g.year} draw has ${draw.pairs.length} people but the roster has ${messages.length}. Run draw with redraw=true.`,
          );
        }
        const totalSegments = messages.reduce((n, m) => n + m.segments, 0);
        context.logger.info(
          "Composed {count} messages ({segments} SMS segments in total)",
          { count: messages.length, segments: totalSegments },
        );
        const handle = await context.writeResource("outbox", "outbox", {
          year: g.year,
          messages,
          totalSegments,
          composedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    verify: {
      description:
        "Decrypt every composed link and re-check the draw rules. Writes linkCheck with ok=true/false; a workflow assert should gate sending on it.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: SantaContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const g = context.globalArgs;
        const draw = await context.readResource(drawInstance(g.year)) as
          | { year: number; pairs: Pair[] }
          | null;
        const stored = await context.readResource("outbox");
        if (!draw || !stored) {
          throw new Error("Nothing to verify; run draw and compose first");
        }
        const result = await verifyOutbox(g, draw, readOutbox(stored));
        if (result.ok) {
          context.logger.info(
            "All {count} links decrypt and form a valid draw",
            { count: result.checked },
          );
        } else {
          for (const p of result.problems) context.logger.warn(p);
        }
        const handle = await context.writeResource(
          "linkCheck",
          "linkcheck",
          result as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
