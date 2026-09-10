/**
 * Inline icons.
 *
 * Hand-written SVG rather than an icon package: this is six shapes, and a
 * dependency would ship a few hundred more plus a build-time tree-shake to
 * remove them. Every dependency is also one more thing to explain.
 *
 * All of them are `aria-hidden` and carry no title. That is deliberate and
 * load-bearing: an icon inside a button must not contribute to the button's
 * accessible name, or "Yes" becomes "check Yes" for a screen reader — and the
 * end-to-end tests that locate buttons by their exact accessible name stop
 * finding them. The icon is decoration; the label is the meaning.
 *
 * `currentColor` throughout, so colour is set by the CSS that places them.
 */

interface IconProps {
  /** Size in rem, so icons scale with an enlarged device font like everything else. */
  size?: number;
  className?: string;
}

function svgProps({ size = 1.5, className }: IconProps) {
  return {
    className,
    width: `${size}rem`,
    height: `${size}rem`,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
}

/** Affirmative answer. */
export function CheckIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** Negative answer. */
export function CrossIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/** "This moves you forward" on a list-style answer. */
export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...svgProps({ size: 1.25, ...props })}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/** Back. */
export function ChevronLeftIcon(props: IconProps) {
  return (
    <svg {...svgProps({ size: 1.25, ...props })}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

/**
 * The trust marker in the header. The question a person is actually asking at
 * this moment is "who is getting my phone number", and a lock answers it
 * faster than a sentence.
 */
export function ShieldIcon(props: IconProps) {
  return (
    <svg {...svgProps({ size: 1, ...props })}>
      <path d="M12 3 5 6v5c0 4.4 2.9 8.5 7 9.7 4.1-1.2 7-5.3 7-9.7V6l-7-3Z" />
      <path d="m9.5 12 1.8 1.8 3.4-3.6" />
    </svg>
  );
}

/** Explanatory note. */
export function InfoIcon(props: IconProps) {
  return (
    <svg {...svgProps({ size: 1.25, ...props })}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

/** Something went wrong, carried by shape as well as colour. */
export function AlertIcon(props: IconProps) {
  return (
    <svg {...svgProps({ size: 1.25, ...props })}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4.5M12 16h.01" />
    </svg>
  );
}

/** Completion. */
export function CheckCircleIcon(props: IconProps) {
  return (
    <svg {...svgProps({ size: 2, ...props })}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  );
}
