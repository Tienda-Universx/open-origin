/**
 * Engine behavior version, written into every snapshot header. Bump it whenever the same inputs
 * would produce different state, events, or hashes, because replay requires an equal version.
 * It equals the version of this private package (a test enforces it); that version exists only to
 * name engine behavior, so the two never need to differ.
 */
export const ENGINE_VERSION = "0.1.0";
