/** E360 read scopes. Never request a :write scope. */
export const E360_READ_SCOPE = "e360:read";
export const E360_TIMECARDS_READ_SCOPE = "e360:timecards:read";

/** Fixed message shown when HCSS refuses a scope (token invalid_scope, missing from the granted scope, or API 403). */
export const scopeError = (...scopes: string[]) =>
  scopes.length === 1
    ? `The HCSS Client ID needs the ${scopes[0]} scope enabled in HCSS Credentials.`
    : `The HCSS Client ID needs the ${scopes.slice(0, -1).join(", ")} and ${scopes.at(-1)} scopes enabled in HCSS Credentials.`;

/** Scope an E360 path needs: time cards need e360:timecards:read, everything else e360:read. */
export const scopeForPath = (path: string) => (/^\/api\/v\d+\/timecards/i.test(path) ? E360_TIMECARDS_READ_SCOPE : E360_READ_SCOPE);

/**
 * Whether an OAuth token response grants `scope`.
 * RFC 6749: if the issued scope equals the requested scope, the server MAY omit the scope parameter.
 * An omitted value (undefined) therefore counts as granted. A present string is checked literally.
 */
export function grantedIncludes(granted: string | undefined, scope: string): boolean {
  if (granted === undefined) return true;
  return granted.split(/\s+/).filter(Boolean).includes(scope);
}
