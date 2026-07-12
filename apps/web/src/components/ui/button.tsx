import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

/**
 * shadcn-style button, colored from the shared semantic tokens (D7). No Radix `Slot`
 * (`asChild`) yet — where we need a link that looks like a button we apply `buttonVariants`
 * to a `<Link>` directly, which keeps the dependency surface small for Phase 0.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:opacity-90',
        destructive: 'bg-danger text-danger-foreground hover:opacity-90',
        outline: 'border border-border-strong bg-background hover:bg-surface-muted',
        secondary: 'bg-surface-muted text-foreground hover:opacity-90',
        ghost: 'hover:bg-surface-muted',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 px-3',
        lg: 'h-11 px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  )
}

export { buttonVariants }
