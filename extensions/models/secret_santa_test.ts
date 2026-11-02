import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260824.32";
import {
  buildConstraintMatrix,
  buildLink,
  cryptoRandomInt,
  decryptToken,
  DEFAULT_MESSAGE_TEMPLATE,
  drawInstance,
  encryptToken,
  extractToken,
  type GlobalArgs,
  model,
  nameKey,
  normalisePhone,
  type OutboxMessage,
  type Pair,
  readOutbox,
  recentPairs,
  renderMessage,
  revive,
  smsSegments,
  solveDraw,
  validateRoster,
  verifyOutbox,
} from "./secret_santa.ts";
import { decryptToken as siteDecrypt, revealFromHash } from "../../site/link.js";

// createModelTestContext() returns a MethodContext typed with a default
// Record<string, unknown> globalArgs — narrower than each execute()'s own
// inline context type. This cast bridges that gap.
function asContext<T>(context: unknown): T {
  return context as T;
}

/** createModelTestContext with GlobalArgs typed as the model's own interface. */
function testContext(
  options: Omit<Parameters<typeof createModelTestContext>[0] & object, "globalArgs"> & {
    globalArgs: GlobalArgs;
  },
): ReturnType<typeof createModelTestContext> {
  return createModelTestContext({
    ...options,
    globalArgs: options.globalArgs as unknown as Record<string, unknown>,
  });
}

/** Deterministic RandomInt for reproducible solver tests (mulberry32). */
function seeded(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

const FAMILY = ["Aaron", "Beth", "Grandma", "Grandad", "Chris", "Dana"];
const COUPLES: [string, string][] = [["Grandma", "Grandad"], ["Chris", "Dana"]];

function globalArgs(overrides: Partial<GlobalArgs> = {}): GlobalArgs {
  return {
    eventName: "Family Secret Santa",
    year: 2026,
    baseUrl: "https://example.github.io/secret-santa/",
    participants: FAMILY.map((name, i) => ({
      name,
      phone: `07700 90012${i}`,
    })),
    exclusions: COUPLES,
    avoidRepeatYears: 1,
    history: [],
    messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
    ...overrides,
  };
}

function assertValidDraw(
  names: string[],
  pairs: Pair[],
  allowed: boolean[][],
): void {
  assertEquals(pairs.length, names.length);
  const receivers = new Set(pairs.map((p) => p.receiver));
  assertEquals(receivers.size, names.length, "everyone receives exactly once");
  pairs.forEach((p, g) => {
    assertEquals(p.giver, names[g]);
    assert(
      allowed[g][names.indexOf(p.receiver)],
      `${p.giver} → ${p.receiver} breaks a rule`,
    );
  });
}

// --- normalisePhone ------------------------------------------------------

Deno.test("normalisePhone accepts UK national, international and E.164 forms", () => {
  assertEquals(normalisePhone("07700 900123"), "+447700900123");
  assertEquals(normalisePhone("(07700) 900-123"), "+447700900123");
  assertEquals(normalisePhone("0044 7700 900123"), "+447700900123");
  assertEquals(normalisePhone("+44 7700 900123"), "+447700900123");
  assertEquals(normalisePhone("+1 415 555 0100"), "+14155550100");
});

Deno.test("normalisePhone rejects landline-length, letters and empty input", () => {
  for (const bad of ["", "0770090012", "hello", "+0123456789", "12345"]) {
    assertThrows(() => normalisePhone(bad), Error, "not a valid mobile");
  }
});

Deno.test("normalisePhone error never echoes the number back", () => {
  const err = assertThrows(() => normalisePhone("0799 BAD 111"));
  assert(!(err as Error).message.includes("0799"));
});

// --- validateRoster ------------------------------------------------------

Deno.test("validateRoster passes a sound roster", () => {
  assertEquals(
    validateRoster(globalArgs().participants, COUPLES),
    [],
  );
});

Deno.test("validateRoster flags duplicates, unknown exclusions, self-exclusion and bad phones", () => {
  const problems = validateRoster(
    [
      { name: "Aaron", phone: "07700900123" },
      { name: " aaron ", phone: "07700900124" },
      { name: "Beth", phone: "nope" },
    ],
    [["Beth", "Zed"], ["Beth", "beth"]],
  );
  assert(problems.some((p) => p.includes("more than once")));
  assert(problems.some((p) => p.includes('"Zed"')));
  assert(problems.some((p) => p.includes("with themselves")));
  assert(problems.some((p) => p.includes("Beth's phone")));
});

// --- buildConstraintMatrix -----------------------------------------------

Deno.test("buildConstraintMatrix blocks self, both directions of exclusions, and one direction of repeats", () => {
  const names = ["A", "B", "C", "D"];
  const m = buildConstraintMatrix(names, [["a", "B"]], [{
    giver: "C",
    receiver: "D",
  }]);
  for (let i = 0; i < 4; i++) assertEquals(m[i][i], false);
  assertEquals(m[0][1], false);
  assertEquals(m[1][0], false);
  assertEquals(m[2][3], false, "last year's C → D is blocked");
  assertEquals(m[3][2], true, "D → C is still fine");
  assertEquals(m[0][2], true);
});

Deno.test("buildConstraintMatrix ignores names it doesn't know", () => {
  const m = buildConstraintMatrix(["A", "B", "C"], [["A", "Zed"]], [{
    giver: "Zed",
    receiver: "A",
  }]);
  assertEquals(m[0][1], true);
  assertEquals(m[0][2], true);
});

// --- solveDraw -----------------------------------------------------------

Deno.test("solveDraw: 1000 random draws for the family all obey every rule", () => {
  const allowed = buildConstraintMatrix(FAMILY, COUPLES, []);
  for (let i = 0; i < 1000; i++) {
    assertValidDraw(FAMILY, solveDraw(FAMILY, allowed).pairs, allowed);
  }
});

Deno.test("solveDraw is reproducible with an injected random source", () => {
  const allowed = buildConstraintMatrix(FAMILY, COUPLES, []);
  assertEquals(
    solveDraw(FAMILY, allowed, seeded(42)).pairs,
    solveDraw(FAMILY, allowed, seeded(42)).pairs,
  );
});

Deno.test("solveDraw reaches every valid assignment over many draws (no hidden bias)", () => {
  // 4 people, A/B a couple: valid draws are the derangements with A↛B, B↛A.
  const names = ["A", "B", "C", "D"];
  const allowed = buildConstraintMatrix(names, [["A", "B"]], []);
  const seen = new Map<string, number>();
  const rand = seeded(7);
  for (let i = 0; i < 4000; i++) {
    const key = solveDraw(names, allowed, rand).pairs.map((p) => p.receiver)
      .join("");
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  // A→{C,D}, B→{C,D}, so C,D must give to A,B: exactly 4 valid draws.
  assertEquals(seen.size, 4);
  for (const count of seen.values()) {
    assert(count > 800 && count < 1200, `roughly uniform, got ${count}/4000`);
  }
});

Deno.test("solveDraw falls back to backtracking when shuffles run out", () => {
  // Only one valid draw: a single fixed cycle A→B→C→D→A.
  const names = ["A", "B", "C", "D"];
  const allowed = names.map((_, i) => names.map((_, j) => j === (i + 1) % 4));
  const { pairs, attempts } = solveDraw(names, allowed, seeded(1), 0);
  assertEquals(attempts, 0);
  assertEquals(pairs.map((p) => p.receiver), ["B", "C", "D", "A"]);
});

Deno.test("solveDraw names the person who can't be given anyone", () => {
  const names = ["A", "B", "C"];
  const allowed = buildConstraintMatrix(names, [["A", "B"], ["A", "C"]], []);
  assertThrows(
    () => solveDraw(names, allowed, seeded(3), 50),
    Error,
    "A can't be given anyone",
  );
});

Deno.test("solveDraw explains a globally impossible draw", () => {
  // Everyone can give, but B and C can only give to A: no permutation exists.
  const names = ["A", "B", "C"];
  const allowed = [
    [false, true, true],
    [true, false, false],
    [true, false, false],
  ];
  assertThrows(
    () => solveDraw(names, allowed, seeded(3), 50),
    Error,
    "No valid draw exists",
  );
});

Deno.test("cryptoRandomInt stays in range and rejects n <= 0", () => {
  for (let i = 0; i < 500; i++) {
    const v = cryptoRandomInt(7);
    assert(v >= 0 && v < 7 && Number.isInteger(v));
  }
  assertThrows(() => cryptoRandomInt(0));
});

// --- recentPairs ---------------------------------------------------------

Deno.test("recentPairs only returns pairs inside the window, from history and stored draws", () => {
  const pairs = recentPairs(
    2026,
    1,
    [{ year: 2025, pairs: [{ giver: "A", receiver: "B" }] }, {
      year: 2024,
      pairs: [{ giver: "A", receiver: "C" }],
    }],
    [{ year: 2025, pairs: [{ giver: "C", receiver: "D" }] }, {
      year: 2026,
      pairs: [{ giver: "D", receiver: "A" }],
    }],
  );
  assertEquals(pairs, [{ giver: "A", receiver: "B" }, {
    giver: "C",
    receiver: "D",
  }]);
  assertEquals(recentPairs(2026, 0, [{ year: 2025, pairs }], []), []);
});

// --- reveal tokens and links ---------------------------------------------

Deno.test("encryptToken → decryptToken round-trips, including accents and spaces", async () => {
  const payload = { g: "Zoë", r: "Auntie Margaret", y: 2026 };
  assertEquals(await decryptToken(await encryptToken(payload)), payload);
});

Deno.test("the reveal page decrypts what the model encrypts", async () => {
  const token = await encryptToken({ g: "Aaron", r: "Grandma", y: 2026 });
  assertEquals(await siteDecrypt(token), { g: "Aaron", r: "Grandma", y: 2026 });
  const link = buildLink("https://example.github.io/secret-santa/", token);
  const hash = new URL(link).hash;
  assertEquals(await revealFromHash(hash), {
    giver: "Aaron",
    receiver: "Grandma",
    year: 2026,
    demo: false,
  });
});

Deno.test("every token uses a fresh key, so identical payloads differ", async () => {
  const p = { g: "A", r: "B", y: 2026 };
  assertNotEquals(await encryptToken(p), await encryptToken(p));
});

Deno.test("tampered or truncated tokens are rejected by both sides", async () => {
  const token = await encryptToken({ g: "Aaron", r: "Grandma", y: 2026 });
  const parts = token.split(".");
  const ct = parts[3];
  parts[3] = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
  const tampered = parts.join(".");
  await assertRejects(() => decryptToken(tampered));
  await assertRejects(() => siteDecrypt(tampered));
  await assertRejects(() => decryptToken(token.slice(0, -5)));
  await assertRejects(() => siteDecrypt("v2.a.b.c"), Error, "not a Secret Santa");
  await assertRejects(() => revealFromHash("#"));
});

Deno.test("the token never contains the names in readable or base64 form", async () => {
  const token = await encryptToken({ g: "Aaron", r: "Grandma", y: 2026 });
  assert(!token.includes("Grandma"));
  assert(!token.includes(btoa("Grandma").slice(0, 6)));
});

Deno.test("#demo on the reveal page gives sample names without a token", async () => {
  const r = await revealFromHash("#demo");
  assertEquals(r.demo, true);
  assert(r.giver && r.receiver);
});

Deno.test("buildLink replaces any existing fragment and extractToken finds it in an SMS", async () => {
  const token = await encryptToken({ g: "A", r: "B", y: 2026 });
  const link = buildLink("https://x.test/s/#old", token);
  assertEquals(link, `https://x.test/s/#${token}`);
  assertEquals(extractToken(`Hi! Tap ${link} (shh)`), token);
  assertEquals(extractToken("no link here"), null);
});

Deno.test("links fit an SMS-friendly length", async () => {
  const token = await encryptToken({
    g: "Christopher",
    r: "Auntie Margaret",
    y: 2026,
  });
  const link = buildLink("https://aaron-dernley.github.io/secret-santa/", token);
  assert(link.length < 200, `link is ${link.length} chars`);
});

// --- message rendering and SMS segments ---------------------------------

Deno.test("renderMessage fills every placeholder", () => {
  assertEquals(
    renderMessage("{name}/{event}/{year}/{link}/{name}", {
      name: "A",
      event: "E",
      year: 2026,
      link: "L",
    }),
    "A/E/2026/L/A",
  );
});

Deno.test("smsSegments counts GSM-7 and UCS-2 bodies the way carriers bill them", () => {
  assertEquals(smsSegments("a".repeat(160)), 1);
  assertEquals(smsSegments("a".repeat(161)), 2);
  assertEquals(smsSegments("a".repeat(306)), 2);
  assertEquals(smsSegments("a".repeat(307)), 3);
  assertEquals(smsSegments("{".repeat(80)), 1, "extension chars count double");
  assertEquals(smsSegments("{".repeat(81)), 2);
  assertEquals(smsSegments("🎅" + "a".repeat(68)), 1);
  assertEquals(smsSegments("🎅" + "a".repeat(69)), 2, "emoji forces UCS-2");
});

Deno.test("the default message stays GSM-7 so segments aren't wasted", () => {
  const body = renderMessage(DEFAULT_MESSAGE_TEMPLATE, {
    name: "Grandma",
    event: "Family Secret Santa",
    year: 2026,
    link: "https://aaron-dernley.github.io/secret-santa/#v1." + "a".repeat(120),
  });
  assert(smsSegments(body) <= 3, `default body is ${smsSegments(body)} segments`);
  assert(smsSegments(body) === Math.ceil(body.length / 153));
});

// --- model methods -------------------------------------------------------

Deno.test("draw writes a valid draw and a summary for the year", async () => {
  const { context, getWrittenResources } = testContext({
    globalArgs: globalArgs(),
    methodName: "draw",
  });
  await model.methods.draw.execute({ redraw: false }, asContext(context));
  const written = getWrittenResources();
  assertEquals(written.map((w) => w.specName), ["draw", "drawSummary"]);
  const draw = written[0].data as { year: number; pairs: Pair[] };
  assertEquals(written[0].name, drawInstance(2026));
  const allowed = buildConstraintMatrix(FAMILY, COUPLES, []);
  assertValidDraw(FAMILY, draw.pairs, allowed);
  const summary = written[1].data as Record<string, number>;
  assertEquals(summary.participantCount, 6);
  assertEquals(summary.exclusionCount, 2);
});

Deno.test("draw never logs who drew whom", async () => {
  const { context, getWrittenResources, getLogs } = testContext({
    globalArgs: globalArgs(),
    methodName: "draw",
  });
  await model.methods.draw.execute({ redraw: false }, asContext(context));
  const pairs = (getWrittenResources()[0].data as { pairs: Pair[] }).pairs;
  const logText = JSON.stringify(getLogs());
  for (const p of pairs) {
    assert(!logText.includes(`${p.giver} → ${p.receiver}`));
    assert(!logText.includes(p.receiver), "no receiver names in logs");
  }
});

Deno.test("draw keeps an existing draw unless redraw is true", async () => {
  const existing = {
    year: 2026,
    eventName: "x",
    pairs: [],
    drawnAt: "2026-11-01T00:00:00Z",
  };
  const kept = testContext({
    globalArgs: globalArgs(),
    storedResources: { [drawInstance(2026)]: existing },
  });
  await model.methods.draw.execute({ redraw: false }, asContext(kept.context));
  assertEquals(kept.getWrittenResources().length, 0);

  const redone = testContext({
    globalArgs: globalArgs(),
    storedResources: { [drawInstance(2026)]: existing },
  });
  await model.methods.draw.execute({ redraw: true }, asContext(redone.context));
  assertEquals(redone.getWrittenResources().length, 2);
});

Deno.test("draw avoids last year's pairs from both stored draws and hand-entered history", async () => {
  // A 4-person ring last year leaves exactly one other ring this year.
  const names = ["A", "B", "C", "D"];
  const base = {
    participants: names.map((name, i) => ({ name, phone: `0770090012${i}` })),
    exclusions: [] as [string, string][],
  };
  const lastYear = [
    { giver: "A", receiver: "B" },
    { giver: "B", receiver: "C" },
    { giver: "C", receiver: "D" },
  ];
  for (let i = 0; i < 50; i++) {
    const { context, getWrittenResources } = testContext({
      globalArgs: globalArgs({
        ...base,
        history: [{ year: 2025, pairs: [{ giver: "D", receiver: "A" }] }],
      }),
      storedResources: {
        [drawInstance(2025)]: { year: 2025, pairs: lastYear },
      },
    });
    await model.methods.draw.execute({ redraw: false }, asContext(context));
    const pairs = (getWrittenResources()[0].data as { pairs: Pair[] }).pairs;
    for (const p of pairs) {
      assert(
        ![...lastYear, { giver: "D", receiver: "A" }].some((l) =>
          l.giver === p.giver && l.receiver === p.receiver
        ),
        `${p.giver} got ${p.receiver} again`,
      );
    }
  }
});

Deno.test("draw refuses a broken roster before drawing", async () => {
  const { context, getWrittenResources } = testContext({
    globalArgs: globalArgs({ exclusions: [["Aaron", "Nobody"]] }),
  });
  await assertRejects(
    () => model.methods.draw.execute({ redraw: false }, asContext(context)),
    Error,
    "Roster problems",
  );
  assertEquals(getWrittenResources().length, 0);
});

async function drawAndCompose(args: GlobalArgs) {
  const d = testContext({ globalArgs: args });
  await model.methods.draw.execute({ redraw: false }, asContext(d.context));
  const draw = d.getWrittenResources()[0].data as {
    year: number;
    pairs: Pair[];
  };
  const c = testContext({
    globalArgs: args,
    storedResources: { [drawInstance(args.year)]: draw },
  });
  await model.methods.compose.execute({}, asContext(c.context));
  const outbox = c.getWrittenResources()[0].data as {
    year: number;
    messages: OutboxMessage[];
    totalSegments: number;
  };
  return { draw, outbox, composeWritten: c.getWrittenResources() };
}

Deno.test("compose writes one message per person with a link that reveals their draw", async () => {
  const args = globalArgs();
  const { draw, outbox, composeWritten } = await drawAndCompose(args);
  assertEquals(composeWritten[0].specName, "outbox");
  assertEquals(outbox.messages.length, 6);
  for (const m of outbox.messages) {
    assertMatch(m.to, /^\+447700900\d{3}$/);
    assert(m.body.startsWith(`Ho ho ho ${m.name}!`));
    assert(m.body.includes(args.baseUrl));
    const p = await siteDecrypt(extractToken(m.body)!);
    assertEquals(p.g, m.name);
    assertEquals(
      p.r,
      draw.pairs.find((x) => x.giver === m.name)!.receiver,
    );
    assert(!m.body.includes(p.r) || p.r === m.name, "receiver isn't in the SMS text");
  }
  assertEquals(
    outbox.totalSegments,
    outbox.messages.reduce((n, m) => n + m.segments, 0),
  );
});

Deno.test("compose requires a draw and a {link} placeholder", async () => {
  const none = testContext({ globalArgs: globalArgs() });
  await assertRejects(
    () => model.methods.compose.execute({}, asContext(none.context)),
    Error,
    "run the draw method first",
  );
  const noLink = testContext({
    globalArgs: globalArgs({ messageTemplate: "Hi {name}" }),
  });
  await assertRejects(
    () => model.methods.compose.execute({}, asContext(noLink.context)),
    Error,
    "{link}",
  );
});

Deno.test("compose notices the roster changed since the draw", async () => {
  const args = globalArgs();
  const { draw } = await drawAndCompose(args);
  const grown = globalArgs({
    participants: [...args.participants, {
      name: "Eve",
      phone: "07700900999",
    }],
  });
  const c = testContext({
    globalArgs: grown,
    storedResources: { [drawInstance(2026)]: draw },
  });
  await assertRejects(
    () => model.methods.compose.execute({}, asContext(c.context)),
    Error,
    "redraw=true",
  );
});

Deno.test("verify passes a freshly composed outbox", async () => {
  const args = globalArgs();
  const { draw, outbox } = await drawAndCompose(args);
  const v = testContext({
    globalArgs: args,
    storedResources: { [drawInstance(2026)]: draw, outbox },
  });
  await model.methods.verify.execute({}, asContext(v.context));
  const check = v.getWrittenResources()[0];
  assertEquals(check.specName, "linkCheck");
  assertEquals((check.data as { ok: boolean }).ok, true);
  assertEquals((check.data as { checked: number }).checked, 6);
});

Deno.test("verifyOutbox catches swapped links, a corrupted link, and a self-draw, without naming pairings", async () => {
  const args = globalArgs();
  const { draw, outbox } = await drawAndCompose(args);
  const messages = outbox.messages.map((m) => ({ ...m }));
  [messages[0].body, messages[1].body] = [messages[1].body, messages[0].body];
  messages[2].body = messages[2].body.replace(/.$/, (c) => c === "A" ? "B" : "A");
  const selfToken = await encryptToken({
    g: messages[3].name,
    r: messages[3].name,
    y: 2026,
  });
  messages[3].body = buildLink(args.baseUrl, selfToken);
  const result = await verifyOutbox(args, draw, { year: 2026, messages });
  assertEquals(result.ok, false);
  const text = result.problems.join("\n");
  assert(text.includes("addressed to someone else"));
  assert(text.includes("doesn't decrypt"));
  assert(text.includes("gives them themselves"));
  for (const p of draw.pairs) {
    assert(!text.includes(`→ ${p.receiver}`));
  }
});

Deno.test("verifyOutbox flags a link that breaks an exclusion and a wrong year", async () => {
  const args = globalArgs();
  const { draw, outbox } = await drawAndCompose(args);
  const messages = outbox.messages.map((m) => ({ ...m }));
  const grandma = messages.findIndex((m) => m.name === "Grandma");
  messages[grandma].body = buildLink(
    args.baseUrl,
    await encryptToken({ g: "Grandma", r: "Grandad", y: 2025 }),
  );
  const result = await verifyOutbox(args, draw, { year: 2026, messages });
  const text = result.problems.join("\n");
  assert(text.includes("breaks an exclusion"));
  assert(text.includes("is for 2025"));
});

Deno.test("verify fails loudly when there's nothing to check", async () => {
  const { context } = testContext({ globalArgs: globalArgs() });
  await assertRejects(
    () => model.methods.verify.execute({}, asContext(context)),
    Error,
    "run draw and compose first",
  );
});

// --- schema ---------------------------------------------------------------

Deno.test("global arguments apply defaults and reject a roster of two", () => {
  const parsed = model.globalArguments.parse({
    year: 2026,
    baseUrl: "https://x.test/",
    participants: [
      { name: "A", phone: "07700900123" },
      { name: "B", phone: "07700900124" },
      { name: "C", phone: "07700900125" },
    ],
  });
  assertEquals(parsed.avoidRepeatYears, 1);
  assertEquals(parsed.exclusions, []);
  assertEquals(parsed.messageTemplate, DEFAULT_MESSAGE_TEMPLATE);
  assertThrows(() =>
    model.globalArguments.parse({
      year: 2026,
      baseUrl: "https://x.test/",
      participants: [{ name: "A", phone: "1" }, { name: "B", phone: "2" }],
    })
  );
});

Deno.test("nameKey ignores case and surrounding spaces", () => {
  assertEquals(nameKey("  GrandMA "), "grandma");
});

// --- vault round-trip (found by the swamp smoke test) ----------------------

Deno.test("revive turns vault-resolved strings back into numbers and arrays", () => {
  assertEquals(revive("2026"), 2026);
  assertEquals(revive('[{"a":1}]'), [{ a: 1 }]);
  assertEquals(revive("2026-11-02T09:50:48Z"), "2026-11-02T09:50:48Z");
  assertEquals(revive(7), 7);
});

Deno.test("verify reads an outbox stored the way sensitiveOutput stores it (every field a string)", async () => {
  const args = globalArgs();
  const { draw, outbox } = await drawAndCompose(args);
  const asStoredInVault = {
    year: String(outbox.year),
    messages: JSON.stringify(outbox.messages),
    totalSegments: String(outbox.totalSegments),
    composedAt: "2026-11-02T09:50:48.309Z",
  };
  assertEquals(readOutbox(asStoredInVault).messages.length, 6);
  const v = testContext({
    globalArgs: args,
    storedResources: { [drawInstance(2026)]: draw, outbox: asStoredInVault },
  });
  await model.methods.verify.execute({}, asContext(v.context));
  assertEquals((v.getWrittenResources()[0].data as { ok: boolean }).ok, true);
});

Deno.test("readOutbox explains an unresolved vault reference", () => {
  assertThrows(
    () =>
      readOutbox({
        year: "${{ vault.get('santa', 'k') }}",
        messages: "${{ vault.get('santa', 'm') }}",
      }),
    Error,
    "vault",
  );
});
