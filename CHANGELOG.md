# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- OpenEPaperLink access point, through its local HTTP API and websocket: the
  tag list (`/get_db`) when connecting and at most every 15 minutes, then the
  check-ins and the access point state live (`/ws`). A JavaScript port of the
  OpenEPaperLink Home Assistant integration (Apache-2.0). No cloud.
- One device for the access point (reachable, radio state, tags with a low
  battery, tags overdue) and one per tag, keyed by its MAC address (battery,
  chip temperature, reachable, last contact). Read only: no switch, no
  command.
- Scene action "Show a text on an e-paper tag": the text (280 characters at
  most, cleaned) drawn as large as it fits with a 5x9 font made for this
  integration, encoded as a JPEG of the display size (no dependency, 512 KB
  at most), sent to `/imgupload` after checking that the access point knows
  the tag. Colour, background, size and alignment options.
- Never a burst toward the access point: one upload at a time, 2 s apart (15 s
  for the same tag), a newer text for a tag replacing the waiting one, at most
  10 waiting, nothing sent after the 25 s of the action; "busy" (409) and
  429/5xx pauses, the latter kept across restarts.
- A websocket client with its own bounds (64 KB per message, linear parsing,
  handshake checked, ping and idle timeout); reconnection after 10 s to 5 min,
  never two attempts closer than 10 s, restarts of the container included.
- States sent in groups within a budget of 240 per minute; status and
  Discovery published again at every connection to Gladys; a device
  published again keeps every feature of the created one.
- `LICENSE` (Apache-2.0) and `THIRD_PARTY_NOTICES.md`, copied into the image.

### Fixed

- A close frame in the same packet as the websocket handshake no longer
  leaves the integration "connected" on a dead socket: it reconnects after
  the backoff; a message in that packet is no longer lost.
- A ping flood or an access point that stops reading closes the websocket
  instead of piling up answers in memory.
- A large first message right after the handshake no longer fails it.
- A websocket frame left unfinished closes after 30 s; the handshake must be
  a real websocket upgrade, without extension; text must be valid UTF-8.
- A tag renamed many times republishes the Discovery at most every 5 s.
- A restart no longer reads the whole tag list again within 15 minutes.
- Leading blank lines and spaces no longer eat the 280 characters of a text.
- A display too small for one character refuses the text instead of
  reporting an empty image as shown.
- A 5xx of the display type or of the upload only holds the uploads, no
  longer the readings and the websocket; the hold is kept across restarts,
  and a text it stops says until when.
- A healthy websocket stream whose packets end inside a frame is no longer
  closed after 30 s.

[Unreleased]: https://github.com/LM1LC3N7/gladys-openepaperlink/commits/main
