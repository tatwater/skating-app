/** Full-screen holding frame shown while auth/profile state resolves or a redirect settles. */
export function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <span className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        Loading…
      </span>
    </div>
  );
}
