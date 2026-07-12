import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge conditional class lists, de-duplicating conflicting Tailwind utilities (shadcn). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
