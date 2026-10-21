// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { parseBaseUrl } from './ap/parse.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  language: 'fr',
};

export function normalizeConfig(raw = {}) {
  const c = {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)),
  };
  const host = typeof c.host === 'string' ? c.host.trim() : '';
  const baseUrl = parseBaseUrl(host);
  let wsHost;
  let wsPort = 80;
  if (baseUrl) {
    const url = new URL(baseUrl);
    wsHost = url.hostname.replace(/^\[|\]$/g, '');
    wsPort = url.port ? Number(url.port) : 80;
  }
  return {
    baseUrl,
    wsHost,
    wsPort,
    /** A host was typed but is not a plain address (said in the status). */
    invalidHost: host !== '' && baseUrl === undefined,
    ready: baseUrl !== undefined,
    language: c.language === 'en' ? 'en' : 'fr',
    /** What a new client is built from: an unchanged save keeps the client. */
    fingerprint: baseUrl ?? '',
  };
}
