/**
 * The most rows the console's asks reads return without a `more` flag — the server's `QUEUE_CAP`s,
 * unexported (`corpusPlaceNames.openForBody`, `corpusRequests.openBayRequestsForBody`). A read that
 * comes back this full may have stopped short, so the asks are never counted as whole (a server
 * request: a `more` flag on each). One place, so the frame and the Places tab can't disagree.
 */
export const PLACE_NAMES_READ_CAP = 400;
export const BAY_REQUESTS_READ_CAP = 200;
