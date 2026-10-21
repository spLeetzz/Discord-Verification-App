/**
 * Anything that renders as a Discord user mention. `User.toString()` returns
 * `<@id>`; the fallback used by /setemail renders as "Unknown".
 */
export interface UserLike {
  toString(): string;
}
