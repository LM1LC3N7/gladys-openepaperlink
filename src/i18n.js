// -----------------------------------------------------------------------------
// The texts users read in Gladys (connection status, the configuration
// button, scene action errors), in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });

/** "14:05 UTC" for a time in ms. */
const clock = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** "30 s", "5 min", "2 h". */
export function duration(ms) {
  if (ms < 60_000) {
    return `${Math.max(1, Math.round(ms / 1000))} s`;
  }
  const minutes = Math.round(ms / 60_000);
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

export const T = {
  missing: both(
    'Type the address of the OpenEPaperLink access point in the configuration (see the guide).',
    "Saisissez l'adresse du point d'accès OpenEPaperLink dans la configuration (voir le guide).",
  ),
  invalidHost: both(
    'The address of the access point is not a plain address (for example 192.168.1.30, without https://).',
    "L'adresse du point d'accès n'est pas une simple adresse (par exemple 192.168.1.30, sans https://).",
  ),
  paused: (until) =>
    both(
      `The access point asked to slow down (429) or is in trouble (5xx): paused until ${clock(until)}.`,
      `Le point d'accès demande de ralentir (429) ou est en difficulté (5xx) : en pause jusqu'à ${clock(until)}.`,
    ),
  connecting: both('Connecting to the access point…', "Connexion au point d'accès…"),
  offline: (at) =>
    both(
      `The access point does not answer (off, rebooting, or off the network): next try at ${clock(at)}.`,
      `Le point d'accès ne répond pas (éteint, en redémarrage, ou hors du réseau) : prochain essai à ${clock(at)}.`,
    ),
  failing: (error, at) =>
    both(
      `The access point does not answer as expected (${error}): next try at ${clock(at)}.`,
      `Le point d'accès ne répond pas comme prévu (${error}) : prochain essai à ${clock(at)}.`,
    ),
  connected: (count) =>
    both(
      `Connected: ${count} tag${count === 1 ? '' : 's'} on the access point.`,
      `Connecté : ${count} étiquette(s) sur le point d'accès.`,
    ),
  dataReset: both(
    'The saved data was unreadable and was reset.',
    'Les données enregistrées étaient illisibles et ont été réinitialisées.',
  ),
  tooSoon: (wait) =>
    both(
      `A connection was tried less than ${duration(wait)} ago: no new attempt yet.`,
      `Une connexion a été tentée il y a moins de ${duration(wait)} : pas de nouvel essai pour l'instant.`,
    ),
};

/** Messages of the scene action, in English (Gladys shows the error as is). */
export const E = {
  notConfigured: 'The address of the access point is missing: nothing sent',
  notTag: 'Choose an OpenEPaperLink tag (not the access point): nothing sent',
  emptyText: 'The text is empty once cleaned: nothing sent',
  badOption: (name) => `Unknown ${name}: nothing sent`,
  sameColors: 'The text and the background have the same colour: nothing sent',
  noColor: (color) => `This display has no ${color}: nothing sent`,
  unknownTag: 'The access point does not know this tag (another access point?): nothing sent',
  noDisplay: 'The size of this display is unknown to the access point: nothing sent',
  tooSmall: 'This display is too small for one character: nothing sent',
  tooLarge: 'The image of this text is too large for the access point: nothing sent',
  queueFull: 'Too many texts are waiting for the access point: nothing sent',
  replaced: 'Replaced by a newer text for the same tag: not sent',
  late: 'No time left to send this text without rushing the access point: nothing sent',
  paused: 'The access point asked to slow down: nothing sent',
  busy: 'The access point is busy: not sent, try again later',
  unreachable: 'The access point is unreachable: nothing sent',
  unconfirmed:
    'Text sent, without confirmation: the access point did not answer in time (the tag may still show it)',
  failed: (detail) => `The access point refused the text (${detail}): not shown`,
};
