import React, { useContext, useEffect, useState, memo, useCallback, useRef } from "react";
import { View, Text, Platform, ToastAndroid } from "react-native";
import { EachSongQueue } from "./EachSongQueue";
import { BottomSheetFlatList } from "@gorhom/bottom-sheet";
import Context from "../../Context/Context";
import { useActiveTrack, usePlaybackState, useTrackPlayerEvents, Event, State } from "react-native-track-player";
import TrackPlayer from "react-native-track-player";
import Ionicons from "react-native-vector-icons/Ionicons";
import DraggableFlatList, { ScaleDecorator } from "react-native-draggable-flatlist";
import { SkipToTrack } from "../../MusicPlayerFunctions";
import NetInfo from "@react-native-community/netinfo";
import { StorageManager } from '../../Utils/StorageManager';
import { useThemeContext } from "../../Context/ThemeContext";
import { debounce, deduplicateEventHandler } from '../../Utils/EventDebouncer';

// Function to get high quality artwork URL
const getHighQualityArtwork = (artworkUrl) => {
  if (!artworkUrl) return null;

  try {
    // For local files, return as is
    if (artworkUrl.startsWith('file://')) {
      return artworkUrl;
    }

    // Special handling for JioSaavn CDN
    if (artworkUrl.includes('saavncdn.com')) {
      // Replace any size with 1000x1000 for highest quality
      return artworkUrl.replace(/50x50|150x150|500x500|1000x1000/g, '1000x1000');
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
  const { Queue } = useContext(Context);
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

  // Check network status on component mount
  useEffect(() => {
    const checkNetworkStatus = async () => {
      try {
        const networkState = await NetInfo.fetch();
        setIsOffline(!(networkState.isConnected && networkState.isInternetReachable));
      } catch (error) {
        console.error('Error checking network status:', error);
        // Default to online if we can't determine
        setIsOffline(false);
      }
    };

    checkNetworkStatus();

    // Subscribe to network changes
    const unsubscribe = NetInfo.addEventListener(state => {
      setIsOffline(!(state.isConnected && state.isInternetReachable));
    });

    return () => unsubscribe();
  }, []);

  // More robust check for local tracks
  const isLocalTrack = (track) => {
    if (!track) return false;
    return Boolean(
      track.isLocalMusic ||
      track.isLocal ||
      track.isDownloaded ||
      track.path ||
      (track.url && (
        track.url.startsWith('file://') ||
        track.url.includes('content://') ||
        track.url.includes('/storage/')
      ))
    );
  };

  // Function to get all downloaded tracks
  const getDownloadedTracks = async () => {
    try {
      // Get all downloaded song metadata
      const allMetadata = await StorageManager.getAllDownloadedSongsMetadata();

      if (!allMetadata || Object.keys(allMetadata).length === 0) {
        console.log('No downloaded songs metadata found in queue');
        return [];
      }

      // Format tracks with metadata
      return await Promise.all(Object.values(allMetadata).map(async metadata => {
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
          sourceType: 'download'
        };
      }));
    } catch (error) {
      console.error('Error getting downloaded tracks:', error);
      return [];
    }
  };

  // Function to filter queue based on track source with offline support
  const filterQueueBySource = useCallback(async (currentTrack) => {
    try {
      if (!currentTrack) return [];

      // Always get downloaded tracks to have ready (regardless of offline status)
      const downloadedTracks = await getDownloadedTracks();
      console.log(`Found ${downloadedTracks.length} downloaded tracks for queue`);

      // Check if the current track has a sourceType (mymusic or download)
      const sourceType = (currentTrack.sourceType || (isLocalTrack(currentTrack) ? 'download' : 'online'))?.toString?.().toLowerCase();
      console.log('Current track source type:', sourceType);

      // If playing a track from MyMusic, only show MyMusic tracks in the queue
      if (sourceType === 'mymusic') {
        console.log('Playing from MyMusic - showing only MyMusic tracks in queue');

        // Get the full queue from TrackPlayer which should contain all MyMusic tracks
        const fullQueue = await TrackPlayer.getQueue();

        // Filter to only include tracks from MyMusic source, regardless of online/offline status
        const myMusicTracks = fullQueue.filter(track => track.sourceType === 'mymusic');

        // If no MyMusic tracks found, just show the current track
        if (myMusicTracks.length === 0) {
          return [currentTrack];
        }

        // Put current track first
        const rearrangedTracks = [
          currentTrack,
          ...myMusicTracks.filter(track => track.id !== currentTrack.id)
        ];

        setIsLocalSource(true);
        return rearrangedTracks;
      }

      // If playing a downloaded track
      // Treat both 'download' and legacy 'downloaded' as downloaded source
      if (sourceType === 'download' || sourceType === 'downloaded' || (isLocalTrack(currentTrack) && !currentTrack.sourceType)) {
        console.log('Playing downloaded track - showing all downloaded tracks in queue');

        // Always use downloaded tracks in offline mode or when explicitly playing downloaded music
        // Get full queue but filter for downloaded tracks only
        const fullQueue = await TrackPlayer.getQueue();

        // Filter to only include downloaded tracks
        const downloadSourceTracks = fullQueue.filter(track =>
          (track.sourceType && String(track.sourceType).toLowerCase() === 'download') ||
          (track.sourceType && String(track.sourceType).toLowerCase() === 'downloaded') ||
          (isLocalTrack(track) && !track.sourceType)
        );

        // If no downloaded tracks found in queue, merge with downloaded tracks from storage
        let combinedTracks = downloadSourceTracks.length > 0 ? downloadSourceTracks : [];

        // Add any downloaded tracks not already in the queue
        if (downloadedTracks.length > 0) {
          const existingIds = new Set(combinedTracks.map(t => t.id));
          const additionalDownloads = downloadedTracks.filter(t => !existingIds.has(t.id));
          combinedTracks = [...combinedTracks, ...additionalDownloads];
        }

        // If still empty, at least show current track
        if (combinedTracks.length === 0) {
          combinedTracks = [currentTrack];
        } else {
          // Put current track first if it exists in the combined tracks
          const currentTrackIndex = combinedTracks.findIndex(t => t.id === currentTrack.id);
          if (currentTrackIndex > 0) {
            const currentTrackItem = combinedTracks.splice(currentTrackIndex, 1)[0];
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
        // Get the full queue from TrackPlayer
        const fullQueue = await TrackPlayer.getQueue();

        if (fullQueue.length === 0) {
          console.log('TrackPlayer queue is empty, using current track');
          return [currentTrack];
        }

        // Filter to only include online tracks (neither mymusic nor download source type)
        const onlineTracks = fullQueue.filter(track =>
          (!track.sourceType || (track.sourceType && String(track.sourceType).toLowerCase() === 'online')) && !isLocalTrack(track)
        );

        // Put current track first if it exists in the online tracks
        if (onlineTracks.length > 0) {
          const currentTrackIndex = onlineTracks.findIndex(t => t.id === currentTrack.id);
          if (currentTrackIndex > 0) {
            const currentTrackItem = onlineTracks.splice(currentTrackIndex, 1)[0];
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
        console.log('In offline mode with non-local track - showing downloaded tracks as fallback');

        // If we have downloaded tracks, show them
        if (downloadedTracks.length > 0) {
          return [currentTrack, ...downloadedTracks.filter(t => t.id !== currentTrack.id)];
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
  }, [isLocalTrack, isOffline, getDownloadedTracks]);

  // Debounce reference to prevent excessive updates
  const lastTrackUpdateRef = useRef(0);
  const TRACK_UPDATE_DEBOUNCE = 300; // 300ms debounce

  // Track change listener to update the queue - DEBOUNCED
  useTrackPlayerEvents([Event.PlaybackTrackChanged], async (event) => {
    // Skip if dragging or operation in progress
    if (isDragging || operationInProgressRef.current) return;

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
          setCurrentIndex(index || 0);

          // Get the source type for the current track
          const sourceType = track.sourceType || (isLocalTrack(track) ? 'download' : 'online');
          console.log('Track changed - source type:', sourceType);
          console.log('Track changed - offline mode:', isOffline);

          // Log track details for debugging
          console.log('New track details:', {
            id: track.id,
            title: track.title,
            sourceType: sourceType,
            isLocal: isLocalTrack(track),
            url: track.url ? (typeof track.url === 'string' ? track.url.substring(0, 30) + '...' : 'non-string-url') : 'no-url'
          });

          // Update local source flag based on source type
          setIsLocalSource(sourceType === 'mymusic' || sourceType === 'download' || isLocalTrack(track));

          // Filter the queue based on source type
          const filtered = await filterQueueBySource(track);

          // Log filtered queue size
          console.log(`Track changed - filtered queue contains ${filtered.length} tracks`);
          if (filtered.length > 0) {
            // Log source types in filtered queue for debugging
            const sourceTypes = {};
            filtered.forEach(track => {
              const trackSourceType = track.sourceType || (isLocalTrack(track) ? 'download' : 'online');
              sourceTypes[trackSourceType] = (sourceTypes[trackSourceType] || 0) + 1;
            });
            console.log('Track changed - queue source types:', sourceTypes);
          }

          // Filter out duplicate songs based on ID
          const uniqueIds = new Set();
          const uniqueFiltered = filtered.filter(track => {
            if (!track || !track.id || uniqueIds.has(track.id)) return false;
            uniqueIds.add(track.id);
            return true;
          });

          // Ensure current track is always first
          if (track.id && uniqueFiltered.length > 0) {
            const currentTrackIndex = uniqueFiltered.findIndex(t => t.id === track.id);

            // If current track isn't first and exists in the queue
            if (currentTrackIndex > 0) {
              // Move current track to the beginning
              const currentTrack = uniqueFiltered.splice(currentTrackIndex, 1)[0];
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
  });

  // Initialize queue when component mounts or current track changes
  useEffect(() => {
    const initializeQueue = async () => {
      if (isDragging || operationInProgressRef.current) return; // Don't update during operations

      try {
        if (currentPlaying) {
          // Get the source type for the current track
          const sourceType = currentPlaying.sourceType || (isLocalTrack(currentPlaying) ? 'download' : 'online');
          console.log('Initializing queue - current source type:', sourceType);
          console.log('Network status - offline mode:', isOffline);

          // Log more details about the current track for debugging
          console.log('Current track details:', {
            id: currentPlaying.id,
            title: currentPlaying.title,
            sourceType: sourceType,
            isLocal: isLocalTrack(currentPlaying),
            url: currentPlaying.url ? (typeof currentPlaying.url === 'string' ? currentPlaying.url.substring(0, 30) + '...' : 'non-string-url') : 'no-url'
          });

          // Update local source flag based on source type
          setIsLocalSource(sourceType === 'mymusic' || sourceType === 'download' || isLocalTrack(currentPlaying));

          // Always ensure we have the latest downloaded tracks
          await getDownloadedTracks();

          // Filter queue based on current track's source type
          const filtered = await filterQueueBySource(currentPlaying);

          // Log filtered queue size
          console.log(`Filtered queue contains ${filtered.length} tracks`);
          if (filtered.length > 0) {
            // Log source types in filtered queue for debugging
            const sourceTypes = {};
            filtered.forEach(track => {
              const trackSourceType = track.sourceType || (isLocalTrack(track) ? 'download' : 'online');
              sourceTypes[trackSourceType] = (sourceTypes[trackSourceType] || 0) + 1;
            });
            console.log('Queue source type distribution:', sourceTypes);
          }

          // Filter out duplicate songs based on ID
          const uniqueIds = new Set();
          const uniqueFiltered = filtered.filter(track => {
            if (!track || !track.id || uniqueIds.has(track.id)) return false;
            uniqueIds.add(track.id);
            return true;
          });

          // Ensure current track is always first
          if (currentPlaying.id && uniqueFiltered.length > 0) {
            const currentTrackIndex = uniqueFiltered.findIndex(t => t.id === currentPlaying.id);

            // If current track isn't first and exists in the queue
            if (currentTrackIndex > 0) {
              // Move current track to the beginning
              const currentTrack = uniqueFiltered.splice(currentTrackIndex, 1)[0];
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
        if (args.some(arg =>
          typeof arg === 'string' && (
            arg.includes('Error getting playlist') ||
            arg.includes('Network Error') ||
            arg.includes('Network request failed')
          )
        )) {
          // Just log a simpler message instead
          console.log('Suppressed playlist/network error');
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
  }, [currentPlaying, isDragging, isOffline]);

  // Function to handle removing track from queue (used by swipe gesture)
  const handleRemoveFromQueue = async (displayIndex, trackId) => {
    operationInProgressRef.current = true;
    try {
      // Get the full TrackPlayer queue
      const queue = await TrackPlayer.getQueue();

      // Find the track in the actual queue by ID
      const actualIndex = queue.findIndex(track => track.id === trackId);

      if (actualIndex === -1) {
        operationInProgressRef.current = false;
        return;
      }

      // Check if we're removing the currently playing track
      const currentIndex = await TrackPlayer.getCurrentTrack();
      const isCurrentTrack = actualIndex === currentIndex;

      if (isCurrentTrack && queue.length > 1) {
        // If removing current track and there are other tracks, skip to next
        if (actualIndex < queue.length - 1) {
          await TrackPlayer.skipToNext();
        } else {
          await TrackPlayer.skipToPrevious();
        }
      }

      // Remove the track from the queue
      await TrackPlayer.remove(actualIndex);

      // If this was the only track, stop playback
      if (queue.length === 1) {
        await TrackPlayer.stop();
      }

      // Update the queue display
      const currentTrack = await TrackPlayer.getActiveTrack();
      if (currentTrack) {
        const filtered = await filterQueueBySource(currentTrack);
        const uniqueIds = new Set();
        const uniqueFiltered = filtered.filter(track => {
          if (!track || !track.id || uniqueIds.has(track.id)) return false;
          uniqueIds.add(track.id);
          return true;
        });
        setUpcomingQueue(uniqueFiltered);
      } else {
        setUpcomingQueue([]);
      }

    } catch (error) {
      console.error('Error removing track from queue:', error);
    } finally {
      operationInProgressRef.current = false;
    }
  };

  // Function to handle track selection from the queue
  const handleTrackSelect = async (item, displayIndex) => {
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
          console.log('Selected currently playing track - toggle playback');
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
      const actualIndex = queue.findIndex(track => track.id === item.id);

      if (actualIndex === -1) {
        console.warn(`Track with ID ${item.id} not found in player queue`);

        // If the track isn't in the queue but we want to play it anyway
        if (item.url) {
          console.log('Track has URL but not in queue, adding it to queue');

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
            sourceType: sourceType
          };

          // Try to add it to the queue and play it
          try {
            // In offline mode or when the source type matches the current track, 
            // keep the existing queue as much as possible
            const shouldKeepQueue = isOffline ||
              (currentTrack && currentTrack.sourceType === sourceType);

            if (queue.length > 0 && shouldKeepQueue) {
              await TrackPlayer.add([trackToAdd], 0); // Add at beginning
              await TrackPlayer.skip(0); // Skip to our new track
            } else {
              // Reset the queue if the source types are different
              await TrackPlayer.reset();
              await TrackPlayer.add([trackToAdd]);
            }
            await TrackPlayer.play();
            setIsPendingAction(false);
            operationInProgressRef.current = false;
            return;
          } catch (err) {
            console.error('Error adding track to queue:', err);
            if (Platform.OS === 'android') {
              ToastAndroid.show('Could not play this track', ToastAndroid.SHORT);
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
            sourceType: sourceType
          };

          await TrackPlayer.reset();
          await TrackPlayer.add([trackToAdd]);
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

      console.log(`Selected track "${item.title}" at queue index ${actualIndex}`);

      // Skip to the actual index in the queue
      await SkipToTrack(actualIndex);

      setIsPendingAction(false);
      operationInProgressRef.current = false;
    } catch (error) {
      console.error('Error selecting track:', error);
      setIsPendingAction(false);
      operationInProgressRef.current = false;
    }
  };

  // Handle drag start
  const handleDragStart = useCallback((params) => {
    try {
      setIsDragging(true);

      // Store the ID of the song being dragged for better tracking
      if (params && params.data && params.from >= 0 && params.from < params.data.length) {
        const draggedItem = params.data[params.from];
        if (draggedItem && draggedItem.id) {
          setLastDraggedSongId(draggedItem.id);
        }
      }
    } catch (error) {
      console.error('Error in drag start:', error);
    }
  }, []);

  // Complete rewrite of the queue repositioning system using IDs not indices
  const handleDragEnd = useCallback(async (params) => {
    try {
      // Destructure params
      const { from, to, data } = params;

      // Skip if positions are the same
      if (from === to) {
        setIsDragging(false);
        return;
      }

      // Set operation flag to prevent interference
      operationInProgressRef.current = true;

      // Filter out any duplicates that might have been created during dragging
      const uniqueIds = new Set();
      const uniqueData = data.filter(track => {
        if (!track.id || uniqueIds.has(track.id)) return false;
        uniqueIds.add(track.id);
        return true;
      });

      // Update UI immediately for responsiveness
      setUpcomingQueue(uniqueData);

      // Get the track being moved
      const movedTrack = data[to];
      if (!movedTrack || !movedTrack.id) {
        console.error('Could not identify the moved track');
        setIsDragging(false);
        operationInProgressRef.current = false;
        return;
      }

      // Get the full queue from TrackPlayer
      const fullQueue = await TrackPlayer.getQueue();
      if (!fullQueue || !fullQueue.length) {
        console.error('TrackPlayer queue is empty');
        setIsDragging(false);
        operationInProgressRef.current = false;
        return;
      }

      // Get currently playing track information and save it
      const currentTrackIndex = await TrackPlayer.getCurrentTrack();
      const currentTrack = currentTrackIndex !== null ? fullQueue[currentTrackIndex] : null;

      // Log current state for debugging
      console.log('Drag operation info:', {
        isOffline,
        moveFrom: from,
        moveTo: to,
        currentTrackIndex,
        movedTrackId: movedTrack.id,
        movedTrackTitle: movedTrack.title,
        currentTrackId: currentTrack?.id,
        currentTrackTitle: currentTrack?.title
      });

      // Check if the current track remains in the queue
      const currentTrackStillInQueue = currentTrack && data.some(track => track.id === currentTrack.id);

      // Check if current track is being moved - important to know for playback
      const isCurrentTrackBeingMoved = currentTrack && currentTrack.id === movedTrack.id;

      // MORE ROBUST: Store current state with explicit state checks
      let wasPlaying = false;
      let position = 0;

      try {
        // Check for playback state more thoroughly
        if (currentTrackStillInQueue) {
          // Get state using two methods for redundancy
          const playbackState = await TrackPlayer.getState();
          const playerState = await TrackPlayer.getPlaybackState();

          // Check if either indicates playing (3 = playing in both APIs)
          wasPlaying = playbackState === 3 || (playerState && playerState.state === 3);

          // Double-check through the state name if available
          if (playerState && playerState.state && !wasPlaying) {
            wasPlaying = playerState.state === 'playing' || playerState.state === 'ready';
          }

          // Get current position with error handling
          try {
            position = await TrackPlayer.getPosition() || 0;
          } catch (e) {
            console.warn('Could not get position:', e);
            position = 0;
          }

          // Pause if playing - we'll resume after queue manipulation
          if (wasPlaying) {
            await TrackPlayer.pause();
          }
        }
      } catch (error) {
        console.error('Error saving playback state:', error);
        // Default to assuming it was playing if we can't determine
        wasPlaying = true;
      }

      // APPROACH: Create a new queue with the right order and replace entire queue
      try {
        // 1. Map visual indices to track IDs
        const oldOrder = data.map(track => track.id);

        // 2. Create new array with same tracks but in the new order
        const newOrder = [...fullQueue];

        // Get the current track's source type for filtering
        const currentSourceType = currentTrack ?
          (currentTrack.sourceType || (isLocalTrack(currentTrack) ? 'download' : 'online')) :
          null;

        // Log the source type we're using for filtering
        console.log('Drag reordering using sourceType:', currentSourceType);

        // 3. Sort the full queue according to the visual order
        newOrder.sort((a, b) => {
          // Get source types with fallback
          const aSourceType = a.sourceType || (isLocalTrack(a) ? 'download' : 'online');
          const bSourceType = b.sourceType || (isLocalTrack(b) ? 'download' : 'online');

          // Only reorder tracks that match the current track's source type
          const aMatchesCurrentSource = aSourceType === currentSourceType;
          const bMatchesCurrentSource = bSourceType === currentSourceType;

          // Don't reorder tracks of different source types
          if (!aMatchesCurrentSource || !bMatchesCurrentSource) {
            return 0;
          }

          // Now get the indexes in our visual queue for matching tracks
          const aIndex = oldOrder.indexOf(a.id);
          const bIndex = oldOrder.indexOf(b.id);

          // If we can't find one in our order, leave it where it is
          if (aIndex === -1 || bIndex === -1) return 0;

          // Otherwise sort by the visual order
          return aIndex - bIndex;
        });

        // 4. Replace the entire queue with our reordered queue
        await TrackPlayer.reset(); // Clear the queue
        await TrackPlayer.add(newOrder); // Add all tracks in the new order

        // 5. Resume playback of the proper track
        if (currentTrackStillInQueue) {
          // Find where the previously playing track is now
          const newCurrentIndex = newOrder.findIndex(track => track.id === currentTrack.id);

          if (newCurrentIndex !== -1) {
            // Skip to the track that was playing before
            await TrackPlayer.skip(newCurrentIndex);

            // Restore position with safety check
            if (position > 0) {
              try {
                await TrackPlayer.seekTo(position);
              } catch (e) {
                console.warn('Could not seek to position:', e);
              }
            }

            // Enhanced playback restoration with multiple attempts
            if (wasPlaying) {
              // First attempt immediately
              try {
                await TrackPlayer.play();
              } catch (e) {
                console.warn('First play attempt failed, trying again:', e);

                // Second attempt with delay
                setTimeout(async () => {
                  try {
                    const state = await TrackPlayer.getState();
                    // Only play if not already playing
                    if (state !== 3) {
                      await TrackPlayer.play();
                    }
                  } catch (error) {
                    console.error('Failed to resume playback on second attempt:', error);

                    // Final attempt with longer delay
                    setTimeout(async () => {
                      try {
                        await TrackPlayer.play();
                      } catch (finalError) {
                        console.error('All playback restoration attempts failed:', finalError);
                      }
                    }, 500);
                  }
                }, 300);
              }
            }
          }
        }

        // 6. Update our filtered view
        const refreshedTrack = await TrackPlayer.getActiveTrack();
        console.log('Refreshing queue after drag with active track:', refreshedTrack?.title);
        const refreshedQueue = await filterQueueBySource(refreshedTrack);

        // Log the refreshed queue for debugging
        console.log(`Drag completed - refreshed queue contains ${refreshedQueue.length} tracks`);
        if (refreshedQueue.length > 0) {
          const sourceTypes = {};
          refreshedQueue.forEach(track => {
            const trackSourceType = track.sourceType || (isLocalTrack(track) ? 'download' : 'online');
            sourceTypes[trackSourceType] = (sourceTypes[trackSourceType] || 0) + 1;
          });
          console.log('Refreshed queue source types:', sourceTypes);
        }

        setUpcomingQueue(refreshedQueue);
      } catch (error) {
        console.error('Error during queue repositioning:', error);

        // Attempt emergency playback restoration if everything fails
        if (wasPlaying && currentTrack) {
          setTimeout(async () => {
            try {
              // Try to find and play the track that was playing before
              const recovery = await TrackPlayer.getQueue();
              const recoveryIndex = recovery.findIndex(t => t.id === currentTrack.id);
              if (recoveryIndex >= 0) {
                await TrackPlayer.skip(recoveryIndex);
                await TrackPlayer.play();
              }
            } catch (e) {
              console.error('Emergency playback restoration failed:', e);
            }
          }, 800);
        }
      }
    } catch (error) {
      console.error('Error in drag end handler:', error);
    } finally {
      // Always clean up
      setIsDragging(false);
      operationInProgressRef.current = false;
      setLastDraggedSongId(null);
    }
  }, [isLocalSource, isLocalTrack, isOffline, filterQueueBySource]);

  // Function to enhance track data with high-quality artwork
  const enhanceTrackWithHighQualityArtwork = (track) => {
    if (!track) return track;

    // Clone the track to avoid mutating the original
    const enhancedTrack = { ...track };

    // Enhance the artwork if it exists
    if (enhancedTrack.artwork) {
      enhancedTrack.artwork = getHighQualityArtwork(enhancedTrack.artwork);
    }

    return enhancedTrack;
  };

  // Empty queue state
  if ((!upcomingQueue || upcomingQueue.length === 0) && !isDragging) {
    // Determine message based on current track source type
    let emptyQueueMessage = "No songs in queue";
    let subMessage = "Add songs to your queue";

    if (currentPlaying) {
      const sourceType = currentPlaying.sourceType || (isLocalTrack(currentPlaying) ? 'download' : 'online');

      if (sourceType === 'mymusic') {
        emptyQueueMessage = "No more local songs from My Music in queue";
        subMessage = "Add more songs from My Music to your queue";
      } else if (sourceType === 'download' || isLocalTrack(currentPlaying)) {
        emptyQueueMessage = "No more downloaded songs in queue";
        subMessage = "Add more downloaded songs to your queue";
      } else {
        emptyQueueMessage = "No more online songs in queue";
        subMessage = "Add more songs from playlists to your queue";
      }
    }

    return (
      <View style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.background,
        paddingHorizontal: 20
      }}>
        <Ionicons
          name="musical-notes-outline"
          size={40}
          color={themeMode === 'light' ? '#999' : '#777'}
        />
        <Text style={{
          color: theme.colors.text,
          fontSize: 16,
          marginTop: 10,
          textAlign: 'center'
        }}>
          {emptyQueueMessage}
        </Text>
        <Text style={{
          color: themeMode === 'light' ? '#666' : '#aaa',
          fontSize: 12,
          marginTop: 5,
          textAlign: 'center',
          paddingHorizontal: 20
        }}>
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
      contentContainerStyle={{
        paddingBottom: 100,
        paddingTop: 8,
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
            />
          </ScaleDecorator>
        );
      }}
    />
  );
});

export default QueueRenderSongs;
