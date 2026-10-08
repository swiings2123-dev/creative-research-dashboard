import React from 'react';
import { History, Trash2, ArrowRight, Clock, Video } from 'lucide-react';

export default function SearchHistory({ history, onSelectSearch, onDeleteSearch, activeSearchId }) {
  if (!history || history.length === 0) return null;

  return (
    <section className="history-section fade-in">
      <div className="history-section__title">
        <History size={20} color="var(--accent-secondary)" />
        <span>Recent Discovery Searches</span>
      </div>

      <div className="history-list">
        {history.map((item) => {
          const isActive = item.id === activeSearchId;
          const totalFound = (item.instagram_count || 0) + (item.meta_count || 0) + (item.tiktok_count || 0);

          return (
            <div
              key={item.id}
              className="history-item"
              style={{
                borderColor: isActive ? 'var(--accent-primary)' : undefined,
                background: isActive ? 'rgba(196, 255, 46, 0.1)' : undefined,
              }}
              onClick={() => onSelectSearch(item.id)}
            >
              {item.product_image_url && item.product_image_url !== 'null' ? (
                <img
                  src={item.product_image_url}
                  alt={item.query}
                  className="history-item__image"
                  onError={(e) => {
                    e.target.style.display = 'none';
                  }}
                />
              ) : (
                <div className="history-item__image placeholder-img">
                  <Video size={18} color="var(--text-muted)" />
                </div>
              )}

              <div className="history-item__info">
                <div className="history-item__query" title={item.query}>
                  {item.product_title || item.query}
                </div>
                <div className="history-item__details">
                  <span>{new Date(item.created_at).toLocaleDateString()} {new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  <span> • {totalFound} videos</span>
                  <span> (IG: {item.instagram_count || 0}, Meta: {item.meta_count || 0})</span>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className={`history-item__status history-item__status--${item.status}`}>
                  {item.status}
                </span>

                <button
                  type="button"
                  className="btn btn--ghost"
                  style={{ padding: '6px', color: 'var(--text-muted)' }}
                  title="Remove from history"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteSearch(item.id);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
