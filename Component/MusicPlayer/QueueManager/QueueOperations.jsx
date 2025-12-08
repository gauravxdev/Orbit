import React from 'react';
import TrackPlayer, { State } from 'react-native-track-player';
import { ToastAndroid, Platform } from 'react-native';
import { SkipToTrack } from '../../../MusicPlayerFunctions';

/**
 * QueueOperations - Handles queue operations like track selection, reordering, etc.
 * 
 * This component provides queue operation capabilities including:
 * - Track selection and playback
 * - Queue reordering via drag and drop
 * - Playback state management
 * - Error handling for queue operations
 */

export class QueueOperations {
  constructor(queueManager) {
    this.queueManager = queueManager;
  }

  // Handle track selection from queue
  async handleTrackSelect(item, displayIndex) {
    const {
      operationInProgressRef,
      setIsPendingAction,
      isLocalTrack,
      isOffline
    } = this.queueManager;

    operationInProgressRef.current = true;

    try {
      let wasPlaying = false;
      let position = 0;
      let currentTrack = null;

      try {
        setIsPendingAction(true);
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
      const actualIndex = queue.findIndex(track => track.id === item.id);

      if (actualIndex === -1) {
        console.warn(`Track with ID ${item.id} not found in player queue`);

        if (item.url) {
          console.log('Track has URL but not in queue, adding it to queue');

          let sourceType = item.sourceType;

          if (!sourceType) {
            if (item.isFromMyMusic) {
              sourceType = 'mymusic';
            } else if (isLocalTrack(item)) {
              sourceType = 'download';
            } else if (currentTrack?.sourceType) {
              sourceType = currentTrack.sourceType;
            } else if (isOffline && isLocalTrack(item)) {
              sourceType = 'download';
            } else {
              sourceType = 'online';
            }
          }

          const trackToAdd = {
            ...item,
            sourceType: sourceType
          };

          try {
            const shouldKeepQueue = isOffline ||
              (currentTrack && currentTrack.sourceType === sourceType);

            if (queue.length > 0 && shouldKeepQueue) {
              await TrackPlayer.add([trackToAdd], 0);
              await TrackPlayer.skip(0);
            } else {
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

        // Final fallback
        try {
          let sourceType = item.sourceType;

          if (!sourceType) {
            if (item.isFromMyMusic) {
              sourceType = 'mymusic';
            } else if (isLocalTrack(item)) {
              sourceType = 'download';
            } else if (currentTrack?.sourceType) {
              sourceType = currentTrack.sourceType;
            } else if (isOffline && isLocalTrack(item)) {
              sourceType = 'download';
            } else {
              sourceType = 'online';
            }
          }

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
      await SkipToTrack(actualIndex);

      setIsPendingAction(false);
      operationInProgressRef.current = false;
    } catch (error) {
      console.error('Error selecting track:', error);
      setIsPendingAction(false);
      operationInProgressRef.current = false;
    }
  }

  // Handle drag start
  handleDragStart(params) {
    const { setIsDragging } = this.queueManager;

    try {
      setIsDragging(true);
      console.log('QueueOperations: Drag started');
    } catch (error) {
      console.error('Error in drag start:', error);
    }
  }

  // Handle drag end with queue reordering
  async handleDragEnd(params) {
    const {
      setIsDragging,
      operationInProgressRef,
      setUpcomingQueue,
      filterQueueBySource,
      isLocalTrack,
      isOffline
    } = this.queueManager;

    try {
      const { from, to, data } = params;

      if (from === to) {
        setIsDragging(false);
        return;
      }

      operationInProgressRef.current = true;

      // Filter out duplicates
      const uniqueIds = new Set();
      const uniqueData = data.filter(track => {
        if (!track.id || uniqueIds.has(track.id)) return false;
        uniqueIds.add(track.id);
        return true;
      });

      // Update UI immediately
      setUpcomingQueue(uniqueData);

      const movedTrack = data[to];
      if (!movedTrack || !movedTrack.id) {
        console.error('Could not identify the moved track');
        setIsDragging(false);
        operationInProgressRef.current = false;
        return;
      }

      // Get full queue and current track info
      const fullQueue = await TrackPlayer.getQueue();
      if (!fullQueue || !fullQueue.length) {
        console.error('TrackPlayer queue is empty');
        setIsDragging(false);
        operationInProgressRef.current = false;
        return;
      }

      const currentTrackIndex = await TrackPlayer.getCurrentTrack();
      const currentTrack = currentTrackIndex !== null ? fullQueue[currentTrackIndex] : null;

      console.log('QueueOperations: Reordering queue', {
        from, to,
        movedTrackId: movedTrack.id,
        currentTrackId: currentTrack?.id
      });

      // Save playback state
      let wasPlaying = false;
      let position = 0;

      try {
        if (currentTrack) {
          const playbackState = await TrackPlayer.getState();
          wasPlaying = playbackState === 3;
          position = await TrackPlayer.getPosition() || 0;

          if (wasPlaying) {
            await TrackPlayer.pause();
          }
        }
      } catch (error) {
        console.error('Error saving playback state:', error);
        wasPlaying = true;
      }

      // Reorder queue
      try {
        const oldOrder = data.map(track => track.id);
        const newOrder = [...fullQueue];

        const currentSourceType = currentTrack ?
          (currentTrack.sourceType || (isLocalTrack(currentTrack) ? 'download' : 'online')) :
          null;

        // Sort according to visual order
        newOrder.sort((a, b) => {
          const aSourceType = a.sourceType || (isLocalTrack(a) ? 'download' : 'online');
          const bSourceType = b.sourceType || (isLocalTrack(b) ? 'download' : 'online');

          const aMatchesCurrentSource = aSourceType === currentSourceType;
          const bMatchesCurrentSource = bSourceType === currentSourceType;

          if (!aMatchesCurrentSource || !bMatchesCurrentSource) {
            return 0;
          }

          const aIndex = oldOrder.indexOf(a.id);
          const bIndex = oldOrder.indexOf(b.id);

          if (aIndex === -1 || bIndex === -1) return 0;

          return aIndex - bIndex;
        });

        // Replace entire queue
        await TrackPlayer.reset();
        await TrackPlayer.add(newOrder);

        // Restore playback
        if (currentTrack) {
          const newCurrentIndex = newOrder.findIndex(track => track.id === currentTrack.id);

          if (newCurrentIndex !== -1) {
            await TrackPlayer.skip(newCurrentIndex);

            if (position > 0) {
              try {
                await TrackPlayer.seekTo(position);
              } catch (e) {
                console.warn('Could not seek to position:', e);
              }
            }

            if (wasPlaying) {
              try {
                await TrackPlayer.play();
              } catch (e) {
                console.warn('Could not resume playback:', e);
              }
            }
          }
        }

        // Refresh queue view
        const refreshedTrack = await TrackPlayer.getActiveTrack();
        const refreshedQueue = await filterQueueBySource(refreshedTrack);
        setUpcomingQueue(refreshedQueue);

      } catch (error) {
        console.error('Error during queue repositioning:', error);
      }
    } catch (error) {
      console.error('Error in drag end handler:', error);
    } finally {
      setIsDragging(false);
      operationInProgressRef.current = false;
    }
  }

  // Get high quality artwork URL
  getHighQualityArtwork(artworkUrl) {
    if (!artworkUrl) return null;

    try {
      if (artworkUrl.startsWith('file://')) {
        return artworkUrl;
      }

      if (artworkUrl.includes('saavncdn.com')) {
        return artworkUrl.replace(/50x50|150x150|500x500|1000x1000/g, '1000x1000');
      }

      try {
        const url = new URL(artworkUrl);
        url.searchParams.set('quality', '100');
        return url.toString();
      } catch (e) {
        if (artworkUrl.includes('?')) {
          return `${artworkUrl}&quality=100`;
        } else {
          return `${artworkUrl}?quality=100`;
        }
      }
    } catch (error) {
      console.error('Error processing artwork URL:', error);
      return artworkUrl;
    }
  }

  // Enhance track with high quality artwork
  enhanceTrackWithHighQualityArtwork(track) {
    if (!track) return track;

    const enhancedTrack = { ...track };

    if (enhancedTrack.artwork) {
      enhancedTrack.artwork = this.getHighQualityArtwork(enhancedTrack.artwork);
    }

    return enhancedTrack;
  }
}
