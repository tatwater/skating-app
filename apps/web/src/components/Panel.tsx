import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

/**
 * A titled console-style panel — the FUI framing (00-vision) for the information-dense web
 * surface. Built on the shadcn `Card`; the mono, uppercase, wide-tracked header is the sci-fi cue.
 */
export function Panel({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader className="border-b">
        <CardTitle className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-foreground-muted text-sm">{children}</CardContent>
    </Card>
  );
}
