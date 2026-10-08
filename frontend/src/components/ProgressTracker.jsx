import React from 'react';
import { Activity, CheckCircle2, Clock, AlertTriangle, AlertCircle } from 'lucide-react';

export default function ProgressTracker({ steps, currentStep, currentDetail, isCompleted, error }) {
  if (!steps || steps.length === 0) return null;

  return (
    <div className="progress-tracker fade-in">
      <div className="progress-tracker__title">
        <Activity size={18} className="spinner" />
        <span>Discovery Pipeline Status</span>
        {isCompleted && (
          <span style={{ marginLeft: 'auto', color: 'var(--success)', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <CheckCircle2 size={14} /> Completed
          </span>
        )}
      </div>

      <div className="progress-tracker__steps">
        {steps.map((item, index) => {
          const isLatest = index === steps.length - 1 && !isCompleted;
          const isErr = item.step.includes('error') || item.step === 'failed';
          const isWarning = item.step === 'shortfall';

          return (
            <div
              key={index}
              className={`progress-step ${
                isLatest ? 'progress-step--active' : isErr ? 'progress-step--error' : 'progress-step--done'
              }`}
            >
              <div className="progress-step__icon">
                {isLatest ? (
                  <span className="spinner" />
                ) : isErr ? (
                  <AlertCircle size={16} color="var(--error)" />
                ) : isWarning ? (
                  <AlertTriangle size={16} color="var(--warning)" />
                ) : (
                  <CheckCircle2 size={16} color="var(--success)" />
                )}
              </div>
              <div className="progress-step__text">
                <strong>{formatStepName(item.step)}:</strong> {item.detail || item.step}
              </div>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </div>
          );
        })}
      </div>

      {error && (
        <div style={{ marginTop: '12px', padding: '8px 12px', background: 'rgba(239,68,68,0.1)', color: 'var(--error)', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem' }}>
          <strong>Error encountered:</strong> {error}
        </div>
      )}
    </div>
  );
}

function formatStepName(step) {
  switch (step) {
    case 'resolving':
      return 'Product Resolver';
    case 'analyzing':
      return 'Image Brain AI';
    case 'collecting':
      return 'Video Collection';
    case 'collected_instagram':
      return 'Instagram Reels';
    case 'collected_meta':
      return 'Meta Ad Library';
    case 'deduplicating':
      return 'De-duplication';
    case 'scoring':
      return 'Match Scoring';
    case 'saving':
      return 'Database Storage';
    case 'complete':
      return 'Pipeline Done';
    case 'shortfall':
      return 'Quota Notice';
    default:
      return step.replace(/_/g, ' ').toUpperCase();
  }
}
