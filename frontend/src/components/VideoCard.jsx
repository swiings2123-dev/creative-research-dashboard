import React, { useRef, useState } from 'react';
import { ExternalLink, Play, Bookmark, Sparkles, History } from 'lucide-react';

// Masonry rhythm: cards cycle through these media shapes so columns interlock.
const MEDIA_RATIOS = ['4 / 5', '1 / 1', '3 / 4', '4 / 5', '5 / 6', '3 / 4'];
const MAX_TILT_DEG = 7;

const PLATFORM = {
  instagram: { label: 'Instagram Reel', watch: 'Watch on Instagram' },
  meta: { label: 'Meta Ad', watch: 'Open in Ad Library' },
  tiktok: { label: 'TikTok', watch: 'Watch on TikTok' },
};

export default function VideoCard({ video, index = 0, isShortlisted, onToggleShortlist }) {
  const cardRef = useRef(null);
  const [imgError, setImgError] = useState(false);

  const score = Math.round(video.match_score || video.matchScore || 0);
  const isBelowThreshold = Boolean(video.is_below_threshold || video.isBelowThreshold || score < 40);
  const platform = PLATFORM[video.platform] ? video.platform : 'instagram';
  const url = video.video_url || video.videoUrl || '#';
  const caption = video.caption || 'No caption available';
  const author = video.author || 'Unknown creator';
  const thumbnail = video.thumbnail_url || video.thumbnailUrl;
  const rawReason = video.match_reason || video.matchReason || '';
  // Backend prefixes AI verdicts with "AI:"; fallback scores start with "Keyword match"
  const isAiReason = rawReason.startsWith('AI:');
  const reason = isAiReason ? rawReason.slice(3).trim() : rawReason;
  const scoreTier = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
  const seenBefore = Boolean(video.is_previously_seen || video.isPreviouslySeen);

  // 3D tilt + glare that follows the pointer
  const handlePointerMove = (e) => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    card.style.setProperty('--rx', `${(0.5 - py) * MAX_TILT_DEG}deg`);
    card.style.setProperty('--ry', `${(px - 0.5) * MAX_TILT_DEG}deg`);
    card.style.setProperty('--gx', `${px * 100}%`);
    card.style.setProperty('--gy', `${py * 100}%`);
  };

  const handlePointerLeave = () => {
    const card = cardRef.current;
    if (!card) return;
    card.style.setProperty('--rx', '0deg');
    card.style.setProperty('--ry', '0deg');
  };

  return (
    <article
      ref={cardRef}
      className={`vcard vcard--${platform} ${isBelowThreshold ? 'vcard--low' : ''} ${seenBefore ? 'vcard--seen' : ''}`}
      style={{
        animationDelay: `${Math.min(index, 16) * 55}ms`,
        '--kb-delay': `${-(index % 7) * 2.1}s`,
      }}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <span className="vcard__glare" aria-hidden="true" />

      <header className="vcard__top">
        <span className="vcard__pills">
          <span className="vcard__pill">{PLATFORM[platform].label}</span>
          {seenBefore && (
            <span className="vcard__seen" title="Returned by an earlier search">
              <History size={11} /> Seen before
            </span>
          )}
        </span>
        <span className={`vcard__score vcard__score--${scoreTier}`} title={`Match score ${score}/100`}>
          <span>{isBelowThreshold ? 'LOW' : 'MATCH'}</span>
          <strong>{score}</strong>
        </span>
      </header>

      <h3 className="vcard__title" title={author}>{author.startsWith('@') ? author : `@${author}`}</h3>
      <p className="vcard__caption" title={caption}>{caption}</p>

      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="vcard__media"
        style={{ aspectRatio: MEDIA_RATIOS[index % MEDIA_RATIOS.length] }}
        title="Open original video"
      >
        {!imgError && thumbnail ? (
          <img
            src={thumbnail}
            alt={caption.slice(0, 60)}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImgError(true)}
          />
        ) : (
          <span className="vcard__placeholder">
            <Play size={30} />
          </span>
        )}
        <span className="vcard__media-label">
          <Play size={12} fill="currentColor" />
          {PLATFORM[platform].watch}
        </span>
      </a>

      {reason && (
        <p className="vcard__verdict">
          <Sparkles size={12} className="vcard__verdict-icon" />
          <span>
            <strong>{isAiReason ? 'AI verdict' : 'Match'}:</strong> {reason}
          </span>
        </p>
      )}

      <footer className="vcard__actions">
        {onToggleShortlist && (
          <button
            type="button"
            className={`vcard__btn ${isShortlisted ? 'vcard__btn--active' : ''}`}
            onClick={() => onToggleShortlist(video)}
            title={isShortlisted ? 'Remove from shortlist' : 'Add to shortlist'}
          >
            <Bookmark size={13} fill={isShortlisted ? 'currentColor' : 'none'} />
            {isShortlisted ? 'Saved' : 'Save'}
          </button>
        )}
        <a href={url} target="_blank" rel="noopener noreferrer" className="vcard__btn vcard__btn--link">
          View <ExternalLink size={12} />
        </a>
      </footer>
    </article>
  );
}
