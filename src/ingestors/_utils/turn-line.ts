/**
 * The memento-text convention shared by every ingestor: one conversation turn is stored as
 * `"SPEAKER: body"`. `turnLine` owns the separator and ordering; `roleLine` adds the
 * role-source upper-casing (assistant/user/…). The stored string is only embedded/searched,
 * never parsed back — so this is a display convention, kept single-sourced so every source
 * renders identically.
 */

/** A turn from a named speaker (a person's handle/name): `"<speaker>: <body>"`, verbatim. */
export function turnLine(speaker: string, body: string): string {
  return `${speaker}: ${body}`
}

/** A turn from a role source (assistant/user/system): the role label is upper-cased. */
export function roleLine(role: string, body: string): string {
  return turnLine(role.toUpperCase(), body)
}
