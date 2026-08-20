import Context from './Context';
import QueueContext from './QueueContext';
import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { AppState, DeviceEventEmitter } from 'react-native';
import TrackPlayer, {
  Event,
  useTrackPlayerEvents,
} from 'react-native-track-player';
import { getRecommendedSongs } from '../Api/Recommended';
import { AddSongsToQueue } from '../MusicPlayerFunctions';
import FormatArtist from '../Utils/FormatArtists';
import { EachSongMenuModal } from '../Component/Global/EachSongMenuModal';
import { CacheManager as LegacyCacheManager } from '../Utils/CacheManager';
import historyManager from '../Utils/HistoryManager';
import {
  getQueueSnapshot,
  invalidateQueueSnapshot,
} from '../Utils/QueueSnapshot';

// Repeat constants
const Repeats = {
  NoRepeat: 'repeat-off',
  RepeatAll: 'repeat',
  RepeatOne: 'repeat-once',
};

const events = [
  Event.PlaybackActiveTrackChanged,
  Event.PlaybackError,
  Event.PlaybackState,
];
const ContextState = (props) => {
  const [Index, setIndex] = useState(0);
  const [QueueIndex, setQueueIndex] = useState(0);
  const [Repeat, setRepeat] = useState(Repeats.NoRepeat);
  const [Visible, setVisible] = useState({
    visible: false,
  });
  const [previousScreen, setPreviousScreen] = useState(null);
  // Dedicated state for music player navigation - won't be affected by general navigation
  const [musicPreviousScreen, setMusicPreviousScreen] = useState('');

  // State for tracking player initialization to prevent race conditions
  const isPlayerReady = useRef(false);

  // Add state to track the current playlist information
  const [currentPlaylistData, setCurrentPlaylistData] = useState(null);

  // Add state to track liked playlists for UI updates
  const [likedPlaylists, setLikedPlaylists] = useState([]);

  // Track if current playback is from a playlist/album (blocks auto-recommendations)
  const [isPlaylistActive, setIsPlaylistActive] = useState(false);

  // Track navigation FROM FullScreenMusic to other screens (Artist/Album)
  // When set, back navigation should return to FullScreenMusic first
  const [fullScreenNavigationTarget, setFullScreenNavigationTarget] =
    useState(null);

  const [Queue, setQueue] = useState([]);
  const QueueRef = useRef([]); // Ref to access latest queue in callbacks without dependency issues
  QueueRef.current = Queue; // Keep ref updated

  async function updateTrack() {
    if (!isPlayerReady.current) {
      return;
    }

    // PERFORMANCE: Defer getQueue to next animation frame
    // This prevents blocking the progress slider during track change
    requestAnimationFrame(async () => {
      try {
        const tracks = await getQueueSnapshot();
        // PERFORMANCE: Use O(1) comparison instead of O(n) JSON.stringify
        // Compare length and first/last IDs - if these match, queue is likely unchanged
        // FIX: Always update if new tracks were added (length increased)
        const hasChanged =
          tracks.length !== QueueRef.current.length ||
          (tracks.length > 0 &&
            QueueRef.current.length > 0 &&
            (tracks[0]?.id !== QueueRef.current[0]?.id ||
              tracks[tracks.length - 1]?.id !==
              QueueRef.current[QueueRef.current.length - 1]?.id));

        if (hasChanged || tracks.length > QueueRef.current.length) {
          setQueue(tracks);
        }
      } catch (error) { }
    });
  }

  // Function to update liked playlists state and trigger UI updates
  function updateLikedPlaylist() {
    // This is just to trigger rerenders when playlists are liked/unliked
    setLikedPlaylists((prev) => [...prev]);
  }

  async function AddRecommendedSongs(index, id) {
    if (!isPlayerReady.current) {
      return;
    }

    // 🚫 SKIP RECOMMENDATIONS for Album/Playlist playback
    // Using dedicated isPlaylistActive flag instead of currentPlaylistData
    if (isPlaylistActive) {
      return;
    }

    // 🚫 SKIP for YouTube Music songs
    // YTMusic uses AutoRecommendations service (Utils/AutoRecommendations.js)
    // This function is ONLY for Saavn songs which use the old recommendation API
    const currentTrack = await TrackPlayer.getActiveTrack();
    if (
      currentTrack?.isYTMusic ||
      currentTrack?.source === 'ytmusic' ||
      (currentTrack?.id &&
        currentTrack.id.length === 11 &&
        !currentTrack.isLocal)
    ) {
      return;
    }

    // PERFORMANCE: Use QueueRef for length check to avoid O(N) bridge call
    // TrackPlayer.getQueue() deserializes 1000+ items - expensive!
    // Only fetch authoritative queue if we are actually near the end
    const currentQueueLength = QueueRef.current.length;
    if (currentQueueLength === 0) {
      // If local queue is empty, fallback to native fetch just in case
      const tracks = await getQueueSnapshot();
      if (index < tracks.length - 2) {
        return;
      }
    } else {
      // Use cached length for O(1) check
      if (index < currentQueueLength - 2) {
        return;
      }
    }

    // Only if we passed the check, get full queue to proceed with logic
    const tracks = await getQueueSnapshot();
    const totalTracks = tracks.length - 1;
    if (index >= totalTracks - 2) {
      try {
        const songs = await getRecommendedSongs(id);
        if (songs?.data?.length !== 0) {
          const ForMusicPlayer = songs.data.map((e) => {
            return {
              url: e.downloadUrl[3].url,
              title: e.name
                .toString()
                .replaceAll('&quot;', '"')
                .replaceAll('&amp;', 'and')
                .replaceAll('&#039;', "'")
                .replaceAll('&trade;', '™'),
              artist: FormatArtist(e?.artists?.primary)
                .toString()
                .replaceAll('&quot;', '"')
                .replaceAll('&amp;', 'and')
                .replaceAll('&#039;', "'")
                .replaceAll('&trade;', '™'),
              artwork: e.image[2].url,
              duration: e.duration,
              id: e.id,
              language: e.language,
            };
          });
          await AddSongsToQueue(ForMusicPlayer);
        }
      } catch (e) {
      } finally {
        await updateTrack();
      }
    }
  }

  useTrackPlayerEvents(events, async (event) => {
    // CRITICAL ROOT FIX: Prevent any handling before player is explicitly ready
    if (!isPlayerReady.current) {
      // Silently ignore events when player is not ready (prevents log spam)
      return;
    }

    try {
      if (event.type === Event.PlaybackError) {
        // NOTE: recovery is owned solely by SmartPrefetchManager's
        // PlaybackError handler. This used to run a second, independent
        // recovery (fetch + remove + add + skip + play) against the same
        // index, duplicating the network work and racing the other handler
        // into index shifts - which is what stretched a failed stream into a
        // multi-second freeze. Keep this as logging only.
        console.warn('Playback error reported for the current track.');
      }

      if (event.type === Event.PlaybackActiveTrackChanged) {
        // PERFORMANCE: Use event.track.id directly instead of blocking historyManager.getCurrentTrackingInfo() call
        const newTrackId = event.track?.id;

        // NOTE: the active track is no longer mirrored into React state here.
        // Components read it via TrackPlayer's useActiveTrack() hook, which
        // only re-renders the components that actually display it instead of
        // every Context consumer in the tree.

        // Only process if it's actually a different track
        // Compare with last known track ID to avoid redundant operations
        const lastTrackId = historyManager.isCurrentlyTracking
          ? historyManager.currentTrack?.id
          : null;

        if (lastTrackId !== newTrackId) {
          // ✅ TRULY NON-BLOCKING: Use setImmediate to defer file I/O
          // This ensures history tracking runs AFTER the current JS call stack clears
          // preventing any UI freeze when opening fullscreen player
          setImmediate(() => {
            const trackingPromises = [];
            if (historyManager.isCurrentlyTracking) {
              trackingPromises.push(historyManager.stopTracking());
            }
            if (event.track?.id) {
              trackingPromises.push(historyManager.startTracking(event.track));
            }

            // SYNC QUEUE: Ensure Context.Queue is updated when track changes
            // This fixes the empty queue UI issue in QueueBottomSheet
            // It uses QueueRef optimization internally so it's efficient
            trackingPromises.push(updateTrack());

            Promise.all(trackingPromises).catch((err) =>
              console.error('Track change tracking error:', err)
            );
          });

          // Prefetch is owned by SmartPrefetchManager's own track-change
          // listener. ContextState used to kick off an identical N+1/N+2 pass
          // here, so every track change resolved each upcoming stream twice
          // and both passes rewrote the same queue entries. All we keep is the
          // hot-reload guard that re-registers the manager's listeners.
          if (event.track?.id) {
            setImmediate(() => {
              try {
                const smartPrefetchManager =
                  require('../Utils/SmartPrefetchManager').default;
                if (!smartPrefetchManager.isInitialized) {
                  smartPrefetchManager.initialize();
                }
              } catch (prefetchError) {}
            });
          }

          // ✅ Add recommendations async (non-blocking)
          // Defer to next tick to keep UI responsive
          if (Repeat === Repeats.NoRepeat && event.track?.id) {
            setTimeout(() => {
              AddRecommendedSongs(event.index, event.track.id).catch((err) =>
                console.error('Recommendations error:', err)
              );
            }, 100);
          }
        }
      }

      if (event.type === Event.PlaybackState) {
        // Handle playback state changes for pause/resume tracking
        // NOTE: Removed console.log here as it fires frequently and adds overhead

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
      await LegacyCacheManager.clearOldCacheEntries();

      // Initialize history manager
      await historyManager.initialize();

      // Initialization check

      // Check if player is already initialized
      try {
        await TrackPlayer.getPlaybackState();
        isPlayerReady.current = true; // Mark ready immediately
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
        isPlayerReady.current = true; // Mark ready after setup
      }
    } catch (error) {
      console.error('Error in InitialSetup:', error);
      // Even if error, if we can correct it, we might set ready, but safer to leave false
    }

    // Add delay before accessing TrackPlayer to ensure it's ready
    // Only run if we marked it as ready
    if (isPlayerReady.current) {
      setTimeout(async () => {
        try {
          await updateTrack();
        } catch (error) {
          console.error('Error in delayed setup:', error);
        }
      }, 500);
    }
  }

  useEffect(() => {
    InitialSetup();

    // Listen for playback mode changes from MusicPlayerFunctions
    const playbackModeListener = DeviceEventEmitter.addListener(
      'playback-mode-changed',
      (event) => {
        setIsPlaylistActive(event.isPlaylist);
      }
    );

    // Handle app state changes for history tracking
    const handleAppStateChange = (nextAppState) => {
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        // App going to background, enable background mode and save progress
        historyManager.setBackgroundMode(true);
        historyManager.saveProgressBackground().catch((error) => {
          console.error('Error saving progress on background:', error);
        });
      } else if (nextAppState === 'active') {
        // App coming back to foreground, disable background mode
        historyManager.setBackgroundMode(false);

        // Check if we need to resume tracking
        const checkTracking = async () => {
          try {
            // Add delay to ensure TrackPlayer is ready
            setTimeout(async () => {
              try {
                // Check if TrackPlayer is initialized before accessing it
                const isInitialized =
                  await TrackPlayer.getPlaybackState().catch(() => false);
                if (!isInitialized) {
                  return;
                }

                const currentTrack = await TrackPlayer.getActiveTrack();
                const playerState = await TrackPlayer.getPlaybackState();

                if (
                  currentTrack &&
                  playerState.state === 'playing' &&
                  !historyManager.isCurrentlyTracking
                ) {
                  // Resume tracking if song is playing and we're not already tracking
                  // Non-blocking: Don't await, let it run in background
                  historyManager
                    .startTracking(currentTrack)
                    .catch((err) =>
                      console.error('Error resuming tracking:', err)
                    );
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

    // Listen for queue updates from MusicPlayerFunctions (e.g. AddSongsToQueue)
    // DEBOUNCED: Prevents rapid re-renders during progressive batch loading
    let queueUpdateTimeout = null;
    const queueUpdateListener = DeviceEventEmitter.addListener(
      'queue-updated',
      async (event) => {
        // Clear any pending update
        if (queueUpdateTimeout) {
          clearTimeout(queueUpdateTimeout);
        }

        invalidateQueueSnapshot();

        // For progressive batches, skip immediate sync - they just add songs at the end
        // The threshold-based loader adds small batches frequently
        if (event?.isProgressiveBatch) {
          // Debounce progressive batch updates by 500ms to reduce re-renders
          queueUpdateTimeout = setTimeout(async () => {
            await updateTrack();
          }, 500);
        } else {
          // For non-progressive updates (e.g., play next, queue clear), sync immediately
          await updateTrack();
        }
      }
    );

    const subscription = AppState.addEventListener(
      'change',
      handleAppStateChange
    );

    return () => {
      // Cleanup timeout for debounced queue updates
      if (queueUpdateTimeout) {
        clearTimeout(queueUpdateTimeout);
      }
      subscription?.remove();
      playbackModeListener?.remove();
      historyManager.cleanup();
      if (queueUpdateListener) {
        queueUpdateListener.remove();
      }
    };
  }, []);
  // Memoize context value to prevent unnecessary re-renders
  const contextValue = useMemo(
    () => ({
      Repeat,
      setRepeat,
      updateTrack,
      Index,
      setIndex,
      QueueIndex,
      setQueueIndex,
      setVisible,
      previousScreen,
      setPreviousScreen,
      musicPreviousScreen,
      setMusicPreviousScreen,
      currentPlaylistData,
      setCurrentPlaylistData,
      updateLikedPlaylist,
      likedPlaylists,
      isPlaylistActive,
      setIsPlaylistActive,
      fullScreenNavigationTarget,
      setFullScreenNavigationTarget,
    }),
    [
      Repeat,
      Index,
      QueueIndex,
      previousScreen,
      musicPreviousScreen,
      currentPlaylistData,
      likedPlaylists,
      isPlaylistActive,
      fullScreenNavigationTarget,
    ]
  );

  // Queue lives in its own provider so queue churn doesn't re-render the app
  const queueContextValue = useMemo(
    () => ({ Queue, updateTrack }),
    [Queue]
  );

  return (
    <Context.Provider value={contextValue}>
      <QueueContext.Provider value={queueContextValue}>
        {props.children}
        <EachSongMenuModal setVisible={setVisible} Visible={Visible} />
      </QueueContext.Provider>
    </Context.Provider>
  );
};

export default ContextState;
