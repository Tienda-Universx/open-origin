/** A Proxy whose handler has been revoked: every inspection of it, even Array.isArray, throws. */
export function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}
