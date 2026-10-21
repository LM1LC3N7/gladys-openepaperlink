# TODO — OpenEPaperLink v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — access point, tags, show a text** (2026-10-21): the
      HTTP paths and websocket messages of the OpenEPaperLink Home Assistant
      integration 3.0.0, one read-only device for the access point and one
      per tag, the "show a text" scene action (own font, own JPEG encoder),
      upload queue without bursts, states budget, pauses kept in `/data`;
      docs en/fr. Tested against a fake access point, a real local TCP server
      for the websocket and a fake clock only, never with a real device. The
      store validator was not run by the dev agent (it cannot): to run in the
      real terminal before publishing.
- [ ] **Milestone 2 — real access points** (testers): record real answers as
      fixtures, fix what differs. To check first:
  - that the JPEG (baseline, 4:4:4, quality 95) decodes on the access point
    (TJpg_Decoder) and that `dither=0` maps the colours as expected on
    black/white/red and black/white/yellow displays;
  - the size of the `sys` and `tags` messages on a big installation (the 64 KB
    bound), and how often `sys` comes (the idle timeout is 90 s);
  - the battery estimate (reference formula: 2.2 V = 0 %, 2.6 V = 100 %)
    against the access point web page, and the AP-powered tags (no battery);
  - the "reachable" rule (expected check-in + 10 min) against the access
    point's own timeout count;
  - whether `/tagtypes/XX.json` is always served by the access point (it
    downloads them from GitHub; a type missing there gives "size unknown");
  - the answer of `/imgupload` while the radio is not running (409 "Come back
    later") and the Retry-After of 409 "Busy".
- [ ] **Milestone 3 — more**: image from a URL (bounded download, decoded
      without a heavy dependency: probably JPEG only, passed through), the
      tag buttons and NFC as scene triggers (wakeup reasons, debounced), LED
      flash and refresh commands (`/led_flash`, `/tag_cmd`), several access
      points, the "next update" time, the AP's own MAC as identity if a later
      firmware exposes it.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: OpenEPaperLink/Home_Assistant_Integration 3.0.0 (commit `f28c217`),
  Apache-2.0 (checked in its `LICENSE` file, no copyright holder named, no
  `NOTICE` file), is Python: its paths, messages, fields, state names and
  battery estimate are ported to JavaScript; the licence is reproduced in
  `THIRD_PARTY_NOTICES.md` (copied into the image). Its fonts and image
  generator are not used.
- The firmware of the access point (OpenEPaperLink/OpenEPaperLink) is
  CC BY-NC-SA 4.0: read only to check interoperability facts (multipart field
  order, 409 with Retry-After, 1 MB upload limit, `continu` paging); nothing
  copied. Neighbour modules: LM1LC3N7/gladys-unfolded-circle (structure of
  app, store, config, i18n, tests, local API) and LM1LC3N7/gladys-discord
  (scene action with a text, websocket gateway).
- Local only (`transports: ["local"]`), plain HTTP (the access point has no
  TLS nor password: no secret field, nothing secret anywhere). No Bluetooth:
  the BLE tags of the reference are out of scope.
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1: the one exception to
  "versions belong to the Release workflow", because the template's 1.0.0 and
  its image were someone else's. The first patch release gives 0.1.1.
- **Devices**: `ap:main` (one access point per configuration: its API gives
  no serial number nor MAC) with reachable (`unknown/binary`), radio state
  (text), tags with a low battery and tags overdue (`unknown/integer`, as the
  access point counts them); `tag:<MAC>` with battery (`battery/integer`,
  `percent`), chip temperature (`device-temperature-sensor/decimal`,
  `celsius`: kept out of the room averages, it is the chip), reachable
  (`unknown/binary`), last contact (text, UTC, minute precision so it changes
  at most once a minute). All read only: no switch, nothing an "everything
  off" can reach. Units only from `DEVICE_FEATURE_UNITS_BY_CATEGORY`. No
  energy index, no scene event.
- A tag's identity is its MAC, in every message. Before every upload the tag
  is asked to the access point (`get_db?mac=`): another access point at the
  same address (DHCP) that does not know the tag gives "does not know this
  tag", nothing sent; its hardware type gives the display size. The access
  point device has no identity to check (documented above).
- **Show a text**: `cleanDisplayText` bounds the input (1120 characters read,
  280 kept, 16 lines), drops control and invisible characters, keeps line
  breaks, simplifies typography (quotes, dashes, ellipsis, œ), removes the
  accents the font lacks and shows anything else as "?". The 5x9 font is
  drawn for this project (ASCII, lower case French accents, Ç, °, €). The
  layout takes the largest whole scale (1 to 12) that fits, or a fixed size
  with "..." at the cut. Colours: black and white always; red and yellow only
  when the colour table of the display type lists them. The JPEG encoder is
  baseline, YCbCr 4:4:4 (no chroma blur on red text), quality 95 then 85 then
  70 until it fits 512 KB (the access point takes 1 MB). Checked once by
  decoding with Pillow (max error 10 levels on text, no pixel off), not in
  the tests (no decoder in the dependencies).
- **No burst**: one upload at a time (the reference uses one with a 1 s
  cooldown); 2 s between any two uploads and 15 s for the same tag, counted
  from the start of the job (the tag check counts as a request); a newer text
  for a tag replaces the waiting one ("replaced"); 10 waiting at most
  ("too many"); a job that could not start 1 s before the end of its 25 s
  budget is dropped ("no time left"), never sent late (scene action timeout
  30 s). 409 "busy": uploads wait its Retry-After (5 s to 5 min, in memory).
  A timeout of the upload itself: "sent, without confirmation". `dither=0`:
  the image already uses the display colours.
- **Readings**: `get_db` (paged, 60 pages and 200 tags at most, 64 KB per
  answer) when connecting and at most every 15 min; the websocket otherwise.
  A connection in flight is shared (a reconnect during a reading never starts
  another one). Reconnection after 10 s, 30 s, 1, 2, then 5 min (reset after
  2 min connected); never two attempts closer than 10 s, the time of the last
  attempt kept in `/data` (written at most once a minute) so a restarting
  container respects it; "Reconnect" within that spacing answers "too soon".
  A reconnection to Gladys (`connected`) or a configuration saved unchanged
  keeps the client and its websocket: only the status, the Discovery and the
  states are published again (caches cleared, `forgetPublishedStates`).
- Every reading checks the client generation after each await: a late answer
  of an old address publishes nothing and sets no status.
- 429 and 5xx (readings and uploads): a pause of Retry-After, else 15 min /
  5 min, bounded 1 min to 6 h, kept in `/data` and bounded when read back;
  no reading, connection nor upload during it.
- **Websocket**: own RFC 6455 client over `net` (not Node's global
  WebSocket) so every bound is ours: handshake answer 8 KB and 5 s, accept key
  checked, 64 KB per frame and per message (refused from the header, before
  any payload is kept), 32 fragments at most, payload copied once into a
  buffer of its announced size (linear in the bytes received, tested with
  1-byte chunks), server frames must not be masked, ping every 30 s, closed
  after 90 s without a byte. Messages read: `sys`, `tags[0]`, `errMsg`
  "REBOOTING" (closed at once, reconnected after the backoff); others ignored.
- **States**: queued, dropped when equal to the last published value
  (battery and temperature again after 30 min for the history), sent in one
  flush at a time, at most 240 per minute for everything (the core admits
  300); the rest waits for the next minute. "Reachable" is computed again
  every minute while connected.
- Every publication of a device starts from the device created in Gladys
  (`gladys.devices`) and adds back its features: nothing is ever lost.
- No control byte in any text file, no BOM, no mojibake (tests); no secret
  anywhere, and the docs never claim any protection of stored data (test).
