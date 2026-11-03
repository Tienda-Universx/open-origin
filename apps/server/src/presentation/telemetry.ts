/**
 * The presentation plane's operation telemetry (C3, ADR 0025 "Planes and the boundary"; ADR 0026,
 * "Admin contracts"): what the admin status reports of the clients and of the limits that act on
 * them. It lives in this plane, where the world plane cannot import it, and no public message
 * carries any of it. The members are named as `ServerStatus` names them.
 */

/** Counts since the presentation started, each only ever growing. */
export type PresentationCounts = {
  /** Clients dropped because serving them threw. */
  faults: number;
};

/** The presentation's telemetry: the gauges of now, and the counts since it started. */
export type PresentationTelemetry = Readonly<PresentationCounts> & {
  /** The connected clients. */
  readonly connections: number;
  /** The clients the last fan-out could not send to because their buffer was full. */
  readonly laggingClients: number;
};

/** Counts that start at zero. */
export function noCounts(): PresentationCounts {
  return { faults: 0 };
}
