# @aaronge/secret-santa

Run the family Secret Santa from [swamp](https://github.com/swamp-club/swamp).
The draw is fair and random. Couples and households can be kept apart, and
nobody gets the same person as last year. Each person then gets their own secret
link, either texted automatically through Twilio or sent by you over email,
WhatsApp or anything else. The link opens a Christmas ASCII animation on their
phone: Santa checks nobody's watching, moons them, then reveals who they're
buying for in big block letters.

- **No server, no names online.** The reveal page is one static page (e.g. on
  GitHub Pages). Each person's names are AES-GCM encrypted into their link's
  `#fragment`. Browsers never send the fragment to the web server, so the site
  itself holds no names.
- **Phone numbers stay in a vault.** The roster refers to numbers with
  `${{ vault.get(...) }}`, and the composed messages are stored as sensitive
  data. The send step receives them through a CEL expression that swamp resolves
  at run time, and swamp masks the values in logs and reports.
- **Safe to re-run.** A year's draw is kept unless you ask for a redraw. Sending
  is a dry run unless you turn it off, and you can text just yourself first.

Try the page with sample names: open the reveal page URL with `#demo` on the
end.

### Two ways to hand out the links

|                | Text them (`secret-santa` workflow)                       | Send them yourself (`secret-santa-links` workflow)               |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| Cost           | A few pence per text, paid to Twilio                      | Free                                                             |
| You need       | A Twilio account (see below) and everyone's mobile number | Nothing extra. Phone numbers are optional.                       |
| How it arrives | An SMS from `SANTA` (or your Twilio number)               | Whatever you choose: email, WhatsApp, a card, read out at dinner |
| What you do    | Run the workflow                                          | Copy each message from a private file and send it to that person |

You can mix them. People with a phone number get texted, and anyone without one
is skipped by the text run, so you send their link from the file instead.

**Texting needs a Twilio account.** Twilio is a paid SMS service, and this
extension can't send texts without it. Before the first send you need:

1. A Twilio account, **upgraded** from the free trial with some credit. Trial
   accounts can only text numbers you've verified, and add a trial notice to
   every message.
2. An approved **Primary Customer Profile** in Twilio's Trust Hub. An Individual
   profile is enough for a family: your name, address, a photo ID and a selfie.
   Approval takes up to two days. Until it's approved, every send fails with
   Twilio error 20003.
3. Your account SID and auth token from the Twilio Console, stored in a vault
   (see Usage).

Texting UK numbers from the alphanumeric sender `SANTA` needs no phone number
from Twilio. Other countries may need you to buy a Twilio number and pass it as
`from`. If you'd rather not set any of this up, use the links file.

## Installation

```sh
swamp extension pull @aaronge/secret-santa
```

This also pulls `@keeb/twilio` (a declared dependency), which is only used if
you text the links.

## Usage

If you're texting, store each phone number and your Twilio credentials in a
vault. Each `vault put` prompts for the value, so it never ends up in your shell
history. Skip this if you're only sending the links yourself.

```sh
swamp vault create local_encryption santa
swamp vault put santa PHONE_AARON
swamp vault put santa PHONE_GRANDMA
# ...one per person...
swamp vault put santa TWILIO_ACCOUNT_SID
swamp vault put santa TWILIO_AUTH_TOKEN
```

Create the `santa-family` model:

```yaml
type: "@aaronge/secret-santa"
name: santa-family
globalArguments:
  eventName: Family Secret Santa
  year: 2026
  baseUrl: https://aaron-dernley.github.io/secret-santa/
  participants:
    - name: Aaron
      phone: ${{ vault.get(santa, PHONE_AARON) }}
    - name: Grandma
      phone: ${{ vault.get(santa, PHONE_GRANDMA) }}
    - name: Grandad # no phone: send his link yourself
  # ...
  exclusions:
    - [Grandma, Grandad]
  avoidRepeatYears: 1
  shortener: is.gd # optional: short links in the message
  history: # optional: last year's draw, if it wasn't done here
    - year: 2025
      pairs:
        - { giver: Aaron, receiver: Grandad }
```

### Sending the links yourself (free)

```sh
swamp workflow run secret-santa-links
```

This draws, composes and verifies, then writes every person's message to
`~/secret-santa-links-<year>.txt`. Only your user can read the file. Copy each
message to its person, then delete the file. Anyone who sees a message can see
who that person drew. Pass `--input path=...` to write the file somewhere else,
but keep it out of git.

### Texting the links (Twilio)

Create a `twilio` model: a `@keeb/twilio/messaging` instance with
`accountSid: ${{ vault.get(santa, TWILIO_ACCOUNT_SID) }}` and
`authToken: ${{ vault.get(santa, TWILIO_AUTH_TOKEN) }}`. Then run:

```sh
# Dry run: draw, compose, verify, and log who *would* be texted
swamp workflow run secret-santa

# Text only yourself, check the link on your phone
swamp workflow run secret-santa --input testRecipient=Aaron --input dryRun=false

# Text everyone
swamp workflow run secret-santa --input dryRun=false
```

Running the test send and then the real send texts the same draw both times,
because the draw is kept. Compose does make fresh links on each run, so your
test link is replaced by the one in the final send. Both reveal the same person.

## Global arguments (`@aaronge/secret-santa`)

| Argument           | Type                    | Default               | Description                                                                                                                            |
| ------------------ | ----------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `eventName`        | string                  | `Family Secret Santa` | Event name used in the SMS.                                                                                                            |
| `year`             | integer                 | required              | Year being drawn; draws are stored per year.                                                                                           |
| `baseUrl`          | URL                     | required              | Where the reveal page (`site/`) is hosted. The token goes after `#`.                                                                   |
| `participants`     | `{name, phone?}[]`, ≥ 3 | required              | Everyone taking part. `phone` is only needed for texting; it accepts `07…`, `+44…`, `0044…` or any E.164 number. Use vault references. |
| `exclusions`       | `[name, name][]`        | `[]`                  | Pairs who must not draw each other, in either direction.                                                                               |
| `avoidRepeatYears` | integer 0–10            | `1`                   | Nobody gets someone they had in this many previous years. `0` turns it off.                                                            |
| `history`          | `{year, pairs[]}[]`     | `[]`                  | Earlier draws entered by hand. Draws made by this model are remembered automatically.                                                  |
| `messageTemplate`  | string                  | see source            | Message text with `{name}`, `{event}`, `{year}`, `{link}`. Must contain `{link}`.                                                      |
| `shortener`        | `none` or `is.gd`       | `none`                | Put a short `https://is.gd/…` link in the message instead of the full one. See below.                                                  |

`send_outbox` (added to `@keeb/twilio/messaging`) takes:

| Argument      | Type                 | Default                 | Description                                                                                                                                                                                                             |
| ------------- | -------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sourceModel` | string               | required                | Model that holds the outbox, e.g. `santa-family`.                                                                                                                                                                       |
| `outbox`      | string               | `outbox`                | Name of the outbox resource on that model.                                                                                                                                                                              |
| `from`        | string               | required                | Sender: an alphanumeric ID such as `SANTA` (UK; nobody can reply) or your Twilio number.                                                                                                                                |
| `dryRun`      | boolean              | `true`                  | Only log what would be sent.                                                                                                                                                                                            |
| `only`        | string[]             | `[]`                    | Only text these names. Use it for a test.                                                                                                                                                                               |
| `throttleMs`  | integer              | `1100`                  | Pause between texts, to stay under Twilio's rate limit.                                                                                                                                                                 |
| `messages`    | array or JSON string | read from `sourceModel` | The outbox's messages. In a workflow, pass `${{ data.latest("santa-family", "outbox").attributes.messages }}`. This is required for a sensitive outbox, because `readModelData` hands back vault references unresolved. |

## How it works

### `draw` → `draw-<year>`, `summary`

- Builds a matrix of who may give to whom, ruling out three things:
  - yourself
  - anyone you're excluded from (both directions)
  - anyone you gave to in the last `avoidRepeatYears` years, from stored draws
    and `history`
- Picks uniformly random shuffles until one fits every rule, so every valid draw
  is equally likely.
- If the rules are very tight, it falls back to a backtracking search. That
  either finds a draw or explains why none exists.
- An existing `draw-<year>` is kept unless `redraw: true`.
- Pairings are never written to the logs.

### `compose` → `outbox`

- For each person it encrypts `giver` and `receiver` with its own random 128-bit
  AES-GCM key. The token is that key followed by the ciphertext, about 60
  base64url characters. It goes after `#` on `baseUrl`, and then the message
  template is filled in.
- Each key encrypts exactly one message, so the nonce is fixed and stays out of
  the URL.
- With `shortener: is.gd`, each full link is shortened by is.gd's free API,
  which keeps the `#fragment` in its redirect. The trade-off is that is.gd
  stores the full links, so it could in principle see who drew whom. Leave
  `shortener` as `none` if that matters to you. Some phone networks are wary of
  shortened links in texts, so send yourself a test first.
- It counts SMS segments and avoids characters that would force a costlier
  encoding.
- The outbox is marked `sensitiveOutput`, so swamp stores it in the vault.

### `verify` → `linkcheck`

- Decrypts every link again and checks that:
  - each link is addressed to the person receiving it,
  - it matches the stored draw,
  - nobody has themselves or an excluded partner,
  - everyone is bought for exactly once,
  - each message contains its link, or a short link that redirects to exactly
    that link (checked with a `HEAD` request, without following it).
- Its problem messages never say who drew whom. The workflow won't send unless
  `ok` is true.

### `export_links` → `linkexport`

- Re-runs the link check and refuses to export if it fails.
- Writes every message, ready to paste, to a file with `0600` permissions. The
  default file is `~/secret-santa-links-<year>.txt`. Phone numbers are never
  written to it.
- `only` exports just the names you list.
- The `linkexport` record holds only the path and counts, never the links.

### `send_outbox` → `message`, `bulkSend`

- Takes the outbox's messages from the workflow's CEL expression, or reads them
  with `readModelData` if no expression is given. It then posts each text to
  Twilio's REST API with a pause between them.
- Logs show only names and masked numbers.
- People without a phone number are skipped, and listed under `noPhone` in
  `bulkSend`, so you send their links yourself.
- A failed text doesn't stop the rest. Failures are listed in `bulkSend` and
  fail the step, so you can re-send to just those people with `only`.

### The reveal page (`site/`)

- Plain HTML and ES modules, with no build step.
- It decrypts the fragment in the browser and plays the animation in a monospace
  grid sized to the phone's screen.
- Tapping skips ahead. It respects reduced-motion settings.
- A broken link shows a friendly message.
- Host it anywhere static. This repo deploys it to GitHub Pages.

## Workflow

Both workflows run **manually**. Neither has a schedule, because this happens
once a year. They share the same first two jobs:

- `prepare`: draw, compose, then verify
- `check`: asserts the link check passed

`secret-santa` then runs `send`, which calls `send_outbox` through Twilio. It's
a dry run unless you pass `dryRun=false`. Pass `testRecipient` to text one
person, and `redraw=true` to reshuffle.

`secret-santa-links` then runs `export`, which calls `export_links`. Pass `path`
to choose where the file goes, and `redraw=true` to reshuffle.

Both use the same stored draw, so you can text some people and send the rest
their links from the file.

## Development

```sh
deno task test    # unit tests: solver, crypto round-trip with the page, short links, SMS segments, sending, export
deno task lint
deno task serve   # preview the page at http://localhost:8080/#demo
```

## License

MIT — see [LICENSE](LICENSE).
