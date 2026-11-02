// Tests for the reveal page's pure helpers (site/santa.js). The page's DOM
// code isn't exercised here; the screenshots in the README cover that.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  blockWidth,
  FRONT,
  glyphs,
  GLYPHS,
  MOON,
  norm,
  REVEAL_COLS,
  SANTA_COLS,
  wrapName,
  wrapText,
} from "../../site/santa.js";

Deno.test("every block glyph is 5 rows of equal width", () => {
  for (const [ch, rows] of Object.entries(GLYPHS)) {
    assertEquals(rows.length, 5, `${ch} has ${rows.length} rows`);
    assert(rows.every((r) => r.length === rows[0].length), `${ch} rows differ in width`);
  }
});

Deno.test("block font covers A–Z", () => {
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") assert(GLYPHS[c as keyof typeof GLYPHS], c);
});

Deno.test("accents are stripped and unknown characters render as spaces", () => {
  assertEquals(norm("Zoë Renée"), "ZOE RENEE");
  assertEquals(glyphs("Ø")[0], GLYPHS[" "]);
});

Deno.test("MERRY CHRISTMAS fits the reveal width", () => {
  assert(blockWidth("CHRISTMAS") <= REVEAL_COLS - 2);
  assert(blockWidth("MERRY") <= REVEAL_COLS - 2);
});

Deno.test("both Santa sprites fit the Santa scene width", () => {
  for (const [line] of [...FRONT, ...MOON]) {
    assert(line.length <= SANTA_COLS - 2, `"${line}" is too wide`);
  }
});

Deno.test("the mooning Santa is symmetric about its centre column", () => {
  // Rows 3–10 are the cheeks and legs; mirror each and compare.
  const mirror: Record<string, string> = { "/": "\\", "\\": "/", "(": ")", ")": "(" };
  for (const [line] of MOON.slice(3, 11)) {
    const padded = line.padEnd(25);
    const flipped = [...padded].reverse().map((c) => mirror[c] ?? c).join("");
    assertEquals(flipped.replace(/[.'-]/g, "x"), padded.replace(/[.'-]/g, "x"), line);
  }
});

Deno.test("long names wrap onto extra lines instead of overflowing", () => {
  assertEquals(wrapName("Grandma"), ["Grandma"]);
  assertEquals(wrapName("Auntie Margaret"), ["Auntie", "Margaret"]);
  for (const line of wrapName("Great Auntie Margaret Thompson")) {
    assert(blockWidth(line) <= REVEAL_COLS - 2 || !line.includes(" "));
  }
  assertEquals(wrapName("   "), ["???"]);
});

Deno.test("wrapText honours forced breaks and width", () => {
  assertEquals(wrapText("a b c\nd", 3), ["a b", "c", "d"]);
  assertEquals(wrapText("Christopher,\nyou are Secret Santa for...", 38), [
    "Christopher,",
    "you are Secret Santa for...",
  ]);
});
