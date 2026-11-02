/**
 * Adds a fan-out `send_outbox` method to `@keeb/twilio/messaging`. It sends
 * every message in another model's `outbox` resource in one execution.
 *
 * Messages come from the outbox's `messages` attribute. A workflow wires it
 * in with a CEL expression; swamp resolves the vault-stored value at run
 * time and masks secret values in logs and reports. Without that input, the
 * method reads the outbox itself through `readModelData`, which suits
 * outboxes that aren't stored as sensitive. It talks to Twilio's REST API
 * with `fetch`, so it adds no npm dependencies.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Twilio's documented per-number send rate for long codes is 1 message/second. */
export const DEFAULT_THROTTLE_MS = 1100;

/** One message to send, as stored in an outbox resource. */
export interface OutboxEntry {
  /** Recipient's name, used for logging and the summary (never the number). */
  name: string;
  /** Destination number, E.164; absent for people without one, who are skipped. */
  to?: string;
  /** SMS body. */
  body: string;
}

/** Twilio account credentials, from the messaging model's global arguments. */
export interface TwilioCredentials {
  /** Account SID (starts AC). */
  accountSid: string;
  /** Auth token. */
  authToken: string;
}

/** The parts of Twilio's Message response this method keeps. */
export interface SentMessage {
  /** Message SID (starts SM). */
  sid: string;
  /** Initial delivery status, usually "queued" or "accepted". */
  status: string;
  /** Destination as Twilio recorded it. */
  to: string;
  /** Sender as Twilio recorded it. */
  from: string;
  /** Body as Twilio recorded it. */
  body: string;
  /** Direction, "outbound-api" for sends. */
  direction: string;
  /** When Twilio sent it, if known yet. */
  dateSent: string | null;
}

/** `fetch`-compatible function, injectable for tests. */
export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

const SenderSchema = z.string().refine(
  (s) =>
    /^\+[1-9]\d{7,14}$/.test(s) ||
    (/^[A-Za-z0-9 ]{1,11}$/.test(s) && /[A-Za-z]/.test(s)),
  "from must be an E.164 number (+447…) or an alphanumeric sender ID of up to 11 letters/digits containing at least one letter (e.g. SANTA)",
);

/** Mask a phone number for logs, keeping only the last three digits. */
export function maskNumber(e164: string): string {
  return e164.length > 3
    ? `${"*".repeat(e164.length - 3)}${e164.slice(-3)}`
    : "***";
}

/** Send one SMS through Twilio's Messages REST endpoint. Throws with Twilio's error message on failure. */
export async function sendTwilioSms(
  creds: TwilioCredentials,
  msg: { to: string; from: string; body: string },
  fetchImpl: FetchLike = fetch,
): Promise<SentMessage> {
  const url =
    `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${
        btoa(`${creds.accountSid}:${creds.authToken}`)
      }`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: msg.to, From: msg.from, Body: msg.body })
      .toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = json?.code ? ` (Twilio error ${json.code})` : "";
    throw new Error(`${json?.message ?? `HTTP ${res.status}`}${code}`);
  }
  return {
    sid: String(json.sid),
    status: String(json.status ?? "unknown"),
    to: String(json.to ?? msg.to),
    from: String(json.from ?? msg.from),
    body: String(json.body ?? msg.body),
    direction: String(json.direction ?? "outbound-api"),
    dateSent: json.date_sent ?? null,
  };
}

/**
 * Validate a list of outbox messages. Accepts the array itself or its JSON
 * text, since swamp stores each top-level field of a `sensitiveOutput`
 * resource in the vault as a string.
 */
export function parseMessages(value: unknown, label: string): OutboxEntry[] {
  let messages = value;
  if (typeof messages === "string") {
    if (messages.trimStart().startsWith("${{")) {
      throw new Error(
        `${label} is still an unresolved vault reference; pass its messages to this method with a workflow input expression (see the README)`,
      );
    }
    try {
      messages = JSON.parse(messages);
    } catch {
      // fall through to the shape check below
    }
  }
  if (!Array.isArray(messages)) {
    throw new Error(`${label} has no messages array`);
  }
  return messages.map((m, i) => {
    if (
      typeof m?.name !== "string" || typeof m?.body !== "string" ||
      (m?.to !== undefined && typeof m.to !== "string")
    ) {
      throw new Error(`${label} message ${i + 1} is missing name/body`);
    }
    if (m.to?.startsWith("${{")) {
      throw new Error(
        `${label} message for ${m.name} still holds an unresolved vault reference`,
      );
    }
    return m.to
      ? { name: m.name, to: m.to, body: m.body }
      : { name: m.name, body: m.body };
  });
}

/** Pick the latest version of the named outbox instance from `readModelData` records. */
export function pickOutbox(
  records: {
    name: string;
    isLatest: boolean;
    attributes: Record<string, unknown>;
  }[],
  instance: string,
): OutboxEntry[] {
  const rec = records.find((r) => r.name === instance && r.isLatest) ??
    records.filter((r) => r.name === instance).at(-1);
  if (!rec) {
    throw new Error(
      `No "${instance}" outbox found; run the source model's compose method first`,
    );
  }
  return parseMessages(rec.attributes.messages, `"${instance}"`);
}

const BulkSendSchema = z.object({
  outbox: z.string().describe(
    "Source model and outbox instance that was sent.",
  ),
  dryRun: z.boolean().describe("True when nothing was actually sent."),
  sent: z.array(z.object({
    name: z.string(),
    sid: z.string(),
    status: z.string(),
  })).describe("Messages Twilio accepted, by recipient name."),
  failed: z.array(z.object({
    name: z.string(),
    error: z.string(),
  })).describe("Messages Twilio rejected, with its error."),
  skipped: z.array(z.string()).describe(
    "Recipients left out by the `only` filter.",
  ),
  noPhone: z.array(z.string()).describe(
    "Recipients with no phone number, whose link the organiser hands over (export_links).",
  ),
  finishedAt: z.string().describe("ISO-8601 timestamp."),
});

/** Summary of one `send_outbox` run. */
export interface BulkSend {
  /** Source model and outbox instance that was sent. */
  outbox: string;
  /** True when nothing was actually sent. */
  dryRun: boolean;
  /** Messages Twilio accepted, by recipient name. */
  sent: { name: string; sid: string; status: string }[];
  /** Messages Twilio rejected, with its error. */
  failed: { name: string; error: string }[];
  /** Recipients left out by the `only` filter. */
  skipped: string[];
  /** Recipients with no phone number, whose link the organiser hands over. */
  noPhone: string[];
  /** ISO-8601 timestamp. */
  finishedAt: string;
}

const SendOutboxArgsSchema = z.object({
  sourceModel: z.string().min(1).describe(
    "Name of the model holding the outbox, e.g. santa-family.",
  ),
  outbox: z.string().default("outbox").describe(
    "Instance name of the outbox resource on that model.",
  ),
  from: SenderSchema.describe(
    "Sender: your Twilio number in E.164, or an alphanumeric sender ID such as SANTA (supported for UK recipients; nobody can reply to it).",
  ),
  dryRun: z.boolean().default(true).describe(
    "When true (the default), log what would be sent and send nothing.",
  ),
  only: z.array(z.string()).default([]).describe(
    "Send only to these recipient names (case-insensitive), e.g. yourself for a test. Empty means everyone.",
  ),
  throttleMs: z.number().int().min(0).max(10_000).default(DEFAULT_THROTTLE_MS)
    .describe("Pause between sends, to stay under Twilio's rate limit."),
  messages: z.union([
    z.string(),
    z.array(
      z.object({
        name: z.string(),
        to: z.string().optional(),
        body: z.string(),
      })
        .passthrough(),
    ),
  ]).optional().describe(
    'The outbox\'s messages, wired in with a CEL expression such as ${{ data.latest("santa-family", "outbox").attributes.messages }}. Needed when the outbox is stored as sensitive data, because readModelData doesn\'t resolve vault references. When omitted, the outbox is read from sourceModel.',
  ),
});

/** Arguments accepted by `send_outbox`. */
export interface SendOutboxArgs {
  /** Name of the model holding the outbox. */
  sourceModel: string;
  /** Instance name of the outbox resource on that model. */
  outbox: string;
  /** Sender: E.164 number or alphanumeric sender ID. */
  from: string;
  /** When true, log what would be sent and send nothing. */
  dryRun: boolean;
  /** Send only to these recipient names; empty means everyone. */
  only: string[];
  /** Pause between sends in milliseconds. */
  throttleMs: number;
  /** The outbox messages, as an array or its JSON text; read from sourceModel when omitted. */
  messages?: string | { name: string; to?: string; body: string }[];
}

/** Method context fields `send_outbox` uses. */
export interface SendOutboxContext {
  /** The Twilio messaging model's global arguments. */
  globalArgs: TwilioCredentials;
  /** Structured logger. */
  logger: {
    info(msg: string, props?: Record<string, unknown>): void;
    warn(msg: string, props?: Record<string, unknown>): void;
  };
  /** Read another model's data (vault references are returned unresolved). */
  readModelData: (
    modelName: string,
    specName?: string,
  ) => Promise<
    { name: string; isLatest: boolean; attributes: Record<string, unknown> }[]
  >;
  /** Write a resource on this model. */
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Run a send over an outbox: the method body, with fetch and sleep injectable for tests. */
export async function runSendOutbox(
  args: SendOutboxArgs,
  context: SendOutboxContext,
  fetchImpl: FetchLike = fetch,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<{ dataHandles: { name: string }[] }> {
  const all = args.messages !== undefined
    ? parseMessages(args.messages, `${args.sourceModel}/${args.outbox}`)
    : pickOutbox(
      await context.readModelData(args.sourceModel, "outbox"),
      args.outbox,
    );
  const wanted = new Set(args.only.map((n) => n.trim().toLowerCase()));
  const targets = wanted.size
    ? all.filter((m) => wanted.has(m.name.trim().toLowerCase()))
    : all;
  const skipped = all.filter((m) => !targets.includes(m)).map((m) => m.name);
  const noPhone = targets.filter((m) => !m.to).map((m) => m.name);
  for (const name of noPhone) {
    context.logger.info(
      "{name} has no phone number; send their link yourself (export_links)",
      { name },
    );
  }
  const textable = targets.filter(
    (m): m is OutboxEntry & { to: string } => !!m.to,
  );
  const unknown = [...wanted].filter((n) =>
    !all.some((m) => m.name.trim().toLowerCase() === n)
  );
  if (unknown.length) {
    throw new Error(`only names not in the outbox: ${unknown.join(", ")}`);
  }

  const handles: { name: string }[] = [];
  const sent: BulkSend["sent"] = [];
  const failed: BulkSend["failed"] = [];
  for (const [i, m] of textable.entries()) {
    if (args.dryRun) {
      context.logger.info("[dry run] would text {name} at {to}", {
        name: m.name,
        to: maskNumber(m.to),
      });
      continue;
    }
    if (i > 0 && args.throttleMs) await sleep(args.throttleMs);
    try {
      const res = await sendTwilioSms(
        context.globalArgs,
        { to: m.to, from: args.from, body: m.body },
        fetchImpl,
      );
      sent.push({ name: m.name, sid: res.sid, status: res.status });
      context.logger.info("Texted {name} ({sid}, {status})", {
        name: m.name,
        sid: res.sid,
        status: res.status,
      });
      handles.push(
        await context.writeResource(
          "message",
          res.sid,
          res as unknown as Record<string, unknown>,
        ),
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ name: m.name, error });
      context.logger.warn("Could not text {name}: {error}", {
        name: m.name,
        error,
      });
    }
  }

  const summary: BulkSend = {
    outbox: `${args.sourceModel}/${args.outbox}`,
    dryRun: args.dryRun,
    sent,
    failed,
    skipped,
    noPhone,
    finishedAt: new Date().toISOString(),
  };
  handles.push(
    await context.writeResource(
      "bulkSend",
      `bulk-${args.sourceModel}-${args.outbox}`,
      summary as unknown as Record<string, unknown>,
    ),
  );
  if (failed.length) {
    throw new Error(
      `${failed.length} of ${textable.length} messages failed: ${
        failed.map((f) => `${f.name} (${f.error})`).join("; ")
      }. Re-run with only=[those names] after fixing.`,
    );
  }
  return { dataHandles: handles };
}

/** Swamp extension adding `send_outbox` to `@keeb/twilio/messaging`. */
export const extension = {
  type: "@keeb/twilio/messaging",
  resources: {
    bulkSend: {
      description:
        "Summary of one send_outbox run: who was texted, who failed and why, who was skipped.",
      schema: BulkSendSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: [
    {
      send_outbox: {
        description:
          "Send every message in another model's outbox resource, one Twilio request each, throttled. Dry run by default.",
        arguments: SendOutboxArgsSchema,
        execute: (
          args: SendOutboxArgs,
          context: SendOutboxContext,
        ): Promise<{ dataHandles: { name: string }[] }> =>
          runSendOutbox(args, context),
      },
    },
  ],
};
