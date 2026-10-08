import React, { useState } from 'react';
import { Brain } from 'lucide-react';
import { LogoMark } from './Logo';

const BUCKETS = 10;

/** True if the browser understands `name` as a CSS colour (e.g. "black", "navy"). */
const isCssColor = (name) => typeof CSS !== 'undefined' && CSS.supports('color', name);

/** Last word of a multi-word colour ("dark brown" -> "brown") as a best-effort swatch. */
function swatchFor(colorName) {
  const clean = colorName.toLowerCase().trim();
  if (isCssColor(clean.replace(/\s+/g, ''))) return clean.replace(/\s+/g, '');
  const last = clean.split(/\s+/).pop();
  return isCssColor(last) ? last : null;
}

function ScoreHistogram({ scores }) {
  const buckets = Array.from({ length: BUCKETS }, () => 0);
  scores.forEach((s) => {
    buckets[Math.min(BUCKETS - 1, Math.floor(s / (100 / BUCKETS)))] += 1;
  });
  const max = Math.max(1, ...buckets);

  return (
    <div className="scan__histogram" aria-label="Match score distribution">
      {scores.length === 0 && <span className="scan__empty">No scores yet</span>}
      <div className="scan__bars">
        {buckets.map((count, i) => (
          <span
            key={i}
            className={`scan__bar ${i >= 4 && count > 0 ? 'scan__bar--relevant' : ''}`}
            style={{ '--h': `${Math.max(4, (count / max) * 100)}%`, '--i': i }}
            title={`${i * 10}–${i * 10 + 9}: ${count} video${count === 1 ? '' : 's'}`}
          />
        ))}
      </div>
      <div className="scan__axis">
        <span>0</span>
        <span>40</span>
        <span>100</span>
      </div>
    </div>
  );
}

export default function ProductPanel({ search, videos = [] }) {
  const [imageFailed, setImageFailed] = useState(false);
  if (!search || (!search.product_title && !search.query)) return null;

  const title = search.product_title || search.query;
  const description = search.product_description;
  // Older rows may hold the string "null"
  const imageUrl = search.product_image_url && search.product_image_url !== 'null' ? search.product_image_url : null;
  const attributes = search.product_attributes || {};
  const { productType, brand, material, shape } = attributes;
  const colors = attributes.colors || [];
  const patterns = attributes.patterns || [];
  const keyFeatures = attributes.keyFeatures || [];

  const scores = videos.map((v) => Math.round(v.match_score || v.matchScore || 0));
  const relevant = scores.filter((s) => s >= 40).length;
  const best = scores.length ? Math.max(...scores) : 0;

  const facts = [
    ['Category', productType],
    ['Brand', brand],
    ['Material', material],
    ['Shape', shape],
    ['Pattern', patterns.join(', ')],
  ].filter(([, value]) => value);

  return (
    <section className="scan fade-in">
      <div className="scan__visual">
        {imageUrl && !imageFailed ? (
          <img src={imageUrl} alt={title} onError={() => setImageFailed(true)} />
        ) : (
          <LogoMark size={54} className="scan__visual-icon" />
        )}
        <span className="scan__line" aria-hidden="true" />
        <span className="scan__corners" aria-hidden="true" />
      </div>

      <div className="scan__info">
        <div className="scan__eyebrow">
          <Brain size={13} />
          AI Image Brain · Scan complete
          {search.input_type === 'url' && <span className="scan__source">from product URL</span>}
          {search.input_type === 'image' && <span className="scan__source">from uploaded photo</span>}
        </div>

        <h2 className="scan__title">{title}</h2>
        {description && <p className="scan__description" title={description}>{description}</p>}

        {facts.length > 0 && (
          <dl className="scan__facts">
            {facts.map(([label, value]) => (
              <div key={label} className="scan__fact">
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}

        {(colors.length > 0 || keyFeatures.length > 0) && (
          <div className="scan__chips">
            {colors.map((c) => {
              const swatch = swatchFor(c);
              return (
                <span key={`c-${c}`} className="scan__chip">
                  <i className="scan__swatch" style={{ background: swatch || 'transparent' }} />
                  {c}
                </span>
              );
            })}
            {keyFeatures.map((f) => (
              <span key={`f-${f}`} className="scan__chip scan__chip--feature">{f}</span>
            ))}
          </div>
        )}
      </div>

      <div className="scan__stats">
        <div className="scan__stat">
          <strong>{scores.length}</strong>
          <span>videos</span>
        </div>
        <div className="scan__stat scan__stat--accent">
          <strong>{relevant}</strong>
          <span title="Match score of 40 or more">relevant</span>
        </div>
        <div className="scan__stat">
          <strong>{best}<small>%</small></strong>
          <span>best match</span>
        </div>
        <ScoreHistogram scores={scores} />
      </div>
    </section>
  );
}
