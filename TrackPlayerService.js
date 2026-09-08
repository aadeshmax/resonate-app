import TrackPlayer, { Capability, State, AppKilledPlaybackBehavior } from 'react-native-track-player';

let isPlayerSetup = false;

export const setupPlayer = async () => {
    if (isPlayerSetup) return true;

    try {
        await TrackPlayer.setupPlayer();
        await TrackPlayer.updateOptions({
            android: {
                appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
            },
            capabilities: [
                Capability.Play,
                Capability.Pause,
                Capability.SkipToNext,
                Capability.SkipToPrevious,
                Capability.Stop,
                Capability.SeekTo,
            ],
            compactCapabilities: [Capability.Play, Capability.Pause, Capability.Stop],
        });
        isPlayerSetup = true;
        return true;
    } catch (error) {
        // If player is already initialized, mark flag as true
        if (error.message?.includes('already been initialized')) {
            isPlayerSetup = true;
            return true;
        }
        console.log('[TrackPlayer] Setup error:', error);
        return false;
    }
};

export const playTrack = async (streamUrl, title, artist, artworkUrl) => {
    try {
        await setupPlayer();
        await TrackPlayer.reset();
        await TrackPlayer.add({
            id: `track-${Date.now()}`,
            url: streamUrl,
            title: title || 'Unknown Title',
            artist: artist || 'Unknown Artist',
            artwork: artworkUrl || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600',
        });
        await TrackPlayer.play();
    } catch (error) {
        console.error('[TrackPlayer] Play track failed:', error);
    }
};

export const pauseTrack = async () => {
    try {
        await TrackPlayer.pause();
    } catch (error) {
        console.error('[TrackPlayer] Pause error:', error);
    }
};

export const resumeTrack = async () => {
    try {
        await TrackPlayer.play();
    } catch (error) {
        console.error('[TrackPlayer] Resume error:', error);
    }
};

export const togglePlayback = async () => {
    try {
        const state = await TrackPlayer.getState();
        if (state === State.Playing) {
            await TrackPlayer.pause();
            return false;
        } else {
            await TrackPlayer.play();
            return true;
        }
    } catch (error) {
        console.error('[TrackPlayer] Toggle playback error:', error);
        return false;
    }
};

export const stopPlayer = async () => {
    try {
        await TrackPlayer.stop();
        await TrackPlayer.reset();
    } catch (error) {
        console.error('[TrackPlayer] Stop player error:', error);
    }
};