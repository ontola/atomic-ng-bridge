/**
 * Marks a string as a developer-facing diagnostic rather than user copy.
 *
 * The badge's text is deliberately not translated: it names sync states and
 * NextGraph errors, and it only appears when the mirror is explicitly enabled.
 *
 * It also keeps these strings out of a host app's translation catalogs. Living
 * in a package rather than in the app's own `src` already does that for
 * extractors that scan source directories (Atomic's `wuchale` setup, for one),
 * and this marks the intent for any that reach further — `atomic-server`'s
 * config lists `ngStatus` in `IGNORED_FUNCTIONS` for exactly that reason.
 */
export const ngStatus = (message: string): string => message;
