import React, {
  useContext,
  useEffect,
  useState,
  memo,
  useCallback,
  useRef,
} from 'react';
import {
  View,
  Text,
  Platform,
  ToastAndroid,
  DeviceEventEmitter,
} from 'react-native';
import { EachSongQueue } from './EachSongQueue';
import { BottomSheetFlatList } from '@gorhom/bottom-sheet';
import QueueContext from '../../Context/QueueContext';
import {
  getQueueSnapshot,
  invalidateQueueSnapshot,
} from '../../Utils/QueueSnapshot';
import {
  useActiveTrack,
  usePlaybackState,
  useTrackPlayerEvents,
  Event,
  State,
} from 'react-native-track-player';
import TrackPlayer from 'react-native-track-player';
import Ionicons from 'react-native-vector-icons/Ionicons';
import DraggableFlatList, {
  ScaleDecorator,
} from 'react-native-draggable-flatlist';
import { SkipToTrack } from '../../MusicPlayerFunctions';
import NetInfo from '@react-native-community/netinfo';
import { StorageManager } from '../../Utils/StorageManager';
import { useThemeContext } from '../../Context/ThemeContext';
import { debounce, deduplicateEventHandler } from '../../Utils/EventDebouncer';
import EventRegister from '../../Utils/EventRegister';
import { downloadSongNow } from '../../hooks/useDownloadSong';
import { InteractionManager } from 'react-native';

// Function to get high quality artwork URL
const getHighQualityArtwork = (artworkUrl) => {
  if (!artworkUrl) {
    return null;
  }

  try {
    // For data: URIs (embedded base64 artwork), return as is - DO NOT modify!
    if (artworkUrl.startsWith('data:')) {
      return artworkUrl;
    }

    // For local files, return as is
    if (artworkUrl.startsWith('file://')) {
      return artworkUrl;
    }

    // Special handling for JioSaavn CDN
    if (artworkUrl.includes('saavncdn.com')) {
      // Replace any size with 500x500 for highest quality
      return artworkUrl.replace(/50x50|150x150|500x500/g, '500x500');
    }

    // For other URLs, try to add quality parameter
    try {
      const url = new URL(artworkUrl);
      // Set quality to maximum
      url.searchParams.set('quality', '100');
      return url.toString();
    } catch (e) {
      // If URL parsing fails, try direct string manipulation
      if (artworkUrl.includes('?')) {
        return `${artworkUrl}&quality=100`;
      } else {
        return `${artworkUrl}?quality=100`;
      }
    }
  } catch (error) {
    console.error('Error processing artwork URL:', error);
    return artworkUrl; // Return original URL as fallback
  }
};

const QueueRenderSongs = memo(({ reorderMode = false }) => {
  // Context and state
  const { Queue } = useContext(QueueContext);
  const { theme, themeMode } = useThemeContext();
  const currentPlaying = useActiveTrack();
  const playerState = usePlaybackState(); // Call ONCE here instead of in every queue item
  const [upcomingQueue, setUpcomingQueue] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isLocalSource, setIsLocalSource] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [lastDraggedSongId, setLastDraggedSongId] = useState(null);
  const [isOffline, setIsOffline] = useState(false);
  const [isPendingAction, setIsPendingAction] = useState(false);
  const flatListRef = useRef(null);
  const operationInProgressRef = useRef(false);
  const skipNextQueueInitRef = useRef(false); // Skip queue re-init after reorder
  const downloadedTracksCache = useRef(null); // PERFORMANCE: Cache downloaded tracks to avoid file I/O
  const lastCacheTime = useRef(0); // Track when cache was last updated

  // PERFORMANCE FIX: Cache TrackPlayer queue to avoid repeated expensive bridge calls
  // TrackPlayer.getQueue() with 89 tracks serializes entire queue over bridge (slow!)
  const trackPlayerQueueCache = useRef(null);
  const trackPlayerQueueCacheTime = useRef(0);
  const QUEUE_CACHE_TTL = 2000; // 2 second cache - queue doesn't change that often

  // PERFORMANCE FIX: Centralized download state management
  // Instead of 87 individual useDownload hooks (causing callback leak), we track all in ONE state
  const [downloadStates, setDownloadStates] = useState({}); // { songId: { isDownloading, progress, isDownloaded } }

  // Listen to global download events ONCE (not per-item) to prevent callback leak
  useEffect(() => {
    const handleDownloadStarted = (songId) => {
      setDownloadStates((prev) => ({
        ...prev,
        [songId]: { isDownloading: true, progress: 0, isDownloaded: false },
      }));
    };

    const handleDownloadComplete = (songId) => {
      setDownloadStates((prev) => ({
        ...prev,
        [songId]: { isDownloading: false, progress: 100, isDownloaded: true },
      }));
    };

    const handleDownloadProgress = ({ songId, progress }) => {
      setDownloadStates((prev) => ({
        ...prev,
        [songId]: { ...prev[songId], progress },
      }));
    };

    // Register global event listeners (only 3 listeners total, not 87*3)
    EventRegister.addEventListener('download-started', handleDownloadStarted);
    EventRegister.addEventListener('download-complete', handleDownloadComplete);
    EventRegister.addEventListener('download-progress', handleDownloadProgress);

    return () => {
      EventRegister.removeEventListener(
        'download-started',
        handleDownloadStarted
      );
      EventRegister.removeEventListener(
        'download-complete',
        handleDownloadComplete
      );
      EventRegister.removeEventListener(
        'download-progress',
        handleDownloadProgress
      );
    };
  }, []);

  // Handler to start download for a song (passed to EachSongQueue as prop)
  const handleDownloadPress = useCallback((songData) => {
    if (!songData || !songData.id) {
      return;
    }

    // Defer heavy download operation to prevent UI blocking.
    // downloadSongNow already broadcasts 'download-progress', which the
    // listener above folds into downloadStates - no local emit needed.
    InteractionManager.runAfterInteractions(async () => {
      try {
        await downloadSongNow(songData);
      } catch (error) {
        console.error('Download error from QueueRenderSongs:', error.message);
        setDownloadStates((prev) => ({
          ...prev,
          [songData.id]: {
            isDownloading: false,
            progress: 0,
            isDownloaded: false,
          },
        }));
      }
    });
  }, []);

  // Check network status on component mount
  useEffect(() => {
    const checkNetworkStatus = async () => {
      try {
        const networkState = await NetInfo.fetch();
        setIsOffline(
          !(networkState.isConnected && networkState.isInternetReachable)
        );
      } catch (error) {
        console.error('Error checking network status:', error);
        // Default to online if we can't determine
        setIsOffline(false);
      }
    };

    checkNetworkStatus();

    // Subscribe to network changes
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsOffline(!(state.isConnected && state.isInternetReachable));
    });

    return () => unsubscribe();
  }, []);

  // More robust check for local tracks
  const isLocalTrack = (track) => {
    if (!track) {
      return false;
    }
    return Boolean(
      track.isLocalMusic ||
        track.isLocal ||
        track.isDownloaded ||
        track.path ||
        (track.url &&
          (track.url.startsWith('file://') ||
            track.url.includes('content://') ||
            track.url.includes('/storage/')))
    );
  };

  // Function to get all downloaded tracks (CACHED to prevent repeated file I/O)
  const getDownloadedTracks = async (forceRefresh = false) => {
    try {
      const now = Date.now();
      const CACHE_DURATION = 30000; // 30 seconds cache

      // Return cached data if valid and not forcing refresh
      if (
        !forceRefresh &&
        downloadedTracksCache.current &&
        now - lastCacheTime.current < CACHE_DURATION
      ) {
        return downloadedTracksCache.current;
      }

      // Get all downloaded song metadata
      const allMetadata = await StorageManager.getAllDownloadedSongsMetadata();

      if (!allMetadata || Object.keys(allMetadata).length === 0) {
        downloadedTracksCache.current = [];
        lastCacheTime.current = now;
        return [];
      }

      // Format tracks with metadata - use batch approach
      const tracks = await Promise.all(
        Object.values(allMetadata).map(async (metadata) => {
          const artworkPath = await StorageManager.getArtworkPath(metadata.id);
          const songPath = await StorageManager.getSongPath(metadata.id);

          return {
            id: metadata.id,
            url: `file://${songPath}`,
            title: metadata.title || 'Unknown',
            artist: metadata.artist || 'Unknown',
            artwork: `file://${artworkPath}`,
            localArtworkPath: artworkPath,
            duration: metadata.duration || 0,
            isLocal: true,
            isDownloaded: true,
            sourceType: 'download',
          };
        })
      );

      // Update cache
      downloadedTracksCache.current = tracks;
      lastCacheTime.current = now;
      return tracks;
    } catch (error) {
      console.error('Error getting downloaded tracks:', error);
      return downloadedTracksCache.current || [];
    }
  };

  // Function to filter queue based on track source with offline support
  const filterQueueBySource = useCallback(
    async (currentTrack, providedQueue = null) => {
      try {
        if (!currentTrack) {
          return [];
        }

        // PERFORMANCE: resolved lazily. getDownloadedTracks() reads the
        // downloads metadata and resolves an artwork + song path per
        // downloaded song. Running it eagerly put that I/O on every track
        // change - including online playback, which never uses the result.
        let downloadedTracksPromise = null;
        const downloadedTracksLazy = () => {
          if (!downloadedTracksPromise) {
            downloadedTracksPromise = getDownloadedTracks();
          }
          return downloadedTracksPromise;
        };

        // Check if the current track has a sourceType (mymusic or download)
        const sourceType = (
          currentTrack.sourceType ||
          (isLocalTrack(currentTrack) ? 'download' : 'online')
        )
          ?.toString?.()
          .toLowerCase();
        // Verbose logging commented for performance
        // // If playing a track from MyMusic, only show MyMusic tracks in the queue
        if (sourceType === 'mymusic') {
          // PERFORMANCE: Use provided queue if available, otherwise fallback to Context
          let fullQueue = providedQueue || Queue || [];

          // CRITICAL FIX: If queue is empty, fallback to TrackPlayer.getQueue()
          // This ensures progressive-loaded local music tracks are visible in queue panel
          if (fullQueue.length === 0) {
            const now = Date.now();
            if (
              trackPlayerQueueCache.current &&
              now - trackPlayerQueueCacheTime.current < QUEUE_CACHE_TTL
            ) {
              fullQueue = trackPlayerQueueCache.current;
            } else {
              try {
                fullQueue = await getQueueSnapshot(QUEUE_CACHE_TTL);
                trackPlayerQueueCache.current = fullQueue;
                trackPlayerQueueCacheTime.current = now;
              } catch (e) {}
            }
          }

          // Filter to only include tracks from MyMusic source, regardless of online/offline status
          const myMusicTracks = fullQueue.filter(
            (track) => track.sourceType === 'mymusic'
          );

          // If no MyMusic tracks found, just show the current track
          if (myMusicTracks.length === 0) {
            return [currentTrack];
          }

          // Put current track first
          const rearrangedTracks = [
            currentTrack,
            ...myMusicTracks.filter((track) => track.id !== currentTrack.id),
          ];

          setIsLocalSource(true);
          return rearrangedTracks;
        }

        // If playing a downloaded track
        // Treat both 'download' and legacy 'downloaded' as downloaded source
        if (
          sourceType === 'download' ||
          sourceType === 'downloaded' ||
          (isLocalTrack(currentTrack) && !currentTrack.sourceType)
        ) {
          // Always use downloaded tracks in offline mode or when explicitly playing downloaded music
          // PERFORMANCE: Use provided queue if available, otherwise fallback to Context
          let fullQueue = providedQueue || Queue || [];

          // CRITICAL FIX: If queue is empty, fallback to TrackPlayer.getQueue()
          // This mirrors the behavior for online tracks and ensures downloaded songs are shown
          if (fullQueue.length === 0) {
            const now = Date.now();
            if (
              trackPlayerQueueCache.current &&
              now - trackPlayerQueueCacheTime.current < QUEUE_CACHE_TTL
            ) {
              fullQueue = trackPlayerQueueCache.current;
            } else {
              try {
                fullQueue = await getQueueSnapshot(QUEUE_CACHE_TTL);
                trackPlayerQueueCache.current = fullQueue;
                trackPlayerQueueCacheTime.current = now;
              } catch (e) {}
            }
          }

          // Filter to only include downloaded tracks
          const downloadSourceTracks = fullQueue.filter(
            (track) =>
              (track.sourceType &&
                String(track.sourceType).toLowerCase() === 'download') ||
              (track.sourceType &&
                String(track.sourceType).toLowerCase() === 'downloaded') ||
              (isLocalTrack(track) && !track.sourceType)
          );

          // If no downloaded tracks found in queue, merge with downloaded tracks from storage
          let combinedTracks =
            downloadSourceTracks.length > 0 ? downloadSourceTracks : [];

          // Add any downloaded tracks not already in the queue
          const downloadedTracks = await downloadedTracksLazy();
          if (downloadedTracks.length > 0) {
            const existingIds = new Set(combinedTracks.map((t) => t.id));
            const additionalDownloads = downloadedTracks.filter(
              (t) => !existingIds.has(t.id)
            );
            combinedTracks = [...combinedTracks, ...additionalDownloads];
          }

          // If still empty, at least show current track
          if (combinedTracks.length === 0) {
            combinedTracks = [currentTrack];
          } else {
            // Put current track first if it exists in the combined tracks
            const currentTrackIndex = combinedTracks.findIndex(
              (t) => t.id === currentTrack.id
            );
            if (currentTrackIndex > 0) {
              const currentTrackItem = combinedTracks.splice(
                currentTrackIndex,
                1
              )[0];
              combinedTracks = [currentTrackItem, ...combinedTracks];
            } else if (currentTrackIndex === -1) {
              // Add current track if not in the combined list
              combinedTracks = [currentTrack, ...combinedTracks];
            }
          }

          setIsLocalSource(true);
          return combinedTracks;
        }

        // For online tracks in online mode - normal behavior
        if (!isOffline) {
          // PERFORMANCE: Use provided queue if available, otherwise fallback to Context
          let fullQueue = providedQueue || Queue || [];
          // Reduced logging for performance
          // // FALLBACK: If Context.Queue is empty (due to React state batching delay),
          // fetch directly from TrackPlayer - BUT USE CACHE to avoid expensive bridge calls
          if (fullQueue.length === 0) {
            const now = Date.now();
            // Use cached queue if fresh enough
            if (
              trackPlayerQueueCache.current &&
              now - trackPlayerQueueCacheTime.current < QUEUE_CACHE_TTL
            ) {
              fullQueue = trackPlayerQueueCache.current;
            } else {
              // Cache is stale or empty - fetch fresh queue from TrackPlayer
              try {
                fullQueue = await getQueueSnapshot(QUEUE_CACHE_TTL);
                // Cache the result
                trackPlayerQueueCache.current = fullQueue;
                trackPlayerQueueCacheTime.current = now;
              } catch (e) {
                // Ignore error, fallback to empty queue
              }
            }
          }

          if (fullQueue.length === 0) {
            return [currentTrack];
          }

          // Filter to only include online tracks (neither mymusic nor download source type)
          const onlineTracks = fullQueue.filter(
            (track) =>
              (!track.sourceType ||
                (track.sourceType &&
                  String(track.sourceType).toLowerCase() === 'online')) &&
              !isLocalTrack(track)
          );

          // Put current track first if it exists in the online tracks
          if (onlineTracks.length > 0) {
            const currentTrackIndex = onlineTracks.findIndex(
              (t) => t.id === currentTrack.id
            );
            if (currentTrackIndex > 0) {
              const currentTrackItem = onlineTracks.splice(
                currentTrackIndex,
                1
              )[0];
              return [currentTrackItem, ...onlineTracks];
            } else if (currentTrackIndex === -1) {
              // If current track is not in the filtered list but should be (it's online)
              if (!isLocalTrack(currentTrack)) {
                return [currentTrack, ...onlineTracks];
              }
            }
            return onlineTracks;
          }

          // If no online tracks found or filtering removed all tracks
          return [currentTrack];
        } else {
          // In offline mode, if current track is not local/downloaded or from MyMusic,
          // default to showing downloaded songs as fallback
          // If we have downloaded tracks, show them
          const downloadedTracks = await downloadedTracksLazy();
          if (downloadedTracks.length > 0) {
            return [
              currentTrack,
              ...downloadedTracks.filter((t) => t.id !== currentTrack.id),
            ];
          }

          // Last resort, just show current track
          return [currentTrack];
        }
      } catch (error) {
        console.error('Error filtering queue by source:', error);

        // If error occurs and we have a current track, at least show that
        if (currentTrack) {
          return [currentTrack];
        }
        return [];
      }
    },
    [isLocalTrack, isOffline, getDownloadedTracks, Queue]
  );

  // Debounce reference to prevent excessive updates
  const lastTrackUpdateRef = useRef(0);
  const lastProcessedTrackIdRef = useRef(null); // Skip if same track
  const TRACK_UPDATE_DEBOUNCE = 300; // 300ms debounce

  // Track change listener to update the queue - DEBOUNCED and DEFERRED
  useTrackPlayerEvents([Event.PlaybackTrackChanged], (event) => {
    // PERFORMANCE: Use InteractionManager instead of requestAnimationFrame
    // This ensures UI animations complete before heavy queue processing starts
    InteractionManager.runAfterInteractions(() => {
      handleTrackChangeEvent(event);
    });
  });

  // Actual track change handler - deferred execution
  const handleTrackChangeEvent = async (event) => {
    // Skip if dragging or operation in progress
    if (isDragging || operationInProgressRef.current) {
      return;
    }

    // Skip if reorder just completed (let the reordered state persist)
    if (skipNextQueueInitRef.current) {
      return;
    }

    // Debounce rapid updates
    const now = Date.now();
    if (now - lastTrackUpdateRef.current < TRACK_UPDATE_DEBOUNCE) {
      return; // Ignore rapid fire events
    }
    lastTrackUpdateRef.current = now;

    if (event.type === Event.PlaybackTrackChanged) {
      try {
        // Get current track
        const track = await TrackPlayer.getActiveTrack();
        const index = await TrackPlayer.getCurrentTrack();

        if (track) {
          // PERFORMANCE: Skip if we already processed this exact track
          // This prevents redundant queue processing during rapid track changes
          if (lastProcessedTrackIdRef.current === track.id) {
            return; // Already processed this track
          }
          lastProcessedTrackIdRef.current = track.id;

          setCurrentIndex(index || 0);

          // Get the source type for the current track
          const sourceType =
            track.sourceType || (isLocalTrack(track) ? 'download' : 'online');

          // Update local source flag based on source type
          setIsLocalSource(
            sourceType === 'mymusic' ||
              sourceType === 'download' ||
              isLocalTrack(track)
          );

          // Filter the queue based on source type
          const filtered = await filterQueueBySource(track);

          // Reduced logging for performance - uncomment for debugging
          // // Filter out duplicate songs based on ID
          const uniqueIds = new Set();
          const uniqueFiltered = filtered.filter((track) => {
            if (!track || !track.id || uniqueIds.has(track.id)) {
              return false;
            }
            uniqueIds.add(track.id);
            return true;
          });

          // Ensure current track is always first
          if (track.id && uniqueFiltered.length > 0) {
            const currentTrackIndex = uniqueFiltered.findIndex(
              (t) => t.id === track.id
            );

            // If current track isn't first and exists in the queue
            if (currentTrackIndex > 0) {
              // Move current track to the beginning
              const currentTrack = uniqueFiltered.splice(
                currentTrackIndex,
                1
              )[0];
              uniqueFiltered.unshift(currentTrack);
            }
            // If current track isn't in the queue at all
            else if (currentTrackIndex === -1) {
              uniqueFiltered.unshift(track);
            }
          }

          setUpcomingQueue(uniqueFiltered);
        } else {
          setUpcomingQueue([]);
        }
      } catch (error) {
        console.error('Error handling track change event:', error);
        setUpcomingQueue([]);
      }
    }
  };

  // Initialize queue when component mounts or current track changes
  useEffect(() => {
    const initializeQueue = async () => {
      if (isDragging || operationInProgressRef.current) {
        return;
      } // Don't update during operations

      // Skip this init if it was triggered by drag end (queue already reordered)
      if (skipNextQueueInitRef.current) {
        skipNextQueueInitRef.current = false;
        return;
      }

      try {
        if (currentPlaying) {
          // PERFORMANCE: Skip if track change event already processed this track
          // This prevents duplicate filterQueueBySource calls
          if (lastProcessedTrackIdRef.current === currentPlaying.id) {
            return; // Already processed by track change event
          }

          // Get the source type for the current track
          const sourceType =
            currentPlaying.sourceType ||
            (isLocalTrack(currentPlaying) ? 'download' : 'online');

          // Update local source flag based on source type
          setIsLocalSource(
            sourceType === 'mymusic' ||
              sourceType === 'download' ||
              isLocalTrack(currentPlaying)
          );

          // Filter queue based on current track's source type
          const filtered = await filterQueueBySource(currentPlaying);

          // Filter out duplicate songs based on ID
          const uniqueIds = new Set();
          const uniqueFiltered = filtered.filter((track) => {
            if (!track || !track.id || uniqueIds.has(track.id)) {
              return false;
            }
            uniqueIds.add(track.id);
            return true;
          });

          // Ensure current track is always first
          if (currentPlaying.id && uniqueFiltered.length > 0) {
            const currentTrackIndex = uniqueFiltered.findIndex(
              (t) => t.id === currentPlaying.id
            );

            // If current track isn't first and exists in the queue
            if (currentTrackIndex > 0) {
              // Move current track to the beginning
              const currentTrack = uniqueFiltered.splice(
                currentTrackIndex,
                1
              )[0];
              uniqueFiltered.unshift(currentTrack);
            }
            // If current track isn't in the queue at all
            else if (currentTrackIndex === -1) {
              uniqueFiltered.unshift(currentPlaying);
            }
          }

          setUpcomingQueue(uniqueFiltered);

          // Get current index
          const index = await TrackPlayer.getCurrentTrack();
          setCurrentIndex(index || 0);
        } else {
          setUpcomingQueue([]);
        }
      } catch (error) {
        console.error('Error initializing queue:', error);
        // In case of error, at least show the current track
        if (currentPlaying) {
          setUpcomingQueue([currentPlaying]);
        } else {
          setUpcomingQueue([]);
        }
      }
    };

    // Try to suppress playlist errors
    const suppressPlaylistErrors = () => {
      const originalConsoleError = console.error;

      // Replace console.error with our filtered version
      console.error = (...args) => {
        // Filter out playlist errors
        if (
          args.some(
            (arg) =>
              typeof arg === 'string' &&
              (arg.includes('Error getting playlist') ||
                arg.includes('Network Error') ||
                arg.includes('Network request failed'))
          )
        ) {
          // Just log a simpler message instead
          return;
        }

        // Pass through all other errors
        originalConsoleError.apply(console, args);
      };

      // Return function to restore original behavior
      return () => {
        console.error = originalConsoleError;
      };
    };

    // Suppress playlist errors when using the component
    const restoreConsole = suppressPlaylistErrors();

    // Initialize the queue
    initializeQueue();

    // Cleanup
    return () => {
      restoreConsole();
    };
    // Use currentPlayingId as dependency instead of currentPlaying object
    // This prevents excessive re-initialization when object reference changes but track is same
  }, [currentPlaying?.id, isDragging, isOffline]);

  // Function to handle removing track from queue (used by swipe gesture)
  const handleRemoveFromQueue = useCallback(async (displayIndex, trackId) => {
    if (operationInProgressRef.current) {
      return;
    }
    operationInProgressRef.current = true;

    try {
      // Get the full TrackPlayer queue
      const queue = await TrackPlayer.getQueue();

      // Find the track in the actual queue by ID
      const actualIndex = queue.findIndex((track) => track.id === trackId);

      if (actualIndex === -1) {
        // If not found in player but in our state, remove it from state anyway
        setUpcomingQueue((prev) => prev.filter((t) => t.id !== trackId));
        operationInProgressRef.current = false;
        return;
      }

      // Check if we're removing the currently playing track
      const currentIndex = await TrackPlayer.getActiveTrackIndex();
      const isCurrentTrack = actualIndex === currentIndex;

      if (isCurrentTrack) {
        if (queue.length > 1) {
          // If removing current track and there are other tracks, skip to next
          if (actualIndex < queue.length - 1) {
            await TrackPlayer.skipToNext();
          } else {
            await TrackPlayer.skipToPrevious();
          }
        } else {
          // If this was the only track, stop playback
          await TrackPlayer.stop();
        }
      }

      // Remove the track from the actual player queue
      await TrackPlayer.remove(actualIndex);
      invalidateQueueSnapshot();
      // CRITICAL: Update the visual queue state immediately
      // This ensures the UI reflects the removal even before any events trigger
      setUpcomingQueue((prev) => prev.filter((t) => t.id !== trackId));

      // Optional: Update Context.Queue if needed
      // updateTrack();
    } catch (error) {
      console.error('Error removing track from queue:', error);
    } finally {
      operationInProgressRef.current = false;
    }
  }, []);

  // Function to handle track selection from the queue
  const handleTrackSelect = useCallback(
    async (item, displayIndex) => {
      operationInProgressRef.current = true;
      try {
        // Capture playback state in case we need to restore it
        let wasPlaying = false;
        let position = 0;
        let currentTrack = null;

        try {
          setIsPendingAction(true);
          // Get current track to compare with selected
          currentTrack = await TrackPlayer.getActiveTrack();

          if (currentTrack?.id === item.id) {
            const state = await TrackPlayer.getState();

            if (state === State.Playing) {
              await TrackPlayer.pause();
            } else {
              await TrackPlayer.play();
            }
            setIsPendingAction(false);
            operationInProgressRef.current = false;
            return;
          }
        } catch (stateError) {
          console.error('Error getting playback state:', stateError);
        }

        // Get the full TrackPlayer queue to find the actual index
        const queue = await TrackPlayer.getQueue();

        // Find the track in the actual queue by ID
        const actualIndex = queue.findIndex((track) => track.id === item.id);

        if (actualIndex === -1) {
          console.warn(`Track with ID ${item.id} not found in player queue`);

          // If the track isn't in the queue but we want to play it anyway
          if (item.url) {
            // Ensure the sourceType property is properly set based on track type
            let sourceType = item.sourceType;

            // If sourceType isn't explicitly set, determine it based on the track properties
            if (!sourceType) {
              // Check if it's from MyMusic first from the URL or other properties
              if (item.isFromMyMusic) {
                sourceType = 'mymusic';
              }
              // Then check if it's a downloaded or local track
              else if (isLocalTrack(item)) {
                sourceType = 'download';
              }
              // If we have a current track, inherit its sourceType as fallback
              else if (currentTrack?.sourceType) {
                sourceType = currentTrack.sourceType;
              }
              // In offline mode, prefer download source type for local tracks
              else if (isOffline && isLocalTrack(item)) {
                sourceType = 'download';
              }
              // Last resort, mark as online
              else {
                sourceType = 'online';
              }
            }

            // Create track with proper source type
            const trackToAdd = {
              ...item,
              sourceType: sourceType,
            };

            // Try to add it to the queue and play it
            try {
              // In offline mode or when the source type matches the current track,
              // keep the existing queue as much as possible
              const shouldKeepQueue =
                isOffline ||
                (currentTrack && currentTrack.sourceType === sourceType);

              if (queue.length > 0 && shouldKeepQueue) {
                await TrackPlayer.add([trackToAdd], 0); // Add at beginning
                invalidateQueueSnapshot();
                await TrackPlayer.skip(0); // Skip to our new track
              } else {
                // Reset the queue if the source types are different
                await TrackPlayer.reset();
                await TrackPlayer.add([trackToAdd]);
                invalidateQueueSnapshot();
              }
              await TrackPlayer.play();
              setIsPendingAction(false);
              operationInProgressRef.current = false;
              return;
            } catch (err) {
              console.error('Error adding track to queue:', err);
              if (Platform.OS === 'android') {
                ToastAndroid.show(
                  'Could not play this track',
                  ToastAndroid.SHORT
                );
              }
              setIsPendingAction(false);
              operationInProgressRef.current = false;
              return;
            }
          }

          // Final fallback - just try to add and play the current track
          try {
            // Ensure the sourceType property is properly set
            let sourceType = item.sourceType;

            // If sourceType isn't explicitly set, determine it based on the track properties
            if (!sourceType) {
              // Check if it's from MyMusic first
              if (item.isFromMyMusic) {
                sourceType = 'mymusic';
              }
              // Then check if it's a downloaded or local track
              else if (isLocalTrack(item)) {
                sourceType = 'download';
              }
              // If we have a current track, inherit its sourceType as fallback
              else if (currentTrack?.sourceType) {
                sourceType = currentTrack.sourceType;
              }
              // In offline mode, prefer download source type for local tracks
              else if (isOffline && isLocalTrack(item)) {
                sourceType = 'download';
              }
              // Last resort, mark as online
              else {
                sourceType = 'online';
              }
            }

            // Create track with proper source type
            const trackToAdd = {
              ...item,
              sourceType: sourceType,
            };

            await TrackPlayer.reset();
            await TrackPlayer.add([trackToAdd]);
            invalidateQueueSnapshot();
            await TrackPlayer.play();
            setIsPendingAction(false);
            operationInProgressRef.current = false;
            return;
          } catch (finalError) {
            console.error('Final attempt to play track failed:', finalError);
            if (Platform.OS === 'android') {
              ToastAndroid.show('Cannot play this track', ToastAndroid.SHORT);
            }
            setIsPendingAction(false);
            operationInProgressRef.current = false;
            return;
          }
        }
        // Skip to the actual index in the queue
        await SkipToTrack(actualIndex);

        setIsPendingAction(false);
        operationInProgressRef.current = false;
      } catch (error) {
        console.error('Error selecting track:', error);
        setIsPendingAction(false);
        operationInProgressRef.current = false;
      }
    },
    [isLocalTrack, isOffline, filterQueueBySource]
  );

  // Handle drag start
  const handleDragStart = useCallback((params) => {
    try {
      setIsDragging(true);

      // Store the ID of the song being dragged for better tracking
      if (
        params &&
        params.data &&
        params.from >= 0 &&
        params.from < params.data.length
      ) {
        const draggedItem = params.data[params.from];
        if (draggedItem && draggedItem.id) {
          setLastDraggedSongId(draggedItem.id);
        }
      }
    } catch (error) {
      console.error('Error in drag start:', error);
    }
  }, []);

  // Optimized queue reordering using TrackPlayer.move() - no playback interruption
  const handleDragEnd = useCallback(
    async (params) => {
      try {
        const { from, to, data } = params;

        // Skip if positions are the same
        if (from === to) {
          setIsDragging(false);
          return;
        }

        operationInProgressRef.current = true;

        // Filter out duplicates
        const uniqueIds = new Set();
        const uniqueData = data.filter((track) => {
          if (!track.id || uniqueIds.has(track.id)) {
            return false;
          }
          uniqueIds.add(track.id);
          return true;
        });

        // CRITICAL FIX: In DraggableFlatList, `data` is the NEW array after drag
        // - `from` = original index (before drag)
        // - `to` = new index (after drag/where user dropped it)
        // - `data` = reordered array with the item already at its new position
        // So the moved track is at `data[to]`, NOT `data[from]`!
        const movedTrackId = data[to]?.id;
        const movedTrackTitle = data[to]?.title;
        if (!movedTrackId) {
          console.error('Could not identify the moved track');
          setIsDragging(false);
          operationInProgressRef.current = false;
          return;
        }

        // BLOCK moves to position 0 - current track can't be displaced
        if (to === 0) {
          const freshQueue = await TrackPlayer.getQueue();
          const currentTrack = await TrackPlayer.getActiveTrack();
          if (freshQueue && currentTrack) {
            const currentIndex = freshQueue.findIndex(
              (t) => t.id === currentTrack.id
            );
            const upcoming =
              currentIndex >= 0 ? freshQueue.slice(currentIndex) : freshQueue;
            setUpcomingQueue(upcoming);
          }
          setIsDragging(false);
          operationInProgressRef.current = false;
          return;
        }

        // Get the full TrackPlayer queue
        const fullQueue = await TrackPlayer.getQueue();
        if (!fullQueue?.length) {
          console.error('TrackPlayer queue is empty');
          setIsDragging(false);
          operationInProgressRef.current = false;
          return;
        }

        // Find the actual index of the track being moved in TrackPlayer queue
        const actualFromIndex = fullQueue.findIndex(
          (t) => t.id === movedTrackId
        );

        if (actualFromIndex === -1) {
          console.error('Track not found in TrackPlayer queue:', movedTrackId);
          setIsDragging(false);
          operationInProgressRef.current = false;
          return;
        }

        // Get the current track's ACTUAL index in TrackPlayer queue
        const currentTrackTPIndex = await TrackPlayer.getActiveTrackIndex();
        const currentTrackId = currentPlaying?.id;
        // ANCHOR-BASED APPROACH: Find the track that should come AFTER the moved track
        // In the post-drag array (data), the track at position (to + 1) is the anchor
        // We find where this anchor is in TrackPlayer and insert BEFORE it
        let actualToIndex;

        const anchorTrack = uniqueData[to + 1]; // Track that should come AFTER moved track

        if (anchorTrack) {
          // Find anchor position in TrackPlayer
          const anchorIndex = fullQueue.findIndex(
            (t) => t.id === anchorTrack.id
          );

          if (anchorIndex !== -1) {
            // Insert moved track right before the anchor
            // But if we're moving FROM before the anchor, the anchor will shift down by 1
            // after we remove the source track
            if (actualFromIndex < anchorIndex) {
              // Moving forward: after removal, anchor shifts down, so target is anchorIndex - 1
              actualToIndex = anchorIndex - 1;
            } else {
              // Moving backward: anchor doesn't shift, target is anchorIndex
              actualToIndex = anchorIndex;
            }
          } else {
            // Anchor not found - use offset-based fallback
            actualToIndex = currentTrackTPIndex + to;
          }
        } else {
          // Moving to end of visible queue - place after the last visible track
          const lastVisibleTrack = uniqueData[uniqueData.length - 1];
          if (lastVisibleTrack && lastVisibleTrack.id !== movedTrackId) {
            const lastIndex = fullQueue.findIndex(
              (t) => t.id === lastVisibleTrack.id
            );
            if (lastIndex !== -1) {
              // Move to position right after the last track
              if (actualFromIndex <= lastIndex) {
                actualToIndex = lastIndex; // After removal, this becomes the last position
              } else {
                actualToIndex = lastIndex + 1;
              }
            } else {
              actualToIndex = currentTrackTPIndex + to;
            }
          } else {
            // The moved track is the last one - no move needed
            actualToIndex = actualFromIndex;
          }
        }
        // SAFER APPROACH: Use remove() + add() instead of move() for precise control
        // TrackPlayer.move() has inconsistent behavior across platforms
        if (
          actualFromIndex !== -1 &&
          actualToIndex !== -1 &&
          actualFromIndex !== actualToIndex
        ) {
          // Store the track to move
          const trackToMove = fullQueue[actualFromIndex];

          // Step 1: Remove the track from its current position
          await TrackPlayer.remove(actualFromIndex);
          // Step 2: Recalculate insertion index after removal
          // If we removed from BEFORE the target, the target shifts down by 1
          let insertIndex = actualToIndex;
          if (actualFromIndex < actualToIndex) {
            insertIndex = actualToIndex - 1;
          }

          // CRITICAL: Ensure we never insert at position 0 or before current track
          // Position 0 is reserved for the currently playing track
          if (insertIndex <= currentTrackTPIndex) {
            insertIndex = currentTrackTPIndex + 1;
          }

          // Step 3: Add the track at the calculated position
          await TrackPlayer.add(trackToMove, insertIndex);
          invalidateQueueSnapshot();
          // Small delay to let TrackPlayer queue settle
          await new Promise((resolve) => setTimeout(resolve, 150));

          // CRITICAL: Sync visual queue with ACTUAL TrackPlayer queue after move
          const freshQueue = await TrackPlayer.getQueue();
          const currentTrack = await TrackPlayer.getActiveTrack();
          const currentTrackId = currentTrack?.id;
          const newCurrentIndex = freshQueue.findIndex(
            (t) => t.id === currentTrackId
          );
          if (newCurrentIndex === -1) {
            console.error(
              '⚠️ Current track lost after move! This should not happen.'
            );
          }

          // Get tracks from current position onwards
          let syncedUpcoming =
            newCurrentIndex >= 0
              ? freshQueue.slice(newCurrentIndex)
              : freshQueue;

          // EXTRA PROTECTION: Ensure current track is ALWAYS first
          if (
            syncedUpcoming.length > 0 &&
            syncedUpcoming[0]?.id !== currentTrackId
          ) {
            console.warn(
              '⚠️ Current track not first in synced queue, fixing...'
            );
            const currentInSync = syncedUpcoming.findIndex(
              (t) => t.id === currentTrackId
            );
            if (currentInSync > 0) {
              // Move current track to front
              const currTrack = syncedUpcoming.splice(currentInSync, 1)[0];
              syncedUpcoming.unshift(currTrack);
            }
          }

          // Filter out duplicates
          const seenIds = new Set();
          const uniqueSynced = syncedUpcoming.filter((track) => {
            if (!track?.id || seenIds.has(track.id)) {
              return false;
            }
            seenIds.add(track.id);
            return true;
          });

          // DEBUG: Log actual TrackPlayer queue after move to verify correct order
          const first5 = uniqueSynced
            .slice(0, 5)
            .map((t, i) => `${i}: ${t.title?.substring(0, 15)}`);
          // Update UI with the SYNCED order from TrackPlayer
          setUpcomingQueue(uniqueSynced);
        } else {
          // Sync with actual TrackPlayer state
          const freshQueue = await TrackPlayer.getQueue();
          const currentTrack = await TrackPlayer.getActiveTrack();
          if (freshQueue && currentTrack) {
            const currentIndex = freshQueue.findIndex(
              (t) => t.id === currentTrack.id
            );
            const upcoming =
              currentIndex >= 0 ? freshQueue.slice(currentIndex) : freshQueue;
            setUpcomingQueue(upcoming);
          }
        }
        // Trigger prefetch for the new next tracks after reorder
        // IMPORTANT: Use delay to ensure TrackPlayer queue is fully settled
        // SKIP for local sources as they don't need prefetching
        setTimeout(async () => {
          if (isLocalSource) {
            return;
          }

          try {
            const smartPrefetchManager =
              require('../../Utils/SmartPrefetchManager').default;
            // Prefetch N+1 first
            await smartPrefetchManager._prefetchNextFromCurrent();

            // Then prefetch N+2
            const currentIdx = await TrackPlayer.getActiveTrackIndex();
            if (currentIdx !== null && currentIdx !== undefined) {
              await smartPrefetchManager._prefetchTrackAtIndex(currentIdx + 2);
            }
          } catch (prefetchError) {
            // Silence expected errors when queue isn't ready
            if (!prefetchError.message?.includes("doesn't exist")) {
            }
          }
        }, 500); // Wait 500ms for queue to fully settle
      } catch (error) {
        console.error('Error in drag end handler:', error);
      } finally {
        // Always clean up
        // Set skip flag BEFORE changing isDragging to prevent useEffect from re-initializing queue
        skipNextQueueInitRef.current = true;
        setIsDragging(false);
        operationInProgressRef.current = false;
        setLastDraggedSongId(null);

        // Auto-clear the skip flag after a short delay so future track changes work
        setTimeout(() => {
          skipNextQueueInitRef.current = false;
        }, 500);
      }
    },
    [
      isLocalSource,
      isLocalTrack,
      isOffline,
      filterQueueBySource,
      currentPlaying,
    ]
  );

  // Listen for queue-updated event (emitted when songs are added via AddSongsToQueue)
  // This ensures the queue UI refreshes when prefetched/recommended songs are added
  // IMPORTANT: Must be placed after all useCallback hooks to preserve React hooks order
  useEffect(() => {
    const refreshQueue = async () => {
      if (isDragging || operationInProgressRef.current) {
        return;
      }

      try {
        const currentTrack = await TrackPlayer.getActiveTrack();
        if (currentTrack) {
          // CRITICAL FIX: Fetch fresh queue directly from TrackPlayer
          // Context.Queue might be stale due to React state batching when this event fires
          const freshQueue = await getQueueSnapshot(0);
          // Update cache since we just fetched fresh data
          trackPlayerQueueCache.current = freshQueue;
          trackPlayerQueueCacheTime.current = Date.now();
          const filtered = await filterQueueBySource(currentTrack, freshQueue);

          // Filter out duplicates
          const uniqueIds = new Set();
          const uniqueFiltered = filtered.filter((track) => {
            if (!track || !track.id || uniqueIds.has(track.id)) {
              return false;
            }
            uniqueIds.add(track.id);
            return true;
          });

          // Ensure current track is first
          if (currentTrack.id && uniqueFiltered.length > 0) {
            const currentTrackIndex = uniqueFiltered.findIndex(
              (t) => t.id === currentTrack.id
            );
            if (currentTrackIndex > 0) {
              const trackItem = uniqueFiltered.splice(currentTrackIndex, 1)[0];
              uniqueFiltered.unshift(trackItem);
            } else if (currentTrackIndex === -1) {
              uniqueFiltered.unshift(currentTrack);
            }
          }

          setUpcomingQueue(uniqueFiltered);
        }
      } catch (error) {
        console.error('Error refreshing queue on update:', error);
      }
    };

    // Add a small delay to ensure TrackPlayer queue is fully updated
    const handleQueueUpdate = () => {
      setTimeout(refreshQueue, 100);
    };

    const subscription = DeviceEventEmitter.addListener(
      'queue-updated',
      handleQueueUpdate
    );

    return () => {
      subscription.remove();
    };
  }, [isDragging, filterQueueBySource]);

  // Function to enhance track data with high-quality artwork
  const enhanceTrackWithHighQualityArtwork = (track) => {
    if (!track) {
      return track;
    }

    // Clone the track to avoid mutating the original
    const enhancedTrack = { ...track };

    // Helper to check if artwork is valid (not a placeholder)
    const isValidArtwork = (art) => {
      if (!art || typeof art !== 'string') {
        return false;
      }
      if (art.includes('htmlcolorcodes.com') || art.includes('placeholder')) {
        return false;
      }
      return (
        art.startsWith('http') ||
        art.startsWith('file://') ||
        art.startsWith('/') ||
        art.startsWith('data:')
      );
    };

    // For downloaded/local songs, prefer valid artwork from either field
    if (
      track.isDownloaded ||
      track.isLocal ||
      track.sourceType === 'downloaded' ||
      track.sourceType === 'download'
    ) {
      // Check image field first (more likely to have embedded artwork)
      const validArtwork = isValidArtwork(track.image)
        ? track.image
        : isValidArtwork(track.artwork)
        ? track.artwork
        : null;

      if (validArtwork) {
        enhancedTrack.artwork = getHighQualityArtwork(validArtwork);
        enhancedTrack.image = enhancedTrack.artwork; // Sync both fields
      } else {
        // No valid artwork found - set to null so EachSongQueue shows default icon
        enhancedTrack.artwork = null;
        enhancedTrack.image = null;
      }
    } else {
      // For online songs, just enhance the artwork if it exists
      if (isValidArtwork(enhancedTrack.artwork)) {
        enhancedTrack.artwork = getHighQualityArtwork(enhancedTrack.artwork);
      }
    }

    return enhancedTrack;
  };

  // Empty queue state
  if ((!upcomingQueue || upcomingQueue.length === 0) && !isDragging) {
    // Determine message based on current track source type
    let emptyQueueMessage = 'No songs in queue';
    let subMessage = 'Add songs to your queue';

    if (currentPlaying) {
      const sourceType =
        currentPlaying.sourceType ||
        (isLocalTrack(currentPlaying) ? 'download' : 'online');

      if (sourceType === 'mymusic') {
        emptyQueueMessage = 'No more local songs from My Music in queue';
        subMessage = 'Add more songs from My Music to your queue';
      } else if (sourceType === 'download' || isLocalTrack(currentPlaying)) {
        emptyQueueMessage = 'No more downloaded songs in queue';
        subMessage = 'Add more downloaded songs to your queue';
      } else {
        emptyQueueMessage = 'No more online songs in queue';
        subMessage = 'Add more songs from playlists to your queue';
      }
    }

    return (
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: theme.colors.background,
          paddingHorizontal: 20,
        }}
      >
        <Ionicons
          name="musical-notes-outline"
          size={40}
          color={themeMode === 'light' ? '#999' : '#777'}
        />
        <Text
          style={{
            color: theme.colors.text,
            fontSize: 16,
            marginTop: 10,
            textAlign: 'center',
          }}
        >
          {emptyQueueMessage}
        </Text>
        <Text
          style={{
            color: themeMode === 'light' ? '#666' : '#aaa',
            fontSize: 12,
            marginTop: 5,
            textAlign: 'center',
            paddingHorizontal: 20,
          }}
        >
          {subMessage}
        </Text>
      </View>
    );
  }

  const renderFlatListItem = ({ item, index }) => {
    // Enhance the item with high-quality artwork
    const enhancedItem = enhanceTrackWithHighQualityArtwork(item);

    return (
      <EachSongQueue
        title={enhancedItem.title}
        artist={enhancedItem.artist}
        id={enhancedItem.id}
        index={index}
        artwork={enhancedItem.artwork}
        isActive={false}
        onPress={() => handleTrackSelect(enhancedItem, index)}
        songData={enhancedItem}
        onRemoveFromQueue={handleRemoveFromQueue}
        reorderMode={reorderMode}
        playerState={playerState}
        currentPlaying={currentPlaying}
        // Download props - lifted from parent to avoid hook leak
        isDownloaded={downloadStates[enhancedItem.id]?.isDownloaded || false}
        isDownloading={downloadStates[enhancedItem.id]?.isDownloading || false}
        downloadProgress={downloadStates[enhancedItem.id]?.progress || 0}
        onDownloadPress={() => handleDownloadPress(enhancedItem)}
      />
    );
  };

  // When reorder mode is disabled, use a simple list so drag gestures don't activate
  // Also handle the single-item case with the same list to avoid drag errors
  if (!reorderMode || upcomingQueue.length === 1) {
    return (
      <BottomSheetFlatList
        data={upcomingQueue}
        keyExtractor={(item, index) => `${item.id || 'track'}-${index}`}
        renderItem={renderFlatListItem}
        ItemSeparatorComponent={() => (
          <View style={{ height: 1, backgroundColor: themeMode === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)', marginHorizontal: 15 }} />
        )}
        contentContainerStyle={{
          paddingBottom: 100,
          paddingTop: 8,
        }}
        showsVerticalScrollIndicator={false}
      />
    );
  }

  // Render queue with optimized drag support for multiple items
  return (
    <DraggableFlatList
      ref={flatListRef}
      data={upcomingQueue}
      keyExtractor={(item, index) => `${item.id || 'track'}-${index}`}
      onDragBegin={handleDragStart}
      onDragEnd={handleDragEnd}
      ItemSeparatorComponent={() => (
        <View style={{ height: 1, backgroundColor: themeMode === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)', marginHorizontal: 15 }} />
      )}
      contentContainerStyle={{
        paddingBottom: 100,
        paddingTop: 2,
      }}
      showsVerticalScrollIndicator={false}
      activationDistance={10} // Slightly increased for better reliability
      dragHitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }} // Generous touch area
      autoscrollSpeed={250} // Smooth autoscroll speed
      autoscrollThreshold={60} // Comfortable threshold for autoscrolling
      animationConfig={{
        damping: 25, // Smooth, natural damping
        stiffness: 280, // Balanced spring for fluid animations
        mass: 0.8, // Lighter feel for better responsiveness
      }}
      dragItemOverflow={true} // Enable overflow for better visibility
      scrollEnabled={!isDragging} // Disable scrolling during drag
      // PERFORMANCE: Virtualization optimizations for 120+ song queues
      windowSize={7} // Render 7 screens worth of items (3.5 above/below)
      maxToRenderPerBatch={10} // Render 10 items per batch
      updateCellsBatchingPeriod={50} // Batch updates every 50ms
      initialNumToRender={15} // Render first 15 immediately
      removeClippedSubviews={true} // Remove off-screen items from memory
      renderItem={({ item, index, drag, isActive }) => {
        // Enhance the item with high-quality artwork
        const enhancedItem = enhanceTrackWithHighQualityArtwork(item);

        return (
          <ScaleDecorator activeScale={1.0}>
            <EachSongQueue
              title={enhancedItem.title}
              artist={enhancedItem.artist}
              id={enhancedItem.id}
              index={index}
              artwork={enhancedItem.artwork}
              drag={drag}
              isActive={isActive}
              onPress={() => handleTrackSelect(enhancedItem, index)}
              songData={enhancedItem}
              onRemoveFromQueue={handleRemoveFromQueue}
              reorderMode={reorderMode}
              playerState={playerState}
              currentPlaying={currentPlaying}
              // Download props - lifted from parent to avoid hook leak
              isDownloaded={
                downloadStates[enhancedItem.id]?.isDownloaded || false
              }
              isDownloading={
                downloadStates[enhancedItem.id]?.isDownloading || false
              }
              downloadProgress={downloadStates[enhancedItem.id]?.progress || 0}
              onDownloadPress={() => handleDownloadPress(enhancedItem)}
            />
          </ScaleDecorator>
        );
      }}
    />
  );
});

export default QueueRenderSongs;
