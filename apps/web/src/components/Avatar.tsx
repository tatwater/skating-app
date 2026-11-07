import { personNameClass } from './PersonName';

/**
 * A round avatar with an initial fallback when the user has no Clerk image.
 *
 * Both branches carry the person's name — the image as `alt`, the fallback as an initial — and
 * autocapture collects element attributes as well as text, so both are masked (D235).
 */
export function Avatar({
  displayName,
  imageUrl,
  size = 64,
}: {
  displayName: string;
  imageUrl?: string;
  size?: number;
}) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={displayName}
        width={size}
        height={size}
        className={`rounded-full object-cover ${personNameClass}`}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      aria-hidden
      className={`flex items-center justify-center rounded-full bg-muted font-semibold text-foreground-muted ${personNameClass}`}
      style={{ width: size, height: size, fontSize: size / 2.5 }}
    >
      {displayName.trim().charAt(0).toUpperCase() || '?'}
    </div>
  );
}
