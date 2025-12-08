import Context from "./Context";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import TrackPlayer, { Event, useTrackPlayerEvents } from "react-native-track-player";
import { getRecommendedSongs } from "../Api/Recommended";
import { AddSongsToQueue } from "../MusicPlayerFunctions";
import FormatArtist from "../Utils/FormatArtists";

import { SetQueueSongs } from "../LocalStorage/storeQueue";
import { EachSongMenuModal } from "../Component/Global/EachSongMenuModal";
import { CacheManager } from "../Utils/CacheManager";
import historyManager from "../Utils/HistoryManager";

// Repeat constants
const Repeats = {
    NoRepeat: "repeat-off",
    RepeatAll: "repeat",
    RepeatOne: "repeat-once"
};

const events = [
    Event.PlaybackActiveTrackChanged,
    Event.PlaybackError,
    Event.PlaybackState,
];
const ContextState = (props) => {
    const [Index, setIndex] = useState(0);
    const [QueueIndex, setQueueIndex] = useState(0);
    const [currentPlaying, setCurrentPlaying] = useState({})
    const [Repeat, setRepeat] = useState(Repeats.NoRepeat);
    const [Visible, setVisible] = useState({
        visible: false,
    });
    const [previousScreen, setPreviousScreen] = useState(null);
    // Dedicated state for music player navigation - won't be affected by general navigation
    const [musicPreviousScreen, setMusicPreviousScreen] = useState("");

    // Add state to track the current playlist information
    const [currentPlaylistData, setCurrentPlaylistData] = useState(null);

    // Add state to track liked playlists for UI updates
    const [likedPlaylists, setLikedPlaylists] = useState([]);

    const [Queue, setQueue] = useState([]);
    async function updateTrack() {
        try {
            const tracks = await TrackPlayer.getQueue();
            // await SetQueueSongs(tracks)
            console.log(tracks);
            const ids = tracks.map((e) => e.id)
            const queuesId = Queue.map((e) => e.id)
            if (JSON.stringify(ids) !== JSON.stringify(queuesId)) {
                setQueue(tracks)
            }
        } catch (error) {
            console.log('updateTrack: TrackPlayer not ready yet');
        }
    }

    // Function to update liked playlists state and trigger UI updates
    function updateLikedPlaylist() {
        // This is just to trigger rerenders when playlists are liked/unliked
        setLikedPlaylists(prev => [...prev]);
    }

    async function AddRecommendedSongs(index, id) {
        const tracks = await TrackPlayer.getQueue();
        const totalTracks = tracks.length - 1
        if (index >= totalTracks - 2) {
            try {
                const songs = await getRecommendedSongs(id)
                if (songs?.data?.length !== 0) {
                    const ForMusicPlayer = songs.data.map((e) => {
                        return {
                            url: e.downloadUrl[3].url,
                            title: e.name.toString().replaceAll("&quot;", "\"").replaceAll("&amp;", "and").replaceAll("&#039;", "'").replaceAll("&trade;", "™"),
                            artist: FormatArtist(e?.artists?.primary).toString().replaceAll("&quot;", "\"").replaceAll("&amp;", "and").replaceAll("&#039;", "'").replaceAll("&trade;", "™"),
                            artwork: e.image[2].url,
                            duration: e.duration,
                            id: e.id,
                            language: e.language,
                        }
                    })
                    await AddSongsToQueue(ForMusicPlayer)
                }
            } catch (e) {
                console.log(e);
            } finally {
                await updateTrack()
            }
        }
    }

    useTrackPlayerEvents(events, async (event) => {
        try {
            if (event.type === Event.PlaybackError) {
                console.warn('An error occured while playing the current track.');

                // Log error details for debugging
                try {
                    const currentTrack = await TrackPlayer.getActiveTrack();
                    if (currentTrack) {
                        console.error(`❌ Playback error for: ${currentTrack.title}`);
                    }
                } catch (error) {
                    console.error('Error getting track info during error:', error);
                }

                // NOTE: Auto-recovery is handled by SmartPrefetchManager._handlePlaybackError()
                // which fetches stream on-demand and retries playback before skipping
            }

            if (event.type === Event.PlaybackActiveTrackChanged) {
                const trackingInfo = historyManager.getCurrentTrackingInfo();
                const currentTrackId = trackingInfo?.currentTrack?.id;
                const newTrackId = event.track?.id;

                // Only process if it's actually a different track
                if (currentTrackId !== newTrackId) {
                    // Stop tracking previous song if any
                    if (trackingInfo.isTracking) {
                        await historyManager.stopTracking();
                    }

                    setCurrentPlaying(event.track)
                    if (Repeat === Repeats.NoRepeat) {
                        if (event.track?.id) {
                            AddRecommendedSongs(event.index, event.track?.id)
                        }
                    }

                    // Start tracking the new track
                    if (event.track?.id) {
                        await historyManager.startTracking(event.track);
                    }
                } else {
                    // Same track, just update UI state
                    setCurrentPlaying(event.track)
                }
            }

            if (event.type === Event.PlaybackState) {
                // Handle playback state changes for pause/resume tracking
                console.log('Context: Playback state changed', event.state);

                if (event.state === 'playing') {
                    if (historyManager.isCurrentlyTracking) {
                        // Resume tracking if already tracking but was paused
                        historyManager.resumeTracking();
                    }
                } else if (event.state === 'paused') {
                    // Pause tracking when music is paused
                    historyManager.pauseTracking();
                } else if (event.state === 'stopped') {
                    // Stop tracking completely when music is stopped
                    await historyManager.stopTracking();
                }
            }
        } catch (error) {
            console.error('Error in TrackPlayer event handler:', error);
        }
    });
    async function InitialSetup() {
        try {
            // Clear old cache entries to prevent storage full errors
            await CacheManager.clearOldCacheEntries();

            // Initialize history manager
            await historyManager.initialize();

            // Check if player is already initialized
            try {
                await TrackPlayer.getPlaybackState();
                console.log('Player already initialized in Context');
            } catch (playerError) {
                // Player not initialized, set it up
                await TrackPlayer.setupPlayer({
                    android: {
                        appKilledPlaybackBehavior: 'ContinuePlayback',
                        alwaysPauseOnInterruption: false,
                    },
                    autoHandleInterruptions: true,
                    autoUpdateMetadata: true,
                });
                console.log('Player initialized successfully in Context');
            }
        } catch (error) {
            console.error('Error in InitialSetup:', error);
        }

        // Add delay before accessing TrackPlayer to ensure it's ready
        setTimeout(async () => {
            try {
                await updateTrack();
                await getCurrentSong();
            } catch (error) {
                console.error('Error in delayed setup:', error);
            }
        }, 500);
    }
    async function getCurrentSong() {
        try {
            const song = await TrackPlayer.getActiveTrack();
            setCurrentPlaying(song);
        } catch (error) {
            console.log('getCurrentSong: TrackPlayer not ready yet');
            setCurrentPlaying({});
        }
    }
    useEffect(() => {
        InitialSetup()

        // Handle app state changes for history tracking
        const handleAppStateChange = (nextAppState) => {
            console.log('Context: App state changed to', nextAppState);

            if (nextAppState === 'background' || nextAppState === 'inactive') {
                // App going to background, enable background mode and save progress
                console.log('Context: App going to background, enabling background tracking');
                historyManager.setBackgroundMode(true);
                historyManager.saveProgressBackground().catch(error => {
                    console.error('Error saving progress on background:', error);
                });
            } else if (nextAppState === 'active') {
                // App coming back to foreground, disable background mode
                console.log('Context: App coming to foreground, disabling background tracking');
                historyManager.setBackgroundMode(false);

                // Check if we need to resume tracking
                const checkTracking = async () => {
                    try {
                        // Add delay to ensure TrackPlayer is ready
                        setTimeout(async () => {
                            try {
                                // Check if TrackPlayer is initialized before accessing it
                                const isInitialized = await TrackPlayer.getPlaybackState().catch(() => false);
                                if (!isInitialized) {
                                    console.log('Context: TrackPlayer not initialized yet, skipping tracking check');
                                    return;
                                }

                                const currentTrack = await TrackPlayer.getActiveTrack();
                                const playerState = await TrackPlayer.getPlaybackState();

                                if (currentTrack && playerState.state === 'playing' && !historyManager.isCurrentlyTracking) {
                                    // Resume tracking if song is playing and we're not already tracking
                                    console.log('Context: Resuming tracking for', currentTrack.title);
                                    await historyManager.startTracking(currentTrack);
                                }
                            } catch (innerError) {
                                console.error('Error in delayed tracking check:', innerError);
                            }
                        }, 2000); // Increased delay to 2 seconds
                    } catch (error) {
                        console.error('Error checking tracking on foreground:', error);
                    }
                };
                checkTracking();
            }
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            subscription?.remove();
            historyManager.cleanup();
        };
    }, []);
    return <Context.Provider value={{
        currentPlaying,
        Repeat,
        setRepeat,
        updateTrack,
        Index,
        setIndex,
        QueueIndex,
        setQueueIndex,
        setVisible,
        Queue,
        previousScreen,
        setPreviousScreen,
        musicPreviousScreen,
        setMusicPreviousScreen,
        currentPlaylistData,
        setCurrentPlaylistData,
        updateLikedPlaylist,
        likedPlaylists
    }}>
        {props.children}
        <EachSongMenuModal setVisible={setVisible} Visible={Visible} />
    </Context.Provider>
}

export default ContextState
