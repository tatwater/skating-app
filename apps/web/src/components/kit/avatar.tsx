import { Avatar as AvatarPrimitive } from '@base-ui/react/avatar';
import { cva, type VariantProps } from 'class-variance-authority';
import { Children, type ComponentProps, isValidElement, type ReactElement } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's Avatar: shadcn's Base UI avatar, re-skinned to the boards' people. **People are
 * circles, always** — the one shape the square console keeps round (`rounded-full`).
 *
 * - **Sized by the surface's people tokens**: `sm` (`size-avatar-sm`: 16 on the console, 22 on
 *   skater — a person in a button or a dense row), `md` (`size-avatar`: 20 / 28 — the person lockup
 *   and the top bar's faces) and `lg` (`size-avatar-lg`: 26 / 30 — the viewer at the rail's foot).
 *   Density follows `data-surface`; there is no pixel prop.
 * - **Initials, then the image.** The fallback is the person's initials (first and last word,
 *   capitalized) in semibold sans; an image replaces them once it has loaded, never before, so a
 *   slow or broken photo leaves the initials in place rather than an empty ring.
 * - **Tones.** `default` is the person lockup's (`.person .av`: the strong rule's gray, bright
 *   initials); `viewer` is the rail's (raised ground, a quiet ring, the bright-body ink).
 * - **The name is the accessible name.** A lone avatar is an image named for its person; one
 *   beside the written name (the lockup) passes `aria-hidden` so a reader doesn't hear it twice.
 * - **Initials keep the rail exception's sub-floor type** on the console (the founder's call: the
 *   rail, its badges and avatar initials keep their small sizes) — `sm` takes the rail step, `md`
 *   the kicker, `lg` the small-mono step.
 */
const avatarVariants = cva(
  [
    'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full select-none',
    'font-(family-name:--family-sans) leading-none font-semibold tracking-micro',
  ],
  {
    variants: {
      size: {
        sm: 'size-avatar-sm text-rail',
        md: 'size-avatar text-kick',
        lg: 'size-avatar-lg text-mono-sm',
      },
      tone: {
        default: 'bg-line2 text-fg',
        viewer: 'border border-solid border-fg3 bg-raise text-fg1',
      },
    },
    defaultVariants: { size: 'md', tone: 'default' },
  },
);

/** "Teagan Atwater" → "TA", "Sarah" → "S", "" → "?". Exported for its test. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.charAt(0) ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

type AvatarProps = Omit<AvatarPrimitive.Root.Props, 'children'> &
  VariantProps<typeof avatarVariants> & {
    /** The person's real name: the initials and the accessible name. */
    name: string;
    /** A photo URL. The initials show until it loads, and stay if it never does. */
    src?: string;
  };

function Avatar({ name, src, size = 'md', tone = 'default', className, ...props }: AvatarProps) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      role="img"
      aria-label={name}
      className={cn(avatarVariants({ size, tone }), className)}
      {...props}
    >
      {src !== undefined && (
        <AvatarPrimitive.Image
          data-slot="avatar-image"
          src={src}
          alt=""
          className="size-full object-cover"
        />
      )}
      <AvatarPrimitive.Fallback data-slot="avatar-fallback" aria-hidden="true">
        {initialsOf(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

/**
 * The face drawn in a stack: the top bar's colleagues (`.top .faces`). A ground-colored ring
 * (1.5 px — a drawing value, so px) cuts each face from the one it overlaps; a present colleague is
 * lit (the dim ink filled, bright initials, a bright-body rim), an idle one is drawn solid but dim
 * (the lowest ground, a strong-rule inset ring, quiet initials) — dim, never see-through.
 */
const FACE = [
  'border-[1.5px] border-solid border-bg',
  'bg-panel text-fg3 inset-ring inset-ring-line2',
  'data-present:bg-fg3 data-present:text-fg data-present:inset-ring-0 data-present:ring-1 data-present:ring-fg1',
];

type AvatarStackProps = ComponentProps<'div'> & {
  /** What the run is ("Also here"): the group's accessible name. */
  label: string;
  /** How many faces show before the rest fold into a "+N" circle. */
  max?: number;
  /** Face size; the stack's overlap is a quarter of it. */
  size?: 'sm' | 'md' | 'lg';
  /** `StackFace` children, in the order they should read. Present faces lead. */
  children: ReactElement<StackFaceProps> | ReactElement<StackFaceProps>[];
};

/**
 * The stacked-faces run. Each face tucks a quarter of its diameter under the one before it, so a
 * present colleague (who leads) sits over the idle ones. Past `max`, the rest fold into a "+N"
 * circle drawn like an idle face. **Never includes the viewer** — the caller's list leaves them out
 * (the rail's foot already shows who you are).
 */
function AvatarStack({
  label,
  max = 4,
  size = 'md',
  className,
  children,
  ...props
}: AvatarStackProps) {
  const faces = Children.toArray(children).filter(isValidElement<StackFaceProps>);
  // Present colleagues lead, in the caller's order within each group.
  const ordered = [
    ...faces.filter((f) => f.props.present),
    ...faces.filter((f) => !f.props.present),
  ];
  const shown = ordered.slice(0, max);
  const rest = ordered.slice(max);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a run of people, not form controls — a named group, never a fieldset.
    <div
      role="group"
      aria-label={label}
      data-slot="avatar-stack"
      className={cn('isolate inline-flex items-center', className)}
      {...props}
    >
      {shown.map((face, i) => (
        <Avatar
          key={face.key}
          name={face.props.name}
          src={face.props.src}
          size={size}
          data-present={face.props.present ? '' : undefined}
          aria-label={face.props.present ? face.props.name : `${face.props.name} (idle)`}
          className={cn(FACE, i > 0 && OVERLAP[size])}
          // Each face sits over the ones after it.
          style={{ zIndex: shown.length - i }}
        />
      ))}
      {rest.length > 0 && (
        <span
          data-slot="avatar-overflow"
          role="img"
          aria-label={`${rest.length} more: ${rest.map((f) => f.props.name).join(', ')}`}
          className={cn(
            avatarVariants({ size }),
            FACE,
            OVERLAP[size],
            'font-(family-name:--family-mono)',
          )}
        >
          +{rest.length}
        </span>
      )}
    </div>
  );
}

/** A quarter of the face's diameter, tucked under the face before it. */
const OVERLAP = {
  sm: '-ms-[calc(var(--size-avatar-sm)/4)]',
  md: '-ms-[calc(var(--size-avatar)/4)]',
  lg: '-ms-[calc(var(--size-avatar-lg)/4)]',
} as const;

type StackFaceProps = {
  /** The colleague's real name. */
  name: string;
  src?: string;
  /** On the page right now (lit); otherwise idle (dim, solid). */
  present?: boolean;
};

/** One colleague in an `AvatarStack`: data only — the stack draws it. */
function StackFace(_props: StackFaceProps): null {
  // Never rendered: `AvatarStack` reads its props and draws the face itself.
  /* v8 ignore next */
  return null;
}

export {
  Avatar,
  type AvatarProps,
  AvatarStack,
  type AvatarStackProps,
  avatarVariants,
  initialsOf,
  StackFace,
  type StackFaceProps,
};
