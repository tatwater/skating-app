/**
 * *Open in Body →* for a Corpus task (both 6a handlers): the body's Names tab, where its names and
 * its class are set by hand.
 */
export const bodyNamesPath = (bodyId: string): string =>
  `/admin/body/${encodeURIComponent(bodyId)}?tab=names`;
