import type { ReactNode } from 'react'

/** Centered card shell for the signed-out / provisioning pages (sign-in, sign-up, onboarding, re-ack). */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="flex w-full max-w-sm flex-col gap-5 rounded-lg border border-border bg-surface p-6">
        <h1 className="text-center font-bold font-mono text-foreground text-lg uppercase tracking-widest">
          {title}
        </h1>
        {children}
      </div>
    </div>
  )
}
