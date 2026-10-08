import React from 'react';

/**
 * VidLens mark: a lens (magnifier) with a play button inside — "finding videos".
 * Drawn in `currentColor` so it can sit on the lime tile (dark glyph) or on dark backgrounds.
 */
export function LogoMark({ size = 22, className, style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {/* lens ring */}
      <circle cx="13.5" cy="13.5" r="10" stroke="currentColor" strokeWidth="2.6" />
      {/* inner aperture */}
      <circle cx="13.5" cy="13.5" r="6.6" stroke="currentColor" strokeWidth="1.1" opacity="0.45" />
      {/* play button */}
      <path d="M11.4 9.6 18.4 13.5 11.4 17.4Z" fill="currentColor" />
      {/* handle */}
      <path d="M21 21 28.2 28.2" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
      {/* glint */}
      <path d="M7.6 11.2a6.4 6.4 0 0 1 3.4-3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

/** Wordmark: "Vid" in the text colour, "Lens" in the accent. */
export function LogoWordmark({ className }) {
  return (
    <span className={className}>
      Vid<span className="logo-accent">Lens</span>
    </span>
  );
}
