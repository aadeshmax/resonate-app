import React, { useState, useEffect, useRef } from 'react';
import {
    StyleSheet,
    Text,
    View,
    TextInput,
    TouchableOpacity,
    ActivityIndicator,
    SafeAreaView,
    StatusBar,
    Image,
    ScrollView,
    Animated,
    Easing,
    Keyboard,
} from 'react-native';
import TrackPlayer, {
    Capability,
    State,
    usePlaybackState,
    useProgress,
    AppKilledPlaybackBehavior,
} from 'react-native-track-player';

// Production Render backend endpoint
const DEFAULT_BACKEND_URL = 'https://resonate-app-t1t8.onrender.com';

const QUICK_SEARCH_CHIPS = [
    'The Weeknd - Blinding Lights',
    'Daft Punk - Get Lucky',
    'Queen - Bohemian Rhapsody',
    'Dua Lipa - Levitating',
];

export default function App() {
    const [query, setQuery] = useState('');
    const [serverUrl, setServerUrl] = useState(DEFAULT_BACKEND_URL);
    const [showConfig, setShowConfig] = useState(false);
    const [serverHealth, setServerHealth] = useState(null); // 'checking' | 'online' | 'offline'

    // Status: 'idle' | 'checking' | 'downloading' | 'scanning' | 'ready' | 'failed'
    const [status, setStatus] = useState('idle');
    const [statusMessage, setStatusMessage] = useState('Search a song or paste a Spotify link');
    const [currentTrack, setCurrentTrack] = useState(null);
    const [progressBarWidth, setProgressBarWidth] = useState(250);

    const playbackState = usePlaybackState();
    const progress = useProgress(250); // High-frequency update for smooth progress

    // Polling references to prevent memory leaks
    const pollIntervalRef = useRef(null);
    const pollCountRef = useRef(0);
    const MAX_POLLS = 60; // 60 * 3s = 3 minutes

    // --- Animations ---
    const vinylSpinValue = useRef(new Animated.Value(0)).current;
    const vinylSpinAnim = useRef(null);
    const pulseGlow = useRef(new Animated.Value(1)).current;

    // Equalizer spectrum bars
    const eqBar1 = useRef(new Animated.Value(0.3)).current;
    const eqBar2 = useRef(new Animated.Value(0.7)).current;
    const eqBar3 = useRef(new Animated.Value(0.4)).current;
    const eqBar4 = useRef(new Animated.Value(0.9)).current;

    // Determine playing state across different RNTP versions
    const isPlaying =
        playbackState?.state === State.Playing ||
        playbackState === State.Playing ||
        playbackState?.state === 'playing' ||
        playbackState === 'playing';

    // 1. Initialize TrackPlayer
    useEffect(() => {
        let isMounted = true;
        async function setup() {
            try {
                await TrackPlayer.setupPlayer();
                await TrackPlayer.updateOptions({
                    android: {
                        appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
                    },
                    capabilities: [
                        Capability.Play,
                        Capability.Pause,
                        Capability.SeekTo,
                        Capability.SkipToNext,
                        Capability.SkipToPrevious,
                        Capability.Stop,
                    ],
                    compactCapabilities: [Capability.Play, Capability.Pause, Capability.Stop],
                });
            } catch {
                // Already initialized
            }
        }
        setup();

        return () => {
            isMounted = false;
            stopPolling();
        };
    }, []);

    // 2. Vinyl Rotation & Pulse Glow Animations
    useEffect(() => {
        if (isPlaying) {
            vinylSpinAnim.current = Animated.loop(
                Animated.timing(vinylSpinValue, {
                    toValue: 1,
                    duration: 9000,
                    easing: Easing.linear,
                    useNativeDriver: true,
                })
            );
            vinylSpinAnim.current.start();

            // Pulsing glow aura
            Animated.loop(
                Animated.sequence([
                    Animated.timing(pulseGlow, { toValue: 1.08, duration: 1200, useNativeDriver: true }),
                    Animated.timing(pulseGlow, { toValue: 1, duration: 1200, useNativeDriver: true }),
                ])
            ).start();
        } else {
            if (vinylSpinAnim.current) {
                vinylSpinAnim.current.stop();
            }
        }
    }, [isPlaying]);

    // 3. Spectrum Visualizer Animation
    useEffect(() => {
        if (isPlaying) {
            const createBarLoop = (anim, min, max, duration) =>
                Animated.loop(
                    Animated.sequence([
                        Animated.timing(anim, { toValue: max, duration, easing: Easing.ease, useNativeDriver: true }),
                        Animated.timing(anim, { toValue: min, duration, easing: Easing.ease, useNativeDriver: true }),
                    ])
                );

            const loop1 = createBarLoop(eqBar1, 0.2, 1.0, 380);
            const loop2 = createBarLoop(eqBar2, 0.3, 0.9, 520);
            const loop3 = createBarLoop(eqBar3, 0.1, 1.0, 420);
            const loop4 = createBarLoop(eqBar4, 0.4, 0.85, 490);

            loop1.start();
            loop2.start();
            loop3.start();
            loop4.start();

            return () => {
                loop1.stop();
                loop2.stop();
                loop3.stop();
                loop4.stop();
            };
        } else {
            eqBar1.setValue(0.2);
            eqBar2.setValue(0.2);
            eqBar3.setValue(0.2);
            eqBar4.setValue(0.2);
        }
    }, [isPlaying]);

    const spinInterpolation = vinylSpinValue.interpolate({
        inputRange: [0, 1],
        outputRange: ['0deg', '360deg'],
    });

    const stopPolling = () => {
        if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
        }
        pollCountRef.current = 0;
    };

    // 4. Test Backend Connectivity
    const handleTestConnection = async () => {
        setServerHealth('checking');
        try {
            const res = await fetch(`${serverUrl}/health`, { method: 'GET' });
            if (res.ok) {
                setServerHealth('online');
            } else {
                setServerHealth('offline');
            }
        } catch {
            setServerHealth('offline');
        }
    };

    // 5. Ingestion Engine using Native Fetch (No extra axios dependency needed)
    const handleSearchAndIngest = (searchQuery = query) => {
        const cleanQuery = searchQuery.trim();
        if (!cleanQuery) return;

        Keyboard.dismiss();
        stopPolling();

        setStatus('checking');
        setStatusMessage('Searching Navidrome cloud library...');

        const pollBackend = async () => {
            pollCountRef.current += 1;

            if (pollCountRef.current > MAX_POLLS) {
                stopPolling();
                setStatus('failed');
                setStatusMessage('Ingestion timed out. Check backend logs and try again.');
                return;
            }

            try {
                const endpoint = `${serverUrl}/api/search-and-ingest?query=${encodeURIComponent(cleanQuery)}`;
                const response = await fetch(endpoint, {
                    headers: { Accept: 'application/json' },
                });

                if (!response.ok) {
                    throw new Error(`HTTP status ${response.status}`);
                }

                const data = await response.json();

                if (data.status === 'ready' || data.status === 'success' || data.status === 'completed') {
                    stopPolling();
                    handleTrackReady(data);
                } else if (data.status === 'downloading' || data.status === 'queued') {
                    setStatus('downloading');
                    setStatusMessage('Downloading via spotDL & converting metadata...');
                } else if (data.status === 'scanning') {
                    setStatus('scanning');
                    setStatusMessage('Download finished! Syncing Navidrome library...');
                } else if (data.status === 'failed') {
                    stopPolling();
                    setStatus('failed');
                    setStatusMessage(data.error || 'Track ingestion failed on server.');
                }
            } catch (err) {
                if (pollCountRef.current > 3) {
                    stopPolling();
                    setStatus('failed');
                    setStatusMessage(`Unable to connect to ${serverUrl}. Ensure backend is running.`);
                }
            }
        };

        // Run immediate initial check
        pollBackend();
        // Setup recurring poll
        pollIntervalRef.current = setInterval(pollBackend, 3000);
    };

    const handleTrackReady = async (data) => {
        setStatus('ready');
        setStatusMessage('Track ready! Streaming from Navidrome.');
        setCurrentTrack(data.song);

        // Subsonic returns cover art ID (e.g. 'al-12'); resolve through middleware proxy
        let coverUrl = 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600';
        if (data.song?.coverArt) {
            coverUrl = `${serverUrl}/api/cover/${data.song.coverArt}`;
        }

        try {
            await TrackPlayer.reset();
            await TrackPlayer.add({
                id: data.song?.id || `track-${Date.now()}`,
                url: data.stream_url,
                title: data.song?.title || query,
                artist: data.song?.artist || 'Unknown Artist',
                artwork: coverUrl,
            });
            await TrackPlayer.play();
        } catch (err) {
            console.error('Track playback initiation failed:', err);
        }
    };

    const togglePlayback = async () => {
        if (isPlaying) {
            await TrackPlayer.pause();
        } else {
            await TrackPlayer.play();
        }
    };

    const handleSeek = async (e) => {
        if (!progress.duration || progress.duration <= 0) return;
        const clickX = e.nativeEvent.locationX;
        const ratio = Math.max(0, Math.min(1, clickX / progressBarWidth));
        await TrackPlayer.seekTo(ratio * progress.duration);
    };

    const handleSkip = async (seconds) => {
        const target = Math.max(0, Math.min(progress.duration, progress.position + seconds));
        await TrackPlayer.seekTo(target);
    };

    const formatTime = (secs) => {
        if (!secs || isNaN(secs) || secs < 0) return '0:00';
        const mins = Math.floor(secs / 60);
        const remSecs = Math.floor(secs % 60);
        return `${mins}:${remSecs < 10 ? '0' : ''}${remSecs}`;
    };

    const isBusy = status === 'checking' || status === 'downloading' || status === 'scanning';

    return (
        <SafeAreaView style={styles.container}>
            <StatusBar barStyle="light-content" backgroundColor="#07080a" />
            <ScrollView
                contentContainerStyle={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
            >
                {/* Header with Server Settings Toggle */}
                <View style={styles.header}>
                    <View>
                        <View style={styles.badgeRow}>
                            <Text style={styles.badgeBrand}>RESONATE</Text>
                            <Text style={styles.badgeDot}>•</Text>
                            <Text style={styles.badgeFeature}>MUSIC ENGINE</Text>
                        </View>
                        <Text style={styles.headerTitle}>Resonate</Text>
                    </View>

                    <TouchableOpacity
                        style={[styles.settingsButton, showConfig && styles.settingsButtonActive]}
                        onPress={() => setShowConfig(!showConfig)}
                    >
                        <Text style={styles.settingsIcon}>⚙</Text>
                    </TouchableOpacity>
                </View>

                {/* Collapsible Backend Server Config */}
                {showConfig && (
                    <View style={styles.configCard}>
                        <Text style={styles.configTitle}>Backend Server Configuration</Text>
                        <View style={styles.configInputRow}>
                            <TextInput
                                style={styles.configInput}
                                value={serverUrl}
                                onChangeText={setServerUrl}
                                placeholder="https://resonate-app-t1t8.onrender.com"
                                placeholderTextColor="#666"
                                autoCapitalize="none"
                                autoCorrect={false}
                            />
                            <TouchableOpacity
                                style={styles.testBtn}
                                onPress={handleTestConnection}
                                disabled={serverHealth === 'checking'}
                            >
                                {serverHealth === 'checking' ? (
                                    <ActivityIndicator size="small" color="#fff" />
                                ) : (
                                    <Text style={styles.testBtnText}>Test</Text>
                                )}
                            </TouchableOpacity>
                        </View>

                        {serverHealth && (
                            <View style={styles.healthRow}>
                                <View
                                    style={[
                                        styles.healthDot,
                                        serverHealth === 'online' ? styles.dotGreen : styles.dotRed,
                                    ]}
                                />
                                <Text style={styles.healthText}>
                                    {serverHealth === 'online'
                                        ? 'Backend Server Online (200 OK)'
                                        : 'Cannot reach server. Verify Render backend status.'}
                                </Text>
                            </View>
                        )}
                        <Text style={styles.configHelp}>
                            • Cloud Backend: https://resonate-app-t1t8.onrender.com{'\n'}• Local: http://10.0.2.2:8000
                        </Text>
                    </View>
                )}

                {/* Search Bar */}
                <View style={styles.searchContainer}>
                    <TextInput
                        style={styles.searchInput}
                        placeholder="Song name, artist, or Spotify link..."
                        placeholderTextColor="#686d77"
                        value={query}
                        onChangeText={setQuery}
                        onSubmitEditing={() => handleSearchAndIngest()}
                        returnKeyType="search"
                        autoCorrect={false}
                    />
                    <TouchableOpacity
                        style={[styles.fetchButton, isBusy && styles.fetchButtonDisabled]}
                        onPress={() => handleSearchAndIngest()}
                        disabled={isBusy}
                    >
                        {isBusy ? (
                            <ActivityIndicator size="small" color="#000" />
                        ) : (
                            <Text style={styles.fetchButtonText}>Play</Text>
                        )}
                    </TouchableOpacity>
                </View>

                {/* Quick Suggestion Chips */}
                {!currentTrack && (
                    <View style={styles.chipsSection}>
                        <Text style={styles.chipsLabel}>Try Instant Ingest:</Text>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsScroll}>
                            {QUICK_SEARCH_CHIPS.map((chip, idx) => (
                                <TouchableOpacity
                                    key={idx}
                                    style={styles.chip}
                                    onPress={() => {
                                        setQuery(chip);
                                        handleSearchAndIngest(chip);
                                    }}
                                >
                                    <Text style={styles.chipText}>{chip}</Text>
                                </TouchableOpacity>
                            ))}
                        </ScrollView>
                    </View>
                )}

                {/* Live Status Glass Banner */}
                <View style={styles.statusCard}>
                    <View style={styles.statusLeft}>
                        <View
                            style={[
                                styles.statusDot,
                                status === 'ready' && styles.dotGreen,
                                (status === 'downloading' || status === 'scanning') && styles.dotYellow,
                                status === 'failed' && styles.dotRed,
                            ]}
                        />
                        <View style={{ flex: 1 }}>
                            <Text style={styles.statusTitle}>
                                {status === 'idle' ? 'STANDBY' : status.toUpperCase()}
                            </Text>
                            <Text style={styles.statusDescription} numberOfLines={2}>
                                {statusMessage}
                            </Text>
                        </View>
                    </View>

                    {isBusy && (
                        <TouchableOpacity style={styles.cancelButton} onPress={stopPolling}>
                            <Text style={styles.cancelText}>Cancel</Text>
                        </TouchableOpacity>
                    )}
                </View>

                {/* Premium Vinyl Player Card */}
                {currentTrack && (
                    <View style={styles.playerCard}>
                        {/* Rotating Vinyl Record Visualizer */}
                        <Animated.View
                            style={[
                                styles.artworkGlowWrapper,
                                {
                                    transform: [{ scale: pulseGlow }],
                                },
                            ]}
                        >
                            <Animated.View
                                style={[
                                    styles.vinylDisc,
                                    {
                                        transform: [{ rotate: spinInterpolation }],
                                    },
                                ]}
                            >
                                <Image
                                    source={{
                                        uri: currentTrack.coverArt
                                            ? `${serverUrl}/api/cover/${currentTrack.coverArt}`
                                            : 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600',
                                    }}
                                    style={styles.albumArt}
                                />
                                <View style={styles.vinylCenterHole} />
                            </Animated.View>
                        </Animated.View>

                        {/* Song & Artist Info */}
                        <Text style={styles.songTitle} numberOfLines={1}>
                            {currentTrack.title || 'Unknown Title'}
                        </Text>
                        <Text style={styles.artistName} numberOfLines={1}>
                            {currentTrack.artist || 'Unknown Artist'}
                        </Text>
                        {currentTrack.album && (
                            <Text style={styles.albumName} numberOfLines={1}>
                                {currentTrack.album}
                            </Text>
                        )}

                        {/* Animated Equalizer Waveform Bars */}
                        <View style={styles.visualizerRow}>
                            <Animated.View style={[styles.eqBar, { transform: [{ scaleY: eqBar1 }] }]} />
                            <Animated.View style={[styles.eqBar, { transform: [{ scaleY: eqBar2 }] }]} />
                            <Animated.View style={[styles.eqBar, { transform: [{ scaleY: eqBar3 }] }]} />
                            <Animated.View style={[styles.eqBar, { transform: [{ scaleY: eqBar4 }] }]} />
                        </View>

                        {/* Interactive Seek Bar */}
                        <View
                            style={styles.progressTouchable}
                            onLayout={(e) => setProgressBarWidth(e.nativeEvent.layout.width)}
                            onTouchEnd={handleSeek}
                        >
                            <View style={styles.progressBackground}>
                                <View
                                    style={[
                                        styles.progressFill,
                                        {
                                            width: `${
                                                progress.duration && progress.duration > 0
                                                    ? Math.min(100, (progress.position / progress.duration) * 100)
                                                    : 0
                                            }%`,
                                        },
                                    ]}
                                />
                            </View>
                        </View>

                        {/* Time Indicators */}
                        <View style={styles.timeRow}>
                            <Text style={styles.timeText}>{formatTime(progress.position)}</Text>
                            <Text style={styles.timeText}>{formatTime(progress.duration)}</Text>
                        </View>

                        {/* Media Controls */}
                        <View style={styles.controlsRow}>
                            <TouchableOpacity style={styles.skipButton} onPress={() => handleSkip(-10)}>
                                <Text style={styles.skipText}>-10s</Text>
                            </TouchableOpacity>

                            <TouchableOpacity style={styles.playPauseGlowButton} onPress={togglePlayback}>
                                <Text style={styles.playPauseIcon}>{isPlaying ? '❚❚' : '▶'}</Text>
                            </TouchableOpacity>

                            <TouchableOpacity style={styles.skipButton} onPress={() => handleSkip(10)}>
                                <Text style={styles.skipText}>+10s</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#07080a',
    },
    scrollContent: {
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: 40,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 20,
    },
    badgeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    badgeBrand: {
        fontSize: 11,
        fontWeight: '900',
        color: '#1DB954',
        letterSpacing: 1.5,
    },
    badgeDot: {
        color: '#444',
        fontSize: 10,
    },
    badgeFeature: {
        fontSize: 10,
        fontWeight: '700',
        color: '#8e95a5',
        letterSpacing: 1,
    },
    headerTitle: {
        fontSize: 28,
        fontWeight: '800',
        color: '#ffffff',
        letterSpacing: 0.5,
        marginTop: 2,
    },
    settingsButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: '#13151b',
        borderWidth: 1,
        borderColor: '#212530',
        justifyContent: 'center',
        alignItems: 'center',
    },
    settingsButtonActive: {
        borderColor: '#1DB954',
        backgroundColor: '#17201b',
    },
    settingsIcon: {
        fontSize: 20,
        color: '#c5cad6',
    },
    configCard: {
        backgroundColor: '#12141a',
        padding: 16,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: '#242938',
        marginBottom: 20,
    },
    configTitle: {
        color: '#fff',
        fontWeight: '700',
        fontSize: 13,
        marginBottom: 10,
    },
    configInputRow: {
        flexDirection: 'row',
        gap: 10,
    },
    configInput: {
        flex: 1,
        height: 42,
        backgroundColor: '#0a0b0e',
        color: '#fff',
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#2b3040',
        fontSize: 13,
    },
    testBtn: {
        backgroundColor: '#272d3d',
        paddingHorizontal: 16,
        height: 42,
        borderRadius: 8,
        justifyContent: 'center',
        alignItems: 'center',
    },
    testBtnText: {
        color: '#fff',
        fontWeight: '700',
        fontSize: 12,
    },
    healthRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginTop: 10,
    },
    healthDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    healthText: {
        color: '#a0a6b5',
        fontSize: 12,
    },
    configHelp: {
        color: '#656b7c',
        fontSize: 11,
        marginTop: 8,
        lineHeight: 16,
    },
    searchContainer: {
        flexDirection: 'row',
        gap: 10,
        marginBottom: 16,
    },
    searchInput: {
        flex: 1,
        height: 52,
        backgroundColor: '#14161f',
        color: '#ffffff',
        paddingHorizontal: 16,
        borderRadius: 14,
        fontSize: 14,
        borderWidth: 1,
        borderColor: '#252a38',
    },
    fetchButton: {
        backgroundColor: '#1DB954',
        height: 52,
        paddingHorizontal: 22,
        borderRadius: 14,
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: '#1DB954',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 8,
        elevation: 6,
    },
    fetchButtonDisabled: {
        opacity: 0.6,
    },
    fetchButtonText: {
        color: '#000000',
        fontWeight: '800',
        fontSize: 15,
        letterSpacing: 0.5,
    },
    chipsSection: {
        marginBottom: 18,
    },
    chipsLabel: {
        color: '#687082',
        fontSize: 12,
        fontWeight: '600',
        marginBottom: 8,
    },
    chipsScroll: {
        flexDirection: 'row',
    },
    chip: {
        backgroundColor: '#12151d',
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 20,
        marginRight: 8,
        borderWidth: 1,
        borderColor: '#222838',
    },
    chipText: {
        color: '#c2c8d6',
        fontSize: 12,
        fontWeight: '500',
    },
    statusCard: {
        backgroundColor: '#101218',
        borderRadius: 14,
        padding: 14,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: '#1d212d',
        marginBottom: 20,
    },
    statusLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        flex: 1,
    },
    statusDot: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: '#555b6d',
    },
    dotGreen: {
        backgroundColor: '#1DB954',
        shadowColor: '#1DB954',
        shadowOpacity: 0.8,
        shadowRadius: 6,
    },
    dotYellow: {
        backgroundColor: '#f59e0b',
        shadowColor: '#f59e0b',
        shadowOpacity: 0.8,
        shadowRadius: 6,
    },
    dotRed: {
        backgroundColor: '#ef4444',
    },
    statusTitle: {
        fontSize: 11,
        fontWeight: '800',
        color: '#8b93a7',
        letterSpacing: 1,
    },
    statusDescription: {
        fontSize: 13,
        color: '#ffffff',
        marginTop: 2,
    },
    cancelButton: {
        backgroundColor: '#202431',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        marginLeft: 8,
    },
    cancelText: {
        color: '#aaa',
        fontSize: 12,
        fontWeight: '600',
    },
    playerCard: {
        backgroundColor: '#10131a',
        borderRadius: 24,
        padding: 24,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: '#202637',
        marginTop: 4,
    },
    artworkGlowWrapper: {
        shadowColor: '#1DB954',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.45,
        shadowRadius: 20,
        elevation: 10,
        marginBottom: 20,
    },
    vinylDisc: {
        width: 210,
        height: 210,
        borderRadius: 105,
        backgroundColor: '#0a0a0c',
        borderWidth: 6,
        borderColor: '#1c202a',
        justifyContent: 'center',
        alignItems: 'center',
        overflow: 'hidden',
    },
    albumArt: {
        width: 130,
        height: 130,
        borderRadius: 65,
    },
    vinylCenterHole: {
        position: 'absolute',
        width: 24,
        height: 24,
        borderRadius: 12,
        backgroundColor: '#07080a',
        borderWidth: 3,
        borderColor: '#1DB954',
    },
    songTitle: {
        color: '#ffffff',
        fontSize: 20,
        fontWeight: '800',
        textAlign: 'center',
        width: '100%',
    },
    artistName: {
        color: '#1DB954',
        fontSize: 15,
        fontWeight: '600',
        marginTop: 4,
        textAlign: 'center',
        width: '100%',
    },
    albumName: {
        color: '#656c80',
        fontSize: 13,
        marginTop: 2,
        textAlign: 'center',
        width: '100%',
    },
    visualizerRow: {
        flexDirection: 'row',
        gap: 6,
        alignItems: 'flex-end',
        height: 28,
        marginTop: 14,
        marginBottom: 10,
    },
    eqBar: {
        width: 4,
        height: 24,
        backgroundColor: '#1DB954',
        borderRadius: 2,
    },
    progressTouchable: {
        width: '100%',
        paddingVertical: 10,
    },
    progressBackground: {
        width: '100%',
        height: 6,
        backgroundColor: '#1c212d',
        borderRadius: 3,
        overflow: 'hidden',
    },
    progressFill: {
        height: '100%',
        backgroundColor: '#1DB954',
        borderRadius: 3,
    },
    timeRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        width: '100%',
        marginTop: 2,
        marginBottom: 14,
    },
    timeText: {
        color: '#676e82',
        fontSize: 12,
        fontWeight: '600',
    },
    controlsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        marginTop: 6,
    },
    skipButton: {
        backgroundColor: '#1a1f2b',
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderRadius: 20,
    },
    skipText: {
        color: '#c0c6d4',
        fontSize: 13,
        fontWeight: '700',
    },
    playPauseGlowButton: {
        width: 68,
        height: 68,
        borderRadius: 34,
        backgroundColor: '#1DB954',
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: '#1DB954',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.5,
        shadowRadius: 14,
        elevation: 8,
    },
    playPauseIcon: {
        color: '#000000',
        fontSize: 24,
        fontWeight: '900',
        marginLeft: 2,
    },
});