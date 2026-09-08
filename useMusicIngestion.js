import { useState, useCallback, useRef, useEffect } from 'react';

// Production Render backend endpoint
export const DEFAULT_API_BASE_URL = 'https://resonate-app-t1t8.onrender.com';

export const useMusicIngestion = (apiBaseUrl = DEFAULT_API_BASE_URL) => {
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState('idle'); // 'idle' | 'searching' | 'downloading' | 'scanning' | 'ready' | 'failed'
    const [statusMessage, setStatusMessage] = useState('');
    const [error, setError] = useState(null);

    const pollIntervalRef = useRef(null);
    const pollCountRef = useRef(0);
    const MAX_POLLS = 60; // 60 * 3s = ~3 minutes timeout

    const stopPolling = useCallback(() => {
        if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
        }
        pollCountRef.current = 0;
    }, []);

    // Clean up on component unmount
    useEffect(() => {
        return () => {
            stopPolling();
        };
    }, [stopPolling]);

    const searchAndIngest = useCallback((query, onReady, onError) => {
        const trimmedQuery = query?.trim();
        if (!trimmedQuery) return;

        stopPolling();
        setLoading(true);
        setStatus('searching');
        setStatusMessage('Searching Navidrome cloud library...');
        setError(null);
        pollCountRef.current = 0;

        const checkStatus = async () => {
            pollCountRef.current += 1;

            if (pollCountRef.current > MAX_POLLS) {
                stopPolling();
                setLoading(false);
                setStatus('failed');
                const timeoutMsg = 'Operation timed out. Please check server logs and try again.';
                setStatusMessage(timeoutMsg);
                setError(timeoutMsg);
                if (onError) onError(timeoutMsg);
                return;
            }

            try {
                const endpoint = `${apiBaseUrl}/api/search-and-ingest?query=${encodeURIComponent(trimmedQuery)}`;
                const response = await fetch(endpoint, {
                    headers: { 'Accept': 'application/json' },
                });

                if (!response.ok) {
                    throw new Error(`Server returned status ${response.status}`);
                }

                const data = await response.json();

                if (data.status === 'ready' || data.status === 'success' || data.status === 'completed') {
                    stopPolling();
                    setLoading(false);
                    setStatus('ready');
                    setStatusMessage('Track is ready to play!');
                    if (onReady) onReady(data);
                } else if (data.status === 'downloading' || data.status === 'queued') {
                    setStatus('downloading');
                    setStatusMessage('Track missing from library. Downloading via spotDL...');
                } else if (data.status === 'scanning') {
                    setStatus('scanning');
                    setStatusMessage('Download finished! Indexing into Navidrome cloud...');
                } else if (data.status === 'failed') {
                    stopPolling();
                    setLoading(false);
                    setStatus('failed');
                    const failureMsg = data.error || 'Failed to ingest track.';
                    setStatusMessage(failureMsg);
                    setError(failureMsg);
                    if (onError) onError(failureMsg);
                }
            } catch (err) {
                console.warn('[useMusicIngestion] Polling error:', err.message);
                // Do not immediately abort on temporary network glitch if polling
                if (pollCountRef.current > 3) {
                    stopPolling();
                    setLoading(false);
                    setStatus('failed');
                    const errDetail = `Connection error: Unable to reach ${apiBaseUrl}. Ensure backend is running.`;
                    setStatusMessage(errDetail);
                    setError(errDetail);
                    if (onError) onError(errDetail);
                }
            }
        };

        // Perform initial search immediately
        checkStatus();

        // Continue polling every 3 seconds
        pollIntervalRef.current = setInterval(checkStatus, 3000);
    }, [apiBaseUrl, stopPolling]);

    return {
        searchAndIngest,
        stopPolling,
        loading,
        status,
        statusMessage,
        error
    };
};
