// Dev: Vite on :5173 talks to the backend on :3001. Production: the backend serves the UI, so same origin.
const API_BASE = import.meta.env.VITE_API_BASE || (import.meta.env.DEV ? 'http://localhost:3001/api' : '/api');

/** Start a search from a product name/URL and/or an uploaded photo (data URL). */
export async function startSearch(query, image) {
  const response = await fetch(`${API_BASE}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, ...(image ? { image } : {}) }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Search request failed with status ${response.status}`);
  }

  return response.json();
}

export async function getSearchResults(searchId, params = {}) {
  const queryParams = new URLSearchParams();
  if (params.platform) queryParams.set('platform', params.platform);
  if (params.sortBy) queryParams.set('sortBy', params.sortBy);
  if (params.showPreviouslySeen !== undefined) {
    queryParams.set('showPreviouslySeen', String(params.showPreviouslySeen));
  }

  const url = `${API_BASE}/search/${searchId}${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
  const response = await fetch(url);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || 'Failed to fetch search results');
  }

  return response.json();
}

export async function getSearchHistory(limit = 20, offset = 0) {
  const response = await fetch(`${API_BASE}/history?limit=${limit}&offset=${offset}`);
  if (!response.ok) {
    throw new Error('Failed to fetch history');
  }
  return response.json();
}

export async function deleteSearchHistoryItem(id) {
  const response = await fetch(`${API_BASE}/history/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error('Failed to delete history item');
  }
  return response.json();
}

export function subscribeToProgress(searchId, onMessage, onError) {
  const eventSource = new EventSource(`${API_BASE}/search/${searchId}/progress`);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onMessage(data);
    } catch (err) {
      console.error('Failed to parse SSE data', err);
    }
  };

  eventSource.onerror = (err) => {
    if (onError) onError(err);
    eventSource.close();
  };

  return () => {
    eventSource.close();
  };
}
