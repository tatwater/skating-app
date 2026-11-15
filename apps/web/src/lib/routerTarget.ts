/**
 * A path as the router takes it: the path, and its query as a search object (a link through the
 * router names its search apart from its path).
 */
export function routerTarget(path: string): { to: string; search?: Record<string, string> } {
  const at = path.indexOf('?');
  if (at === -1) return { to: path };
  return {
    to: path.slice(0, at),
    search: Object.fromEntries(new URLSearchParams(path.slice(at + 1))),
  };
}
