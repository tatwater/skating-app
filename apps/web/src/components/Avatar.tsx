/** A round avatar with an initial fallback when the user has no Clerk image. */
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
        className="rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      aria-hidden
      className="flex items-center justify-center rounded-full bg-muted font-semibold text-foreground-muted"
      style={{ width: size, height: size, fontSize: size / 2.5 }}
    >
      {displayName.trim().charAt(0).toUpperCase() || '?'}
    </div>
  );
}
