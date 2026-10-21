# gladys-openepaperlink

[Gladys Assistant](https://gladysassistant.com) external integration for
**OpenEPaperLink** e-paper tags, through the local HTTP API and websocket of
the access point: battery, chip temperature, reachability and last contact of
each tag, the state of the access point, and a scene action that shows a text
on a tag. No cloud. Unofficial, not affiliated with the OpenEPaperLink
project.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress (milestone 1).** Never tested with a real device: tested
> against a simulated access point only.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (OeplApp)
                                   ├─ src/ap/api.js        http://<ap>/get_db, /tagtypes/XX.json, /imgupload
                                   ├─ src/ap/websocket.js  ws://<ap>/ws, bounded RFC 6455 client
                                   ├─ src/ap/http.js       fetch, timeout, size cap, failures sorted
                                   ├─ src/ap/parse.js      readers of the answers and messages (pure)
                                   ├─ src/image/           text cleaning, 5x9 font, layout, JPEG encoder
                                   ├─ src/model.js         -> Gladys devices and states (pure)
                                   └─ src/store.js         /data/openepaperlink.json
```

- **Readings**: `GET /get_db` (paged) when connecting, at most every 15
  minutes; then the websocket brings `tags` (one tag at each check-in) and
  `sys` (the access point) messages. A dropped websocket is tried again after
  10 s, 30 s, 1, 2, then 5 minutes; never two attempts closer than 10 s (the
  time of the last one is kept in `/data`).
- **Devices**: the access point (`ap:main`: reachable, radio state, tags with
  a low battery, tags overdue) and one per tag (`tag:<MAC>`: battery from the
  voltage, chip temperature, reachable, last contact). All read only.
- **Scene action `show_text`**: the tag is asked to the access point
  (`get_db?mac=`), its display read from `/tagtypes/<type>.json`, the text
  cleaned and drawn, encoded as a baseline JPEG (4:4:4) and sent as multipart
  (`mac`, `dither=0`, then the file). One upload at a time, 2 s apart, 15 s
  for the same tag; a newer text replaces the waiting one; 25 s budget.
- **Pauses**: 409 "busy" holds the uploads (Retry-After, 5 s to 5 min); 429
  and 5xx pause everything (1 min to 6 h), kept in `/data`.
- **States**: grouped, at most 240 per minute, unchanged values dropped
  (battery and temperature again every 30 min).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit
npx github:GladysAssistant/integration-store .  # store admission checks
node scripts/cover.mjs cover.png                # regenerate the cover
```

`test/helpers/` holds a fake access point (fetch and an in-memory websocket)
and a clock moved by hand; `test/websocket.test.js` runs the websocket client
against a real local TCP server.

## Credits

- [OpenEPaperLink/Home_Assistant_Integration](https://github.com/OpenEPaperLink/Home_Assistant_Integration)
  (Apache-2.0), 3.0.0: read as the reference and ported to JavaScript (no
  Python runs here).
- The firmware of the access point ([OpenEPaperLink/OpenEPaperLink](https://github.com/OpenEPaperLink/OpenEPaperLink),
  CC BY-NC-SA 4.0) was read to check the HTTP behaviour; nothing of it is
  copied.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic lists the repository in the Gladys store
(added at the first real release).

## License

Apache-2.0 (see [LICENSE](LICENSE)); the logic ported from the OpenEPaperLink
Home Assistant integration (Apache-2.0) is listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This project is not
affiliated with the OpenEPaperLink project.
