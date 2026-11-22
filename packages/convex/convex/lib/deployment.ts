/**
 * **Which deployment this is** — dev or not — told by the deployment's own URL (`CONVEX_CLOUD_URL`):
 * an action has no other view of where it runs. `plans/05-accounts-and-credentials.md` registers the
 * two: dev is `agile-bee-397`; prod (`diligent-guanaco-965`) has never been initialized.
 *
 * One exact check, read by the dev inbox seed's refusal (`lib/seedPeople`) and by every run row's
 * `isProd` (`standing.ts`, `regionStats.ts`, `waterBodies.ts`), so a look-alike host can never pass as
 * dev (B01-5; it replaced a substring test that a name merely containing dev's would have passed).
 */

/** The dev deployment's name. */
export const DEV_DEPLOYMENT = 'agile-bee-397';

/** The dev deployment's own host: the deployment name, exactly, under Convex's cloud domain. */
export const DEV_HOST = `${DEV_DEPLOYMENT}.convex.cloud`;

/**
 * Whether this deployment is dev: its URL parses, is `https`, and its host is exactly
 * {@link DEV_HOST} with no port — so a look-alike (`agile-bee-3970.convex.cloud`,
 * `agile-bee-397.evil.example`, the name in a path or a query) is not, and a missing or unparseable
 * value fails closed.
 */
export function isDevDeployment(
  cloudUrl: string | undefined = process.env.CONVEX_CLOUD_URL,
): boolean {
  if (!cloudUrl) return false;
  let url: URL;
  try {
    url = new URL(cloudUrl);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname === DEV_HOST && url.port === '';
}

/** A run row's `isProd`: every deployment that isn't exactly dev (fails toward prod). */
export const isProdDeployment = (cloudUrl?: string): boolean =>
  !isDevDeployment(cloudUrl ?? process.env.CONVEX_CLOUD_URL);
