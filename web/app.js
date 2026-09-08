/**
 * Resonate Music Player & Ingestion Engine
 * Frontend Client Controller
 */

// State Management
const state = {
    backendUrl: 'https://resonate-app-t1t8.onrender.com',
    serverOnline: false,
    isPlaying: false,
    currentTrack: {
        id: 'ambient-demo',
        title: 'Resonate Ambient Pulse',
        artist: 'Resonate Sound System',
        artwork: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=500&auto=format&fit=crop&q=80',
        streamUrl: 'https://cdn.freesound.org/previews/573/573381_5674468-lq.mp3' // High-quality ambient synth demo
    },
    pollInterval: null,
    pollCount: 0,
    maxPolls: 60,
    status: 'idle', // 'idle' | 'checking' | 'downloading' | 'scanning' | 'ready' | 'failed'
    visualizerInterval: null
};

// DOM Elements
const elements = {
    // Nav & Server Config
    serverStatusPill: document.getElementById('serverStatusPill'),
    serverStatusDot: document.getElementById('serverStatusDot'),
    serverStatusText: document.getElementById('serverStatusText'),
    configToggleBtn: document.getElementById('configToggleBtn'),
    configDrawer: document.getElementById('configDrawer'),
    configCloseBtn: document.getElementById('configCloseBtn'),
    backendUrlInput: document.getElementById('backendUrlInput'),
    testConnectionBtn: document.getElementById('testConnectionBtn'),
    connectionFeedback: document.getElementById('connectionFeedback'),

    // Search & Ingest
    searchForm: document.getElementById('searchForm'),
    searchInput: document.getElementById('searchInput'),
    searchSubmitBtn: document.getElementById('searchSubmitBtn'),
    clearInputBtn: document.getElementById('clearInputBtn'),
    suggestionChips: document.getElementById('suggestionChips'),

    // Status Banner
    statusPulseDot: document.getElementById('statusPulseDot'),
    statusStateBadge: document.getElementById('statusStateBadge'),
    statusTime: document.getElementById('statusTime'),
    statusDetail: document.getElementById('statusDetail'),

    // Player Elements
    vinylPlatter: document.getElementById('vinylPlatter'),
    albumArtImg: document.getElementById('albumArtImg'),
    trackTitle: document.getElementById('trackTitle'),
    trackArtist: document.getElementById('trackArtist'),
    equalizerBars: document.getElementById('equalizerBars'),
    eqBars: document.querySelectorAll('.eq-bar'),

    // Controls
    progressBarTrack: document.getElementById('progressBarTrack'),
    progressBarFill: document.getElementById('progressBarFill'),
    progressHandle: document.getElementById('progressHandle'),
    timeCurrent: document.getElementById('timeCurrent'),
    timeTotal: document.getElementById('timeTotal'),
    playPauseBtn: document.getElementById('playPauseBtn'),
    iconPlay: document.getElementById('iconPlay'),
    iconPause: document.getElementById('iconPause'),
    skipBackBtn: document.getElementById('skipBackBtn'),
    skipFwdBtn: document.getElementById('skipFwdBtn'),
    volumeBtn: document.getElementById('volumeBtn'),
    volumeSlider: document.getElementById('volumeSlider'),
    audioEngine: document.getElementById('audioEngine')
};

// ==========================================
// Initialization
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    initAudioEngine();
    bindEvents();
    checkBackendHealth();

    // Periodic health check every 15 seconds
    setInterval(checkBackendHealth, 15000);
});

// Setup Audio Engine
function initAudioEngine() {
    elements.audioEngine.src = state.currentTrack.streamUrl;
    elements.audioEngine.volume = parseFloat(elements.volumeSlider.value);

    // Audio event listeners
    elements.audioEngine.addEventListener('timeupdate', updateProgress);
    elements.audioEngine.addEventListener('loadedmetadata', () => {
        elements.timeTotal.textContent = formatTime(elements.audioEngine.duration);
    });
    elements.audioEngine.addEventListener('ended', () => {
        setPlayingState(false);
        elements.progressBarFill.style.width = '0%';
        elements.progressHandle.style.left = '0%';
        elements.timeCurrent.textContent = '0:00';
    });
    elements.audioEngine.addEventListener('error', (e) => {
        console.warn('Audio playback notice:', e);
    });
}

// Bind User Interactions
function bindEvents() {
    // Config Drawer
    elements.configToggleBtn.addEventListener('click', () => {
        elements.configDrawer.classList.toggle('open');
    });
    elements.configCloseBtn.addEventListener('click', () => {
        elements.configDrawer.classList.remove('open');
    });
    elements.serverStatusPill.addEventListener('click', () => {
        elements.configDrawer.classList.toggle('open');
    });
    elements.testConnectionBtn.addEventListener('click', () => {
        const url = elements.backendUrlInput.value.trim().replace(/\/+$/, '');
        if (url) {
            state.backendUrl = url;
            checkBackendHealth(true);
        }
    });

    // Search Input
    elements.searchInput.addEventListener('input', () => {
        if (elements.searchInput.value.length > 0) {
            elements.clearInputBtn.classList.remove('hidden');
        } else {
            elements.clearInputBtn.classList.add('hidden');
        }
    });

    elements.clearInputBtn.addEventListener('click', () => {
        elements.searchInput.value = '';
        elements.clearInputBtn.classList.add('hidden');
        elements.searchInput.focus();
    });

    // Form Submission
    elements.searchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const query = elements.searchInput.value.trim();
        if (query) {
            startSearchAndIngest(query);
        }
    });

    // Suggestion Chips
    elements.suggestionChips.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (chip && chip.dataset.query) {
            elements.searchInput.value = chip.dataset.query;
            elements.clearInputBtn.classList.remove('hidden');
            startSearchAndIngest(chip.dataset.query);
        }
    });

    // Playback Controls
    elements.playPauseBtn.addEventListener('click', togglePlayPause);
    elements.skipBackBtn.addEventListener('click', () => skipSeconds(-10));
    elements.skipFwdBtn.addEventListener('click', () => skipSeconds(10));

    // Seek Bar
    elements.progressBarTrack.addEventListener('click', handleSeek);

    // Volume Slider
    elements.volumeSlider.addEventListener('input', (e) => {
        const vol = parseFloat(e.target.value);
        elements.audioEngine.volume = vol;
    });

    elements.volumeBtn.addEventListener('click', () => {
        if (elements.audioEngine.volume > 0) {
            elements.audioEngine.dataset.lastVol = elements.audioEngine.volume;
            elements.audioEngine.volume = 0;
            elements.volumeSlider.value = 0;
        } else {
            const restored = parseFloat(elements.audioEngine.dataset.lastVol || 0.85);
            elements.audioEngine.volume = restored;
            elements.volumeSlider.value = restored;
        }
    });

    // Keyboard Shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return; // Do not intercept typing
        if (e.code === 'Space') {
            e.preventDefault();
            togglePlayPause();
        } else if (e.code === 'ArrowRight') {
            skipSeconds(5);
        } else if (e.code === 'ArrowLeft') {
            skipSeconds(-5);
        }
    });
}

// ==========================================
// Backend Health Check
// ==========================================
async function checkBackendHealth(manualTrigger = false) {
    elements.serverStatusDot.className = 'status-indicator-dot';
    elements.serverStatusText.textContent = 'Backend: Checking...';

    if (manualTrigger) {
        elements.connectionFeedback.className = 'connection-feedback';
        elements.connectionFeedback.textContent = 'Contacting server...';
    }

    try {
        const res = await fetch(`${state.backendUrl}/health`, { method: 'GET', headers: { 'Accept': 'application/json' } });
        if (res.ok) {
            const data = await res.json();
            state.serverOnline = true;
            elements.serverStatusDot.classList.add('online');
            elements.serverStatusText.textContent = 'Backend: Online (Render Cloud)';

            if (manualTrigger) {
                elements.connectionFeedback.className = 'connection-feedback success';
                elements.connectionFeedback.textContent = `Connected! ${data.service || 'Ready'}`;
            }
        } else {
            throw new Error(`HTTP ${res.status}`);
        }
    } catch (err) {
        state.serverOnline = false;
        elements.serverStatusDot.classList.add('offline');
        elements.serverStatusText.textContent = 'Backend: Offline';

        if (manualTrigger) {
            elements.connectionFeedback.className = 'connection-feedback error';
            elements.connectionFeedback.textContent = `Unable to link with ${state.backendUrl}. Ensure main.py is running.`;
        }
    }
}

// ==========================================
// Ingestion Pipeline
// ==========================================
function startSearchAndIngest(query) {
    stopPolling();
    state.pollCount = 0;

    setBannerStatus('searching', 'Searching Library', `Querying Navidrome cloud index for "${query}"...`);
    setSearchLoading(true);

    const checkJobStatus = async () => {
        state.pollCount += 1;

        if (state.pollCount > state.maxPolls) {
            stopPolling();
            setSearchLoading(false);
            setBannerStatus('failed', 'Ingestion Timeout', 'Server took too long to complete spotDL processing. Please retry.');
            return;
        }

        try {
            const endpoint = `${state.backendUrl}/api/search-and-ingest?query=${encodeURIComponent(query)}`;
            const response = await fetch(endpoint, { headers: { 'Accept': 'application/json' } });

            if (!response.ok) {
                throw new Error(`Server returned HTTP ${response.status}`);
            }

            const data = await response.json();

            if (data.status === 'ready' || data.status === 'success') {
                stopPolling();
                setSearchLoading(false);
                setBannerStatus('ready', 'Track Ready', `"${data.title || data.song?.title || query}" uploaded to Supabase & ready!`);
                loadReadyTrack(data, query);
            } else if (data.status === 'downloading' || data.status === 'queued') {
                setBannerStatus('downloading', 'Downloading Track', 'Track not in cloud library. Invoking spotDL backend worker...');
            } else if (data.status === 'scanning') {
                setBannerStatus('scanning', 'Syncing Navidrome', 'Audio downloaded! Triggering Navidrome library scan...');
            } else if (data.status === 'failed') {
                stopPolling();
                setSearchLoading(false);
                setBannerStatus('failed', 'Ingestion Failed', data.error || 'The ingestion worker encountered an issue.');
            }
        } catch (err) {
            console.warn('Ingestion check error:', err);
            if (state.pollCount > 3) {
                stopPolling();
                setSearchLoading(false);
                setBannerStatus('failed', 'Connection Failed', `Could not reach ${state.backendUrl}. Verify backend terminal.`);
            }
        }
    };

    // Immediate first check
    checkJobStatus();
    state.pollInterval = setInterval(checkJobStatus, 2500);
}

function stopPolling() {
    if (state.pollInterval) {
        clearInterval(state.pollInterval);
        state.pollInterval = null;
    }
}

function loadReadyTrack(data, originalQuery) {
    const song = data.song || {};
    const streamUrl = data.stream_url || `${state.backendUrl}/api/stream/${song.id}`;
    const coverUrl = song.coverArt
        ? `${state.backendUrl}/api/cover/${song.coverArt}`
        : 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=500&auto=format&fit=crop&q=80';

    state.currentTrack = {
        id: song.id || `track-${Date.now()}`,
        title: song.title || originalQuery,
        artist: song.artist || 'Navidrome Artist',
        artwork: coverUrl,
        streamUrl: streamUrl
    };

    // Update UI elements
    elements.trackTitle.textContent = state.currentTrack.title;
    elements.trackArtist.textContent = state.currentTrack.artist;
    elements.albumArtImg.src = state.currentTrack.artwork;

    // Load stream into audio element
    elements.audioEngine.src = state.currentTrack.streamUrl;
    elements.audioEngine.load();

    // Auto-play
    elements.audioEngine.play()
        .then(() => setPlayingState(true))
        .catch(err => console.log('Autoplay handled:', err));
}

// ==========================================
// Playback Control Logic
// ==========================================
function togglePlayPause() {
    if (state.isPlaying) {
        elements.audioEngine.pause();
        setPlayingState(false);
    } else {
        elements.audioEngine.play()
            .then(() => setPlayingState(true))
            .catch(err => {
                console.warn('Play request error:', err);
                setPlayingState(false);
            });
    }
}

function setPlayingState(isPlaying) {
    state.isPlaying = isPlaying;

    if (isPlaying) {
        elements.vinylPlatter.classList.add('playing');
        elements.equalizerBars.classList.add('active');
        elements.iconPlay.classList.add('hidden');
        elements.iconPause.classList.remove('hidden');
        startEqualizerAnimation();
    } else {
        elements.vinylPlatter.classList.remove('playing');
        elements.equalizerBars.classList.remove('active');
        elements.iconPlay.classList.remove('hidden');
        elements.iconPause.classList.add('hidden');
        stopEqualizerAnimation();
    }
}

function skipSeconds(seconds) {
    if (!elements.audioEngine.duration) return;
    const target = Math.max(0, Math.min(elements.audioEngine.duration, elements.audioEngine.currentTime + seconds));
    elements.audioEngine.currentTime = target;
}

function handleSeek(e) {
    if (!elements.audioEngine.duration) return;
    const rect = elements.progressBarTrack.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    elements.audioEngine.currentTime = ratio * elements.audioEngine.duration;
}

function updateProgress() {
    const current = elements.audioEngine.currentTime;
    const total = elements.audioEngine.duration || 0;

    elements.timeCurrent.textContent = formatTime(current);
    if (total > 0) {
        const percent = (current / total) * 100;
        elements.progressBarFill.style.width = `${percent}%`;
        elements.progressHandle.style.left = `${percent}%`;
    }
}

function formatTime(secs) {
    if (!secs || isNaN(secs) || secs < 0) return '0:00';
    const mins = Math.floor(secs / 60);
    const remSecs = Math.floor(secs % 60);
    return `${mins}:${remSecs < 10 ? '0' : ''}${remSecs}`;
}

// ==========================================
// Dynamic Spectrum Equalizer Animation
// ==========================================
function startEqualizerAnimation() {
    if (state.visualizerInterval) return;

    state.visualizerInterval = setInterval(() => {
        elements.eqBars.forEach((bar, index) => {
            // Generate rhythmic wave effect
            const time = Date.now() / 180;
            const wave = Math.sin(time + index * 0.45) * 0.4 + 0.5;
            const randomJitter = (Math.random() * 0.3) - 0.15;
            const heightPercent = Math.max(15, Math.min(95, Math.round((wave + randomJitter) * 100)));
            bar.style.height = `${heightPercent}%`;
        });
    }, 90);
}

function stopEqualizerAnimation() {
    if (state.visualizerInterval) {
        clearInterval(state.visualizerInterval);
        state.visualizerInterval = null;
    }
    elements.eqBars.forEach((bar) => {
        bar.style.height = '15%';
    });
}

// ==========================================
// Status & UI Helpers
// ==========================================
function setBannerStatus(type, title, detail) {
    elements.statusPulseDot.className = 'status-pulse-dot';
    elements.statusPulseDot.classList.add(type);

    elements.statusStateBadge.textContent = title.toUpperCase();
    elements.statusDetail.textContent = detail;
    elements.statusTime.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function setSearchLoading(isLoading) {
    const btnText = elements.searchSubmitBtn.querySelector('.btn-text');
    const btnLoader = elements.searchSubmitBtn.querySelector('.btn-loader');

    if (isLoading) {
        btnText.classList.add('hidden');
        btnLoader.classList.remove('hidden');
        elements.searchSubmitBtn.disabled = true;
    } else {
        btnText.classList.remove('hidden');
        btnLoader.classList.add('hidden');
        elements.searchSubmitBtn.disabled = false;
    }
}
