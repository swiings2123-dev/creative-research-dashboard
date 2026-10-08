import React, { useState, useEffect, useRef } from 'react';
import {
  startSearch,
  getSearchResults,
  getSearchHistory,
  deleteSearchHistoryItem,
  subscribeToProgress,
} from './services/api';
import SearchBar from './components/SearchBar';
import ProductPanel from './components/ProductPanel';
import ProgressTracker from './components/ProgressTracker';
import FilterBar from './components/FilterBar';
import ResultsGrid from './components/ResultsGrid';
import SearchHistory from './components/SearchHistory';
import Hero from './components/Hero';
import Intro from './components/Intro';
import { LogoMark, LogoWordmark } from './components/Logo';
import { AlertCircle } from 'lucide-react';

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function App() {
  // playing -> revealing (intro splits open) -> done (page mounts and runs its own entrance)
  const [introState, setIntroState] = useState(() => (prefersReducedMotion() ? 'done' : 'playing'));
  const [currentSearchId, setCurrentSearchId] = useState(null);
  const [searchData, setSearchData] = useState(null);
  const [videos, setVideos] = useState([]);
  const [counts, setCounts] = useState({ instagram: 0, meta: 0, tiktok: 0 });
  const [history, setHistory] = useState([]);
  const [shortlist, setShortlist] = useState([]);

  // Filters & Sorting
  const [activeTab, setActiveTab] = useState('all');
  const [sortBy, setSortBy] = useState('score_desc');
  const [showPreviouslySeen, setShowPreviouslySeen] = useState(false);

  // Pipeline & Progress States
  const [isLoading, setIsLoading] = useState(false);
  const [progressSteps, setProgressSteps] = useState([]);
  const [currentStep, setCurrentStep] = useState('');
  const [currentDetail, setCurrentDetail] = useState('');
  const [isCompleted, setIsCompleted] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  const unsubscribeRef = useRef(null);

  // Load search history on initial mount
  useEffect(() => {
    loadHistory();
  }, []);

  const loadHistory = async () => {
    try {
      const data = await getSearchHistory(15);
      if (data && data.searches) {
        setHistory(data.searches);
      }
    } catch (err) {
      console.warn('Could not load search history', err);
    }
  };

  // Re-fetch videos when filter or sort changes
  useEffect(() => {
    if (currentSearchId && !isLoading) {
      if (activeTab === 'shortlist') return;
      fetchResults(currentSearchId);
    }
  }, [activeTab, sortBy, showPreviouslySeen]);

  const fetchResults = async (searchId) => {
    try {
      const res = await getSearchResults(searchId, {
        platform: activeTab === 'all' || activeTab === 'shortlist' ? undefined : activeTab,
        sortBy,
        showPreviouslySeen,
      });

      setSearchData(res.search);
      setVideos(res.videos || []);
      setCounts(res.counts || { instagram: 0, meta: 0, tiktok: 0 });
    } catch (err) {
      console.error('Failed to load search results', err);
    }
  };

  const handleStartSearch = async (query, image) => {
    setIsLoading(true);
    setErrorMsg(null);
    setIsCompleted(false);
    setProgressSteps([]);
    setVideos([]);
    setSearchData(null);
    setCounts({ instagram: 0, meta: 0, tiktok: 0 });

    if (unsubscribeRef.current) {
      unsubscribeRef.current();
    }

    try {
      const { searchId } = await startSearch(query, image);
      setCurrentSearchId(searchId);

      // Listen for SSE real-time pipeline events
      unsubscribeRef.current = subscribeToProgress(
        searchId,
        (event) => {
          if (event.type === 'progress') {
            setProgressSteps((prev) => [...prev, event]);
            setCurrentStep(event.step);
            setCurrentDetail(event.detail);
          } else if (event.type === 'complete') {
            setIsCompleted(true);
            setIsLoading(false);
            // A failed pipeline still ends with "complete", carrying the reason
            if (event.error) setErrorMsg(event.error);
            fetchResults(searchId);
            loadHistory();
          } else if (event.type === 'error') {
            setIsLoading(false);
            setErrorMsg(event.error || 'Pipeline search failed');
            fetchResults(searchId);
          }
        },
        (err) => {
          console.warn('SSE disconnected or complete', err);
        }
      );
    } catch (err) {
      setIsLoading(false);
      // fetch() rejects with a TypeError when the backend can't be reached at all
      const unreachable = err instanceof TypeError;
      setErrorMsg(
        unreachable
          ? "Can't reach the Reelscope server. Make sure the backend is running (npm run dev in /backend) and try again."
          : err.message || 'Failed to initiate search'
      );
    }
  };

  const handleSelectHistory = async (searchId) => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
    }
    setCurrentSearchId(searchId);
    setIsLoading(false);
    setIsCompleted(true);
    setProgressSteps([]);
    setErrorMsg(null);
    await fetchResults(searchId);
  };

  const handleDeleteHistory = async (id) => {
    try {
      await deleteSearchHistoryItem(id);
      setHistory((prev) => prev.filter((item) => item.id !== id));
      if (currentSearchId === id) {
        setVideos([]);
        setSearchData(null);
        setCurrentSearchId(null);
      }
    } catch (err) {
      console.error('Failed to delete history item', err);
    }
  };

  const handleToggleShortlist = (video) => {
    const vidId = video.id || video.videoUrl || video.video_url;
    setShortlist((prev) => {
      const exists = prev.some((v) => (v.id || v.videoUrl || v.video_url) === vidId);
      if (exists) {
        return prev.filter((v) => (v.id || v.videoUrl || v.video_url) !== vidId);
      }
      return [...prev, video];
    });
  };

  const handleExportCsv = () => {
    const listToExport = activeTab === 'shortlist' ? shortlist : videos;
    if (listToExport.length === 0) return;

    const headers = ['Platform', 'Match Score', 'Author', 'Video URL', 'Match Reason', 'Caption'];
    const rows = listToExport.map((v) => [
      v.platform,
      `${Math.round(v.match_score || v.matchScore || 0)}%`,
      `"${(v.author || '').replace(/"/g, '""')}"`,
      `"${v.video_url || v.videoUrl || ''}"`,
      `"${(v.match_reason || v.matchReason || '').replace(/"/g, '""')}"`,
      `"${(v.caption || '').replace(/"/g, '""')}"`,
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `discovery_videos_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleGoHome = () => {
    if (isLoading) return;
    if (unsubscribeRef.current) unsubscribeRef.current();
    setCurrentSearchId(null);
    setSearchData(null);
    setVideos([]);
    setProgressSteps([]);
    setErrorMsg(null);
    setActiveTab('all');
  };

  const displayedVideos = activeTab === 'shortlist' ? shortlist : videos;

  return (
    <>
      {introState !== 'done' && (
        <Intro onReveal={() => setIntroState('revealing')} onDone={() => setIntroState('done')} />
      )}
      {introState === 'done' && (
        <div className="app">
          {/* Header */}
          <header className="header">
            <div className="header__brand" onClick={handleGoHome} title="Back to start">
              <div className="header__logo">
                <LogoMark size={26} style={{ color: '#050505' }} />
              </div>
              <div>
                <LogoWordmark className="header__title" />
                <p className="header__subtitle">Visual AI product video discovery</p>
              </div>
            </div>
          </header>

          {/* Landing hero until a search is opened; compact search bar afterwards */}
          {!currentSearchId && !isLoading ? (
            <Hero>
              <SearchBar onSearch={handleStartSearch} isLoading={isLoading} />
            </Hero>
          ) : (
            <SearchBar onSearch={handleStartSearch} isLoading={isLoading} compact />
          )}

          {/* Error Banner */}
          {errorMsg && (
            <div className="error-banner fade-in">
              <AlertCircle className="error-banner__icon" size={20} />
              <div className="error-banner__text">
                <strong>Pipeline Notification: </strong>
                {errorMsg}
              </div>
              <button
                type="button"
                className="error-banner__dismiss"
                onClick={() => setErrorMsg(null)}
              >
                ×
              </button>
            </div>
          )}

          {/* Real-time Progress Tracker */}
          {progressSteps.length > 0 && (
            <ProgressTracker
              steps={progressSteps}
              currentStep={currentStep}
              currentDetail={currentDetail}
              isCompleted={isCompleted}
              error={errorMsg}
            />
          )}

          {/* Product Information & Brain Attributes */}
          <ProductPanel key={searchData?.id} search={searchData} videos={displayedVideos} />

          {/* Results Section */}
          {(videos.length > 0 || isLoading || currentSearchId) && (
            <>
              <FilterBar
                activeTab={activeTab}
                onTabChange={setActiveTab}
                counts={counts}
                sortBy={sortBy}
                onSortChange={setSortBy}
                showPreviouslySeen={showPreviouslySeen}
                onTogglePreviouslySeen={setShowPreviouslySeen}
                shortlistCount={shortlist.length}
                onExportShortlist={displayedVideos.length > 0 ? handleExportCsv : null}
              />

              <ResultsGrid
                videos={displayedVideos}
                isLoading={isLoading}
                platform={activeTab}
                counts={counts}
                shortlist={shortlist}
                onToggleShortlist={handleToggleShortlist}
              />
            </>
          )}

          {/* Recent History */}
          <SearchHistory
            history={history}
            onSelectSearch={handleSelectHistory}
            onDeleteSearch={handleDeleteHistory}
            activeSearchId={currentSearchId}
          />
        </div>
      )}
    </>
  );
}
