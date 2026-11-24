import { createFileRoute } from '@tanstack/react-router';

import { TermsPage } from '../components/skater/onboarding/EntryPages';

/**
 * The terms for an existing account (B03 §9.6, D295): its first sign-in since the terms became a
 * reading and an acceptance, or since their version changed. The same Terms step as a new
 * account's, without the step count; the receipt draws here under the hold.
 */
export const Route = createFileRoute('/terms')({ component: TermsPage });
