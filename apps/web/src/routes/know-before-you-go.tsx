import { createFileRoute } from '@tanstack/react-router';

import { KnowBeforeYouGoPage } from '../components/skater/onboarding/EntryPages';

/**
 * Know Before You Go (B03 §9.6, D296): the seven questions, asked once of every account and again
 * at a skater's first sign-in after the Ice Watch opens a new season.
 */
export const Route = createFileRoute('/know-before-you-go')({ component: KnowBeforeYouGoPage });
