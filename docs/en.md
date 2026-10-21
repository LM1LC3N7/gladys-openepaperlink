# OpenEPaperLink

Brings the e-paper tags of an [OpenEPaperLink](https://openepaperlink.org)
access point into Gladys, through the local API of the access point (HTTP and
websocket, no cloud), and shows texts on them from your scenes.

> **Never tested with a real device.** This integration was written from the
> Home Assistant integration of the project and the firmware source of the
> access point, and tested against a simulated access point only. Unofficial,
> not affiliated with the OpenEPaperLink project.

## What you get

- **The access point**: reachable or not, the state of its radio, the number
  of tags with a low battery and of tags overdue (as the access point counts
  them).
- **One device per tag** (keyed by its MAC address): battery level (estimated
  from the voltage: 2.2 V is 0 %, 2.6 V and above 100 %), the temperature of
  the tag chip, "reachable" (the tag checked in on time) and its last contact
  (UTC). A tag served by another access point has no battery value.
- **Scene action "Show a text on an e-paper tag"**: pick the tag, type the
  text (scene variables work), and optionally the colour, the background, the
  size and the alignment. Read only devices: nothing else can be commanded.

## Setup

1. Your OpenEPaperLink access point runs and its web page opens in a browser
   (for example `http://192.168.1.30`). Give it a fixed address in your router
   if you can.
2. In Gladys, open this integration and type that address (no `https://`:
   the access point speaks plain HTTP). It has no password.
3. Save. The access point and its tags appear in the Discovery tab: create
   the ones you want.

## Showing a text

- Up to 280 characters; line breaks are kept. The text is drawn as large as it
  fits on the display (or small, medium, large), centred or left aligned.
- The font draws the ASCII characters and the French accents of lower case
  letters (é, è, à, ç…); an accented capital is drawn without its accent, and
  any other character (an emoji…) shows as "?".
- Red and yellow only on displays that have them (the action says so
  otherwise).
- The access point stores the image; **the tag shows it at its next
  check-in** (often within a minute, longer for a tag that sleeps more). The
  output "Taken by the access point" is true when the access point accepted
  it.

### Never a burst

- One upload at a time, at least 2 seconds apart, and at least 15 seconds
  apart for the same tag.
- A newer text for a tag replaces the one still waiting for it (the older one
  ends with "replaced").
- At most 10 texts wait; a text that could not leave within the 25 seconds of
  the action is dropped, never sent late.
- "Busy" (409) from the access point: the next uploads wait what it asked
  (5 seconds to 5 minutes). 429 or 5xx: everything pauses (1 minute to 6
  hours), across restarts too.
- If the access point does not answer an upload in time, the action says
  "sent, without confirmation": the tag may still show the text.

## How it reads

- The tag list (`/get_db`) when connecting, at most every 15 minutes; then
  the websocket (`/ws`) brings every tag check-in and the state of the access
  point as they happen.
- A dropped connection is tried again after 10 s, 30 s, 1, 2, then 5 minutes;
  never two attempts closer than 10 seconds, even when the container restarts.
  "Reconnect" right after an attempt does nothing more.
- Values go to Gladys in groups, at most 240 per minute; an unchanged value
  is not sent again (battery and temperature are, every 30 minutes, for the
  history).

## Questions for testers

If you own an access point, please tell us (forum, or an issue on GitHub):
does the tag show the text with the right size and colours? How long until it
shows? Do the battery level and the temperature match the web page of the
access point?

## Data and privacy

Nothing leaves your network. The integration keeps in its `/data` volume only
the tag list (MAC, name, type), the end of a pause and the time of the last
connection attempt.
