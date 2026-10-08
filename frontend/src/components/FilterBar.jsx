import React from 'react';
import { ArrowUpDown, Eye, Download, Check } from 'lucide-react';

export default function FilterBar({
  activeTab,
  onTabChange,
  counts,
  sortBy,
  onSortChange,
  showPreviouslySeen,
  onTogglePreviouslySeen,
  shortlistCount = 0,
  onExportShortlist,
}) {
  const tabs = [
    { id: 'all', label: 'All Results', count: (counts.instagram || 0) + (counts.meta || 0) + (counts.tiktok || 0), target: 40 },
    { id: 'instagram', label: 'Instagram Reels', count: counts.instagram || 0, target: 20 },
    { id: 'meta', label: 'Meta Ad Library', count: counts.meta || 0, target: 20 },
  ];

  if (counts.tiktok !== undefined && counts.tiktok > 0) {
    tabs.push({ id: 'tiktok', label: 'TikTok (Bonus)', count: counts.tiktok || 0, target: 0 });
  }

  if (shortlistCount > 0) {
    tabs.push({ id: 'shortlist', label: '★ Shortlist', count: shortlistCount, target: 0 });
  }

  return (
    <div className="filter-bar fade-in">
      <div className="filter-bar__tabs">
        {tabs.map((tab) => {
          const meetsTarget = tab.target ? tab.count >= tab.target : true;
          return (
            <button
              key={tab.id}
              type="button"
              className={`filter-tab ${activeTab === tab.id ? 'filter-tab--active' : ''}`}
              onClick={() => onTabChange(tab.id)}
            >
              <i className={`filter-tab__dot filter-tab__dot--${tab.id}`} />
              <span>{tab.label}</span>
              <span
                className="filter-tab__count"
                title={tab.target ? `Target: at least ${tab.target}` : undefined}
                style={{
                  background: !meetsTarget ? 'rgba(245, 158, 11, 0.4)' : undefined,
                }}
              >
                {tab.count}
                {tab.target > 0 && (meetsTarget ? <Check size={10} style={{ marginLeft: 3 }} /> : ` / ${tab.target}`)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="filter-bar__controls">
        <label className="toggle-label" title="Toggle displaying results seen in prior searches">
          <input
            type="checkbox"
            className="toggle-checkbox"
            checked={showPreviouslySeen}
            onChange={(e) => onTogglePreviouslySeen(e.target.checked)}
          />
          <Eye size={14} />
          <span>Show previously seen</span>
        </label>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ArrowUpDown size={14} color="var(--text-muted)" />
          <select
            className="filter-select"
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value)}
          >
            <option value="score_desc">Highest Match Score</option>
            <option value="score_asc">Lowest Match Score</option>
            <option value="newest">Newest First</option>
          </select>
        </div>

        {onExportShortlist && (
          <button
            type="button"
            className="btn btn--ghost"
            style={{ padding: '7px 12px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '5px' }}
            onClick={onExportShortlist}
            title="Export discovered videos as CSV"
          >
            <Download size={14} />
            <span>Export CSV</span>
          </button>
        )}
      </div>
    </div>
  );
}
