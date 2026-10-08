import React, { useEffect, useRef, useState } from 'react';
import IntroCore from './IntroCore';

const NAME = 'VIDLENS';
const ACCENT_FROM = 3; // "LENS" is drawn in the accent colour
const GLYPHS = '#%&*+=/<>?@$01';
const LOAD_MS = 1700;
const EXIT_MS = 950;

const STATUS = [
  { at: 0, text: 'Loading image brain' },
  { at: 35, text: 'Connecting Instagram Reels' },
  { at: 65, text: 'Connecting Meta Ad Library' },
  { at: 96, text: 'Ready' },
];

const randomGlyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;

/**
 * Full-screen intro shown on page load: logo pops in, the name decodes from glitch glyphs,
 * a progress bar fills, then the screen splits open. `onReveal` fires as the split starts
 * (so the page can mount and run its own entrance), `onDone` once the overlay is gone.
 * Click or any key skips straight to the split.
 */
export default function Intro({ onReveal, onDone }) {
  const [name, setName] = useState(() => [...NAME].map(randomGlyph).join(''));
  const [progress, setProgress] = useState(0);
  const [exiting, setExiting] = useState(false);
  const exitedRef = useRef(false);

  const startExit = () => {
    if (exitedRef.current) return;
    exitedRef.current = true;
    setName(NAME);
    setProgress(100);
    setExiting(true);
    onReveal();
    setTimeout(onDone, EXIT_MS);
  };

  useEffect(() => {
    const start = performance.now();
    let frame;

    const tick = (now) => {
      // rAF timestamps can precede the performance.now() taken at start, so clamp to [0, 1]
      const t = Math.min(1, Math.max(0, (now - start) / LOAD_MS));
      setProgress(Math.round(easeInOutSine(t) * 100));
      // Each letter locks in on a stagger; unresolved letters keep cycling glyphs.
      setName([...NAME].map((ch, i) => (t > 0.2 + i * 0.09 ? ch : randomGlyph())).join(''));

      if (t < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        setTimeout(startExit, 250);
      }
    };
    frame = requestAnimationFrame(tick);

    const skip = () => startExit();
    window.addEventListener('keydown', skip);
    document.body.style.overflow = 'hidden';

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', skip);
      document.body.style.overflow = '';
    };
  }, []);

  const status = ([...STATUS].reverse().find((s) => progress >= s.at) || STATUS[0]).text;

  return (
    <div
      className={`intro ${exiting ? 'intro--exit' : ''} ${progress >= 100 ? 'intro--loaded' : ''}`}
      onClick={startExit}
      role="presentation"
    >
      <div className="intro__panel intro__panel--top" />
      <div className="intro__panel intro__panel--bottom" />
      <IntroCore exiting={exiting} />
      <div className="intro__seam" />

      <div className="intro__content" aria-hidden="true">
        {/* Wrapper fades on exit; the children's entrance animations would otherwise pin their opacity */}
        <div className="intro__fade">
          {/* Empty anchor: marks where the 3D sphere sits, above the name */}
          <div className="intro__anchor" />
          <div className="intro__name">
            {name.slice(0, ACCENT_FROM)}
            <span className="logo-accent">{name.slice(ACCENT_FROM)}</span>
          </div>
          <div className="intro__tag">Visual AI product video discovery</div>

          <div className="intro__bar">
            <span style={{ transform: `scaleX(${progress / 100})` }} />
          </div>
          <div className="intro__meta">
            <span>{status}{progress < 100 ? '…' : ''}</span>
            <span>{String(progress).padStart(3, '0')}%</span>
          </div>
        </div>
      </div>

      <div className="intro__skip">Click to skip</div>
    </div>
  );
}
