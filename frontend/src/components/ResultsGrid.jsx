import React, { useEffect, useState } from 'react';
import VideoCard from './VideoCard';
import { AlertTriangle, VideoOff, RefreshCw } from 'lucide-react';

const MIN_COLUMN_PX = 290;

/**
 * Number of masonry columns that fit `el`, updated on resize. Takes the element itself
 * (from a callback ref) because the grid mounts only once results arrive.
 */
function useColumnCount(el) {
  const [count, setCount] = useState(4);

  useEffect(() => {
    if (!el) return undefined;
    const update = () => setCount(Math.max(1, Math.floor(el.clientWidth / MIN_COLUMN_PX)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  return count;
}

export default function ResultsGrid({ videos, isLoading, platform, counts, shortlist = [], onToggleShortlist }) {
  const [masonryEl, setMasonryEl] = useState(null);
  const columnCount = useColumnCount(masonryEl);

  if (isLoading && (!videos || videos.length === 0)) {
    return (
      <div className="results-grid">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="video-card skeleton" style={{ height: '320px' }} />
        ))}
      </div>
    );
  }

  if (!videos || videos.length === 0) {
    return (
      <div className="empty-state fade-in">
        <VideoOff className="empty-state__icon" size={48} />
        <h3 className="empty-state__title">No videos found</h3>
        <p className="empty-state__text">
          No matching videos discovered for this product category and platform yet. Try broadening your keyword or searching with a different product link.
        </p>
      </div>
    );
  }

  const igCount = counts.instagram || 0;
  const metaCount = counts.meta || 0;
  const showIgShortfall = (platform === 'all' || platform === 'instagram') && igCount < 20;
  const showMetaShortfall = (platform === 'all' || platform === 'meta') && metaCount < 20;

  const shortlistedIds = new Set(shortlist.map((v) => v.id || v.videoUrl || v.video_url));

  return (
    <div>
      {(showIgShortfall || showMetaShortfall) && (
        <div className="shortfall-banner fade-in">
          <AlertTriangle size={16} />
          <div>
            <strong>Notice on 20-video target: </strong>
            {showIgShortfall && `Instagram returned ${igCount}/20. `}
            {showMetaShortfall && `Meta Ad Library returned ${metaCount}/20. `}
            Broader category queries were tried; only real, unique videos are shown.
          </div>
        </div>
      )}

      {/* Round-robin into columns so the best scores stay along the top rows */}
      <div className="masonry" ref={setMasonryEl}>
        {Array.from({ length: columnCount }, (_, col) => (
          <div key={col} className="masonry__column">
            {videos.map((vid, index) => {
              if (index % columnCount !== col) return null;
              const vidId = vid.id || vid.videoUrl || vid.video_url;
              return (
                <VideoCard
                  key={vidId}
                  index={index}
                  video={vid}
                  isShortlisted={shortlistedIds.has(vidId)}
                  onToggleShortlist={onToggleShortlist}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
