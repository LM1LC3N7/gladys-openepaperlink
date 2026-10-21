# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
It brings the e-paper tags of an OpenEPaperLink access point into Gladys
through the local HTTP API and websocket of the access point, a JavaScript
port of the OpenEPaperLink Home Assistant integration (Apache-2.0, see
`THIRD_PARTY_NOTICES.md`), and shows texts on the tags from scenes.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "burst"   # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/handlers.js                   the SDK handlers -> OeplApp (shared with the tests)
src/app.js                        OeplApp: connection, websocket events, states budget, upload queue, status
src/model.js                      access point and tags -> Gladys devices and states (pure)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/store.js                      /data/openepaperlink.json: tags, pause, last attempt
src/constants.js                  frozen keys, paths, timings, limits
src/i18n.js                       texts shown in Gladys (en/fr)
src/ap/api.js                     HTTP API calls, statuses -> error kinds
src/ap/http.js                    fetch with timeout and size cap, network failures sorted
src/ap/websocket.js               bounded websocket client (RFC 6455) over a TCP socket
src/ap/parse.js                   readers of the answers and messages (pure)
src/ap/errors.js                  ApError and its kinds
src/image/font.js                 5x9 bitmap font drawn for this project
src/image/text.js                 text cleaning, wrapping, layout, drawing (pure)
src/image/jpeg.js                 baseline JPEG encoder (pure)
gladys-assistant-integration.json manifest: name, config_schema, actions, scene action...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test: fake Gladys (SDK), fake access point, fake clock
scripts/cover.mjs                 cover.png generator (plain Node)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** `ap:main` for the access point, `tag:<MAC>`
  (16 hex digits, upper case) for a tag, built with
  `gladys.externalIds(type, platformId)`. The same goes for every key users
  store: manifest `config_schema`, `actions`, the scene action and its field
  values, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume.
- **Read only devices.** No switch, no command feature: a text reaches a tag
  through the scene action only.
- **Never a burst toward the access point**: every upload goes through the
  queue of `src/app.js` (one at a time, spaced, budget of the action);
  every reading respects the attempt spacing and the pauses.
- **Bounded input**: HTTP answers, websocket frames and messages, texts and
  images have a size limit (`LIMITS`); parsing is linear; tables keyed by
  network values have no prototype.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`scene_actions`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, actions, scene action options): change both sides together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (the websocket test uses a local
  TCP server on 127.0.0.1).
