import React, { useEffect, useRef, useState } from 'react';
import { Brain, Layers, Gauge, Play } from 'lucide-react';

const HEADLINE = ['Find Every Video', 'of Your Product'];

// Product photos from Unsplash (free to use under the Unsplash License), in ring order:
// the carousel rotates through them, so neighbours here are neighbours on screen.
const unsplash = (id) => `https://images.unsplash.com/photo-${id}?w=480&h=640&fit=crop&q=75`;
const SHOWCASE = [
  { label: 'Sneaker', src: unsplash('1606107557195-0e29a4b5b4aa') },
  { label: 'Backpack', src: unsplash('1553062407-98eeb64c6a62') },
  { label: 'Sunglasses', src: unsplash('1572635196237-14b3f281503f') },
  { label: 'Perfume', src: unsplash('1541643600914-78b084683601') },
  { label: 'Watch', src: unsplash('1523275335684-37898b6baf30') },
  { label: 'Running shoe', src: unsplash('1542291026-7eec264c27ff') },
  { label: 'Camera', src: unsplash('1526170375885-4d8ecf77b99f') },
  { label: 'T-shirt', src: unsplash('1521572163474-6864f9cf17ab') },
  { label: 'Headphones', src: unsplash('1505740420928-5e560c06d30e') },
];
const VISIBLE_RADIUS = 3; // cards at |offset| > 3 sit off-stage, hidden while they wrap around
const ROTATE_MS = 3000;

const FEATURES = [
  {
    icon: Brain,
    title: 'AI Image Brain',
    text: 'Gemini Vision reads the product photo and extracts type, colors, materials and brand to build precise searches.',
  },
  {
    icon: Layers,
    title: 'Reels + Meta Ads, One Search',
    text: 'Instagram Reels and Meta Ad Library video ads are collected in parallel and de-duplicated across searches.',
  },
  {
    icon: Gauge,
    title: 'Every Video Scored',
    text: 'Each thumbnail and caption is judged against your product, with a 0–100 match score and a one-line reason.',
  },
];

/**
 * Picks a few random letter positions to render in the pixel font, reshuffled on an interval
 * for a subtle "glitch" effect. Static when the user prefers reduced motion.
 */
function useGlitchPositions(lines, count = 5, intervalMs = 1800) {
  const pick = () => {
    const positions = [];
    lines.forEach((line, li) => {
      [...line].forEach((ch, ci) => {
        if (ch.trim()) positions.push(`${li}:${ci}`);
      });
    });
    const chosen = new Set();
    while (chosen.size < Math.min(count, positions.length)) {
      chosen.add(positions[Math.floor(Math.random() * positions.length)]);
    }
    return chosen;
  };

  const [glitched, setGlitched] = useState(pick);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) return undefined;
    const timer = setInterval(() => setGlitched(pick()), intervalMs);
    return () => clearInterval(timer);
  }, []);

  return glitched;
}

function GlitchHeadline() {
  const glitched = useGlitchPositions(HEADLINE);

  return (
    <h1 className="hero__title" aria-label={HEADLINE.join(' ')}>
      {HEADLINE.map((line, li) => (
        <span key={li} className="hero__title-line" aria-hidden="true">
          {[...line].map((ch, ci) => (
            <span key={ci} className={glitched.has(`${li}:${ci}`) ? 'hero__px' : undefined}>
              {ch}
            </span>
          ))}
        </span>
      ))}
    </h1>
  );
}

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Adds `is-visible` once the element scrolls into view (reveal-on-scroll). */
function useRevealOnScroll() {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window)) {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { threshold: 0.2 });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, visible];
}

function ShowcaseCard({ item, offset, onSelect }) {
  const [failed, setFailed] = useState(false);
  const isCenter = offset === 0;
  const isHidden = Math.abs(offset) > VISIBLE_RADIUS;

  return (
    <div
      className={[
        'showcase__card',
        isCenter ? 'showcase__card--center' : 'showcase__card--side',
        isHidden ? 'showcase__card--hidden' : '',
      ].join(' ')}
      style={{ '--offset': offset, '--abs': Math.abs(offset) }}
      onClick={isCenter || isHidden ? undefined : onSelect}
    >
      {!failed ? (
        <img src={item.src} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <div className="showcase__placeholder">
          <Play size={28} />
        </div>
      )}
      <span className="showcase__halftone" />
      <span className="showcase__beam" />
      <span className="showcase__score">AI vision · {item.label}</span>
    </div>
  );
}

function Showcase() {
  const [center, setCenter] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = SHOWCASE.length;

  useEffect(() => {
    if (paused || prefersReducedMotion()) return undefined;
    const timer = setInterval(() => setCenter((c) => (c + 1) % count), ROTATE_MS);
    return () => clearInterval(timer);
  }, [paused, count]);

  // Shortest signed distance around the ring, so each card slides to its neighbouring slot.
  const offsetOf = (i) => {
    let d = (((i - center) % count) + count) % count;
    if (d > count / 2) d -= count;
    return d;
  };

  return (
    <div
      className="showcase hero__reveal"
      aria-hidden="true"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="showcase__stage">
        {SHOWCASE.map((item, i) => (
          <ShowcaseCard key={item.label} item={item} offset={offsetOf(i)} onSelect={() => setCenter(i)} />
        ))}
      </div>
    </div>
  );
}

function Features() {
  const [ref, visible] = useRevealOnScroll();

  return (
    <div ref={ref} className={`features ${visible ? 'is-visible' : ''}`}>
      {FEATURES.map(({ icon: Icon, title, text }, i) => (
        <div key={title} className="feature" style={{ '--i': i }}>
          <Icon size={20} className="feature__icon" />
          <h3 className="feature__title">{title}</h3>
          <p className="feature__text">{text}</p>
        </div>
      ))}
    </div>
  );
}

export default function Hero({ children }) {
  return (
    <section className="hero">
      <GlitchHeadline />
      <p className="hero__subtitle hero__reveal">
        Type a product, paste its link or upload a photo. AI finds matching Instagram
        Reels and Meta video ads, and scores every one.
      </p>

      <div className="hero__search hero__reveal">{children}</div>

      <Showcase />
      <Features />
    </section>
  );
}
