import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  extension,
  type FetchLike,
  maskNumber,
  pickOutbox,
  runSendOutbox,
  type SendOutboxArgs,
  type SendOutboxContext,
  sendTwilioSms,
} from "./twilio_outbox.ts";

const CREDS = { accountSid: "AC123", authToken: "secret" };
const OUTBOX = [
  { name: "Aaron", to: "+447700900120", body: "Hi Aaron #v1.a.b.c" },
  { name: "Beth", to: "+447700900121", body: "Hi Beth #v1.d.e.f" },
  { name: "Grandma", to: "+447700900122", body: "Hi Grandma #v1.g.h.i" },
];

interface Harness {
  context: SendOutboxContext;
  logs: string[];
  written: { spec: string; name: string; data: Record<string, unknown> }[];
  requests: { url: string; init: RequestInit }[];
  fetch: FetchLike;
}

function harness(
  respond: (body: URLSearchParams) => { status: number; json: unknown } = (
    b,
  ) => ({
    status: 201,
    json: {
      sid: `SM${b.get("To")!.slice(-3)}`,
      status: "queued",
      to: b.get("To"),
      from: b.get("From"),
      body: b.get("Body"),
      direction: "outbound-api",
      date_sent: null,
    },
  }),
  records = [{
    name: "outbox",
    isLatest: true,
    attributes: { messages: OUTBOX } as Record<string, unknown>,
  }],
): Harness {
  const h: Harness = {
    logs: [],
    written: [],
    requests: [],
    fetch: (url, init) => {
      h.requests.push({ url, init });
      const r = respond(new URLSearchParams(String(init.body)));
      return Promise.resolve(
        new Response(JSON.stringify(r.json), { status: r.status }),
      );
    },
    context: {
      globalArgs: CREDS,
      logger: {
        info: (m, p) => h.logs.push(`${m} ${JSON.stringify(p ?? {})}`),
        warn: (m, p) => h.logs.push(`WARN ${m} ${JSON.stringify(p ?? {})}`),
      },
      readModelData: () => Promise.resolve(records),
      writeResource: (spec, name, data) => {
        h.written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    },
  };
  return h;
}

const noSleep = () => Promise.resolve();

function args(overrides: Partial<SendOutboxArgs> = {}): SendOutboxArgs {
  return extension.methods[0].send_outbox.arguments.parse({
    sourceModel: "santa-family",
    from: "SANTA",
    ...overrides,
  });
}

Deno.test("send_outbox is a dry run unless told otherwise", async () => {
  const h = harness();
  const parsed = args();
  assertEquals(parsed.dryRun, true);
  await runSendOutbox(parsed, h.context, h.fetch, noSleep);
  assertEquals(h.requests.length, 0);
  assertEquals(h.written.length, 1);
  const summary = h.written[0].data as { dryRun: boolean; sent: unknown[] };
  assertEquals(summary.dryRun, true);
  assertEquals(summary.sent, []);
  assert(h.logs.some((l) => l.includes("would text")));
});

Deno.test("send_outbox texts everyone, one throttled request each, and records each message", async () => {
  const h = harness();
  const sleeps: number[] = [];
  await runSendOutbox(
    args({ dryRun: false }),
    h.context,
    h.fetch,
    (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  );
  assertEquals(h.requests.length, 3);
  assertEquals(sleeps, [1100, 1100], "pause between, not before, sends");
  const first = h.requests[0];
  assertEquals(
    first.url,
    "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json",
  );
  const headers = first.init.headers as Record<string, string>;
  assertEquals(headers.Authorization, `Basic ${btoa("AC123:secret")}`);
  const form = new URLSearchParams(String(first.init.body));
  assertEquals(form.get("To"), "+447700900120");
  assertEquals(form.get("From"), "SANTA");
  assertEquals(form.get("Body"), "Hi Aaron #v1.a.b.c");
  assertEquals(h.written.map((w) => w.spec), [
    "message",
    "message",
    "message",
    "bulkSend",
  ]);
  const summary = h.written[3].data as { sent: { name: string }[] };
  assertEquals(summary.sent.map((s) => s.name), ["Aaron", "Beth", "Grandma"]);
});

Deno.test("send_outbox logs never contain full phone numbers or message bodies", async () => {
  const h = harness();
  await runSendOutbox(args({ dryRun: false }), h.context, h.fetch, noSleep);
  const dry = harness();
  await runSendOutbox(args(), dry.context, dry.fetch, noSleep);
  const all = [...h.logs, ...dry.logs].join("\n");
  for (const m of OUTBOX) {
    assert(!all.includes(m.to), "full number leaked to logs");
    assert(!all.includes(m.body), "body leaked to logs");
  }
});

Deno.test("send_outbox `only` sends a test to one person and lists the rest as skipped", async () => {
  const h = harness();
  await runSendOutbox(
    args({ dryRun: false, only: ["  aaron "] }),
    h.context,
    h.fetch,
    noSleep,
  );
  assertEquals(h.requests.length, 1);
  const summary = h.written.at(-1)!.data as { skipped: string[] };
  assertEquals(summary.skipped, ["Beth", "Grandma"]);
});

Deno.test("send_outbox refuses an `only` name that isn't in the outbox", async () => {
  const h = harness();
  await assertRejects(
    () => runSendOutbox(args({ only: ["Rudolph"] }), h.context, h.fetch, noSleep),
    Error,
    "rudolph",
  );
  assertEquals(h.requests.length, 0);
});

Deno.test("send_outbox keeps going after a failure, records it, then fails the run", async () => {
  const h = harness((b) =>
    b.get("To") === "+447700900121"
      ? { status: 400, json: { code: 21211, message: "Invalid 'To' Phone Number" } }
      : {
        status: 201,
        json: { sid: `SM${b.get("To")!.slice(-3)}`, status: "queued" },
      }
  );
  await assertRejects(
    () => runSendOutbox(args({ dryRun: false }), h.context, h.fetch, noSleep),
    Error,
    "1 of 3 messages failed: Beth (Invalid 'To' Phone Number (Twilio error 21211))",
  );
  assertEquals(h.requests.length, 3, "Grandma still got hers");
  const summary = h.written.at(-1)!.data as {
    sent: { name: string }[];
    failed: { name: string }[];
  };
  assertEquals(summary.sent.map((s) => s.name), ["Aaron", "Grandma"]);
  assertEquals(summary.failed.map((f) => f.name), ["Beth"]);
});

Deno.test("sendTwilioSms surfaces HTTP errors without a JSON body", async () => {
  const failing: FetchLike = () =>
    Promise.resolve(new Response("gateway down", { status: 502 }));
  await assertRejects(
    () => sendTwilioSms(CREDS, { to: "+447700900120", from: "SANTA", body: "x" }, failing),
    Error,
    "HTTP 502",
  );
});

Deno.test("pickOutbox uses the latest version of the named instance", () => {
  const records = [
    { name: "outbox", isLatest: false, attributes: { messages: [OUTBOX[0]] } },
    { name: "outbox", isLatest: true, attributes: { messages: OUTBOX } },
    { name: "other", isLatest: true, attributes: { messages: [] } },
  ];
  assertEquals(pickOutbox(records, "outbox").length, 3);
});

Deno.test("pickOutbox explains a missing outbox, a malformed one, and an unresolved vault reference", () => {
  assertThrows(() => pickOutbox([], "outbox"), Error, "run the source model's compose");
  assertThrows(
    () => pickOutbox([{ name: "outbox", isLatest: true, attributes: {} }], "outbox"),
    Error,
    "no messages array",
  );
  assertThrows(
    () =>
      pickOutbox([{
        name: "outbox",
        isLatest: true,
        attributes: { messages: [{ name: "A", body: "x" }] },
      }], "outbox"),
    Error,
    "missing name/to/body",
  );
  assertThrows(
    () =>
      pickOutbox([{
        name: "outbox",
        isLatest: true,
        attributes: {
          messages: [{ name: "A", to: "${{ vault.get(santa, k) }}", body: "x" }],
        },
      }], "outbox"),
    Error,
    "unresolved vault reference",
  );
});

Deno.test("sender must be an E.164 number or an alphanumeric ID with a letter", () => {
  const schema = extension.methods[0].send_outbox.arguments;
  for (const ok of ["SANTA", "Santa 2026", "+447700900120"]) {
    schema.parse({ sourceModel: "m", from: ok });
  }
  for (const bad of ["12345", "WAY-TOO-LONG-ID", "07700900120", ""]) {
    assertThrows(() => schema.parse({ sourceModel: "m", from: bad }));
  }
});

Deno.test("maskNumber keeps only the last three digits", () => {
  assertEquals(maskNumber("+447700900123"), "**********123");
  assertEquals(maskNumber("12"), "***");
});

Deno.test("the extension targets @keeb/twilio/messaging and adds bulkSend", () => {
  assertEquals(extension.type, "@keeb/twilio/messaging");
  assert("bulkSend" in extension.resources);
  assert("send_outbox" in extension.methods[0]);
});

Deno.test("pickOutbox accepts messages stored as a JSON string by sensitiveOutput", () => {
  const records = [{
    name: "outbox",
    isLatest: true,
    attributes: { year: "2026", messages: JSON.stringify(OUTBOX) },
  }];
  assertEquals(pickOutbox(records, "outbox").map((m) => m.name), [
    "Aaron",
    "Beth",
    "Grandma",
  ]);
});

Deno.test("send_outbox uses messages passed in by the workflow instead of reading the source model", async () => {
  const h = harness(undefined, []);
  await runSendOutbox(
    args({ dryRun: false, messages: JSON.stringify(OUTBOX.slice(0, 1)) }),
    h.context,
    h.fetch,
    noSleep,
  );
  assertEquals(h.requests.length, 1);
  assertEquals(
    new URLSearchParams(String(h.requests[0].init.body)).get("To"),
    "+447700900120",
  );
});

Deno.test("send_outbox explains an outbox whose messages are still a vault reference", async () => {
  const h = harness(undefined, [{
    name: "outbox",
    isLatest: true,
    attributes: { messages: "${{ vault.get('santa', 'k') }}" },
  }]);
  await assertRejects(
    () => runSendOutbox(args(), h.context, h.fetch, noSleep),
    Error,
    "workflow input expression",
  );
});
