/**
 * A run log's page (D341, D347): 200 lines, for a corpus run's tail (`machineryRuns.events`), a cron
 * run's (`machineryCrons.runLog`) and a cut attempt's (`machineryImagery.attemptLog`). Its own module
 * so the three reads share it without importing each other.
 */
export const EVENTS_PAGE_SIZE = 200;
