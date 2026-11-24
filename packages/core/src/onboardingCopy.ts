/**
 * **The words of the way in** (D298, B03 §9.9): every string the onboarding and the season check put
 * on a screen, in one place so the web and the phone say the same thing (the `hazardCopy.ts`
 * precedent). Taken from the reviewed mocks; the founder's copy pass owns every one. Two lines were
 * never drawn and are drafts: the receipt when no copy went out (`receipt.notSent`) and the receipt's
 * button when no questions are due (`receipt.continue`). The fallback refusal messages and the date
 * of birth's `invalid` line are drafts too — the server's own message is preferred when it sends one.
 *
 * The legal text and the questions are not here: they are versioned data (`legal/terms.ts`,
 * `knowBeforeYouGo.ts`). Nothing here may say or imply the ice is safe (D3).
 */

import { MINIMUM_SIGNUP_AGE } from './age';
import { DISPLAY_NAME_MAX_LENGTH, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from './profile';

/** The questions' name, in title case wherever it is a name. */
export const KNOW_BEFORE_YOU_GO_NAME = 'Know Before You Go';

/** How many steps a new account's way in has: Account, Terms, the questions, Home, Profile. */
export const ONBOARDING_STEP_COUNT = 5;

/** "2 of 5" — shown only when the account is new this session (§9.3). */
export function onboardingStepLabel(step: number): string {
  return `${step} of ${ONBOARDING_STEP_COUNT}`;
}

export const ONBOARDING_COPY = {
  account: {
    kicker: 'Account',
    step: 1,
    heading: 'Create your account',
    lede: 'Reports on Gli show your real name. This is how other skaters will recognize and trust you.',
    fullName: 'Your full name',
    username: 'Username',
    usernamePrefix: '@',
    dateOfBirth: 'Date of birth',
    dateOfBirthHint: 'Gli is for skaters 18 and older. Your birthday is never shared.',
    // The three parts' accessible names (and placeholders, if a surface draws them).
    month: 'Month',
    day: 'Day',
    year: 'Year',
    continue: 'Continue',
  },
  terms: {
    kicker: 'Terms of use',
    step: 2,
    heading: 'Read the terms',
    lede: 'The checkbox below unlocks once you’ve read the full terms.',
    /** Appended to the meta line's version once the end has been on screen. */
    readToEnd: 'Read to the end',
    openFullScreen: 'Open in full-screen',
    endMarker: 'End of the terms',
    /** The agree line: `before`, then `link` (the Privacy Notice), then `after`. */
    agree: {
      before: 'I have read and agree to the Terms of Use and the ',
      link: 'Privacy Notice',
      after: '.',
    },
    submit: 'Record acceptance',
  },
  receipt: {
    kicker: 'Terms of use',
    heading: 'Acceptance recorded',
    /** The sent-to line: `before`, the address in bold, then `after`. */
    sent: { before: 'A copy of the terms you accepted has been sent to ', after: '.' },
    /** Draft (not drawn): when the copy is known not to have gone. */
    notSent:
      'We couldn’t email you a copy. You can read the terms any time in Settings, under About.',
    start: 'Start the questions',
    /** Draft (not drawn): the button when no questions are due. */
    continue: 'Continue',
  },
  /** The receipt's *Next* block, shown only when the questions are due. */
  next: {
    kicker: `Next: ${KNOW_BEFORE_YOU_GO_NAME}`,
    body: 'Seven quick questions about reading reports and getting ready for the ice. You probably know every one. We ask every skater, at the start of every season.',
    how: [
      'One question at a time, two options to choose from.',
      'Correct answers are explained if needed.',
      'It takes about a minute.',
    ],
  },
  questions: {
    kicker: KNOW_BEFORE_YOU_GO_NAME,
    step: 3,
    /** The feedback line after the right pick: `correct`, then the question's `why`. */
    correct: 'Correct.',
    /** After the wrong pick: `notQuite`, the question's `why`, then `pickCorrect`. */
    notQuite: 'Not quite.',
    pickCorrect: 'Pick the correct answer to continue.',
    next: 'Next question',
    finish: 'Finish',
  },
  done: {
    kicker: KNOW_BEFORE_YOU_GO_NAME,
    step: 3,
    heading: 'Great work! You got them all right',
    lede: 'Thanks for taking a minute to answer these. You’ll see them again at the start of next season!',
    continue: 'Continue',
  },
  home: {
    kicker: 'Home',
    step: 4,
    heading: 'Where are you based?',
    lede: 'Your home anchors drive times and nearby notifications. It stays private: only you ever see it.',
    address: 'Home address',
    addressHint: 'Gli works out your drive-time zones from this address.',
    or: 'or',
    useLocation: 'Use my current location',
    /** The suggestion list's key hints on a desk. */
    keys: { move: 'Move', choose: 'Choose', close: 'Close' },
    save: 'Save and continue',
    skip: 'Skip for now',
  },
  profile: {
    kicker: 'Profile',
    step: 5,
    heading: 'Complete your profile',
    lede: 'All optional, and you can change it later in Settings. Your reports are public either way.',
    addPhoto: 'Add a photo',
    photoHint: 'Shown beside your name on every report.',
    bio: 'Bio',
    town: 'Town',
    townHint: 'Taken from your home address. Change it to anything you like.',
    publicProfile: 'Public profile',
    publicProfileHint:
      'Searchable, with your bio and report history. Private shows only your name and photo.',
    showTown: 'Show my town',
    showTownHint: 'On your public profile. Your address is never shown.',
    done: 'Open the map',
    skip: 'Skip',
  },
  season: {
    heading: 'A new season on the ice',
    termsRow: 'Terms of use',
    questionsRow: KNOW_BEFORE_YOU_GO_NAME,
    start: 'Start the questions',
    signOut: 'Not now — sign out',
  },
  /** The card's foot on every step but the season card. */
  foot: { signedInAs: 'Signed in as', signOut: 'Sign out' },
} as const;

/** The first word of a display name, for "Welcome back, Kate." (empty when there is none). */
export function firstName(displayName: string): string {
  // `split` always returns at least one element: '' for an empty name.
  return displayName.trim().split(/\s+/)[0] as string;
}

/** The season card's lede. Without a first name it greets without one. */
export function seasonCardLede(displayName: string): string {
  const first = firstName(displayName);
  const welcome = first ? `Welcome back, ${first}.` : 'Welcome back.';
  return `${welcome} Every skater answers the same seven questions at the start of each winter. You know these, and it takes about a minute.`;
}

/** "Nov 24, 2026" from a `YYYY-MM-DD` version, as a calendar date (no zone moves it). */
export function formatVersionDay(version: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(version);
  if (!match) throw new Error(`not a version date: ${version}`);
  return formatCardDay(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])), 'UTC');
}

/** "Nov 16, 2026": the day an instant fell on in the skater's zone. */
export function formatCardDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(ms);
}

/** The season card's terms row: "Unchanged since Nov 24, 2026", from the terms' version. */
export function termsUnchangedSince(termsVersion: string): string {
  return `Unchanged since ${formatVersionDay(termsVersion)}`;
}

/** The season card's questions row: "Last answered Nov 16, 2026", in the skater's zone. */
export function questionsLastAnswered(lastAt: number, timeZone: string): string {
  return `Last answered ${formatCardDay(lastAt, timeZone)}`;
}

/** What the receipt knows about the emailed copy (`consent.latestTermsReceipt`). */
export type ReceiptCopy = 'pending' | 'sent' | 'not_sent';

/**
 * The receipt's line. The sent-to line shows while the send is pending, accepted or unknown (it may
 * have gone); the other only when it is known not to have, or there was no address to send to.
 */
export type ReceiptLine =
  | { kind: 'sent'; before: string; email: string; after: string }
  | { kind: 'not_sent'; text: string };

export function receiptLine(copy: ReceiptCopy, email: string | null): ReceiptLine {
  if (copy === 'not_sent' || !email) {
    return { kind: 'not_sent', text: ONBOARDING_COPY.receipt.notSent };
  }
  return { kind: 'sent', ...ONBOARDING_COPY.receipt.sent, email };
}

/** What a date-of-birth problem says under the field (`incomplete` says nothing). */
export const DATE_OF_BIRTH_MESSAGES = {
  /** Draft (not drawn). */
  invalid: 'That date doesn’t look right. Check the day and the year.',
  underage: `You must be at least ${MINIMUM_SIGNUP_AGE} to use Gli.`,
} as const;

/**
 * Every refusal code the consent mutations throw (`ConvexError({ code, message })`, B03 §9.5),
 * besides the profile gate's own.
 */
export type ConsentRefusalCode =
  | 'terms_changed'
  | 'terms_not_opened'
  | 'terms_not_read'
  | 'account_required'
  | 'account_unexpected'
  | 'underage'
  | 'name_invalid'
  | 'username_invalid'
  | 'username_taken'
  | 'username_cooldown'
  | 'deletion_pending'
  | 'terms_first'
  | 'questions_changed';

/**
 * A toast's words for each refusal, when the error carries none of its own (or a client wants the
 * same words offline). Drafts for the founder's copy pass; the server may send these same strings.
 */
export const CONSENT_REFUSAL_MESSAGES: Readonly<Record<ConsentRefusalCode, string>> = {
  terms_changed: 'The terms were just updated. Please read the new version from the top.',
  terms_not_opened: 'Something went wrong loading the terms. Please read them again from the top.',
  terms_not_read: 'Please read the terms to the end before you accept them.',
  account_required: 'We need your name, username, and date of birth first.',
  account_unexpected: 'Your account is already set up. Reload to pick up where you left off.',
  underage: DATE_OF_BIRTH_MESSAGES.underage,
  name_invalid: `Please enter your full name, up to ${DISPLAY_NAME_MAX_LENGTH} characters.`,
  username_invalid: `Use ${USERNAME_MIN_LENGTH} to ${USERNAME_MAX_LENGTH} letters, numbers, and underscores, starting and ending with a letter or number.`,
  username_taken: 'Someone just took that username. Please pick another one.',
  username_cooldown: 'You can change your username once every 30 days.',
  deletion_pending:
    'Your account is set to be deleted. To keep it, cancel the deletion in Settings first.',
  terms_first: 'Please accept the terms first.',
  questions_changed: 'The questions were just updated. Please start again from the first one.',
};

/** When nothing better is known. */
export const CONSENT_REFUSAL_FALLBACK = 'Something went wrong. Please try again.';

/** The words for a refusal code, or the fallback for a code this build doesn't know. */
export function consentRefusalMessage(code: string | undefined): string {
  if (code !== undefined && Object.hasOwn(CONSENT_REFUSAL_MESSAGES, code)) {
    return CONSENT_REFUSAL_MESSAGES[code as ConsentRefusalCode];
  }
  return CONSENT_REFUSAL_FALLBACK;
}
