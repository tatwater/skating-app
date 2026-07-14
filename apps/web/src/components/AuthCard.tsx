import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'

/**
 * Centered shell for the signed-out / provisioning pages (sign-in, sign-up, onboarding, re-ack),
 * built on the shadcn `Card` with the FUI mono-uppercase title.
 */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center font-mono text-foreground text-lg uppercase tracking-widest">
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">{children}</CardContent>
      </Card>
    </div>
  )
}
