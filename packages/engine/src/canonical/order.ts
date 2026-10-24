/**
 * The one module that enumerates own keys (ADR 0020). `Object.keys` and its relatives list keys
 * in insertion order, which a resumed world may not share, so everything else in the engine
 * iterates the sorted lists made here. biome.json exempts this file, and only this file, from the
 * key-order.grit plugin; every other purity rule applies to it.
 */

/** Orders strings by UTF-16 code units, the order RFC 8785 §3.2.3 gives object keys. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Every own string key of `object`, enumerable or not, sorted by UTF-16 code units. A canonical
 * record's keys are all enumerable; validation reports any other key it finds here by its path.
 */
export function sortedOwnKeys(object: object): string[] {
  return Object.getOwnPropertyNames(object).sort(compareCodeUnits);
}

/** How many own string keys `object` has, enumerable or not; an array's include `length`. */
export function ownKeyCount(object: object): number {
  return Object.getOwnPropertyNames(object).length;
}

/** How many own symbol keys `object` has. */
export function symbolKeyCount(object: object): number {
  return Object.getOwnPropertySymbols(object).length;
}
