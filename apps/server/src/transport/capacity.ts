/**
 * The connection caps of the public listener (ADR 0026, "Limits and backpressure"): at most
 * `global` connections in all and `perIp` from one IP address, both configurable, refused at the
 * upgrade. A slot is taken before the upgrade and given back when its socket closes, so two
 * upgrades can never pass a cap together. The addresses it counts by are C2: they never leave it.
 */

/** Which cap refused a connection. */
export type FullCap = "global" | "per_ip";

/** The caps of a listener. */
export type Caps = { readonly global: number; readonly perIp: number };

/** `value` when it is a safe integer of at least 1, else a RangeError naming `what`. */
function cap(what: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${what} is an integer of at least 1, not ${value}`);
  }
  return value;
}

/** The connections a listener holds, in all and by IP address. */
export class Capacity {
  readonly #global: number;
  readonly #perIp: number;
  readonly #byIp = new Map<string, number>();
  #open = 0;

  constructor({ global, perIp }: Caps) {
    this.#global = cap("the global cap", global);
    this.#perIp = cap("the cap per IP", perIp);
  }

  /** The connections that hold a slot: upgraded, or upgrading. */
  get open(): number {
    return this.#open;
  }

  /** Takes a slot for a connection from `ip`; returns the cap that refused it, if one did. */
  take(ip: string): FullCap | undefined {
    if (this.#open >= this.#global) return "global";
    const fromIp = this.#byIp.get(ip) ?? 0;
    if (fromIp >= this.#perIp) return "per_ip";
    this.#open += 1;
    this.#byIp.set(ip, fromIp + 1);
    return undefined;
  }

  /** Gives back a slot of `ip`; throws when `ip` holds none, a release without its take. */
  release(ip: string): void {
    const fromIp = this.#byIp.get(ip);
    if (fromIp === undefined) throw new Error("released a connection slot that was not taken");
    if (fromIp === 1) this.#byIp.delete(ip);
    else this.#byIp.set(ip, fromIp - 1);
    this.#open -= 1;
  }
}
