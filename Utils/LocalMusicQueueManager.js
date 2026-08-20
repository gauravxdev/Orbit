/**
 * LocalMusicQueueManager.js
 *
 * A lightweight queue manager specifically designed for local music playback.
 * Implements progressive loading to prevent UI lag when playing from large libraries (200+ songs).
 *
 * Key Features:
 * - Loads initial batch (20 songs) for instant playback
 * - Progressively adds more songs as user approaches end of loaded queue
 * - Cleans up old tracks to maintain optimal memory usage
 * - Supports circular playlist behavior
 */

import TrackPlayer, { Event } from 'react-native-track-player';
import { getQueueLength, invalidateQueueSnapshot } from './QueueSnapshot';
import { InteractionManager, DeviceEventEmitter } from 'react-native';

// Configuration constants
const INITIAL_BATCH_SIZE = 20; // First batch for instant playback
const BACKGROUND_BATCH_SIZE = 15; // Subsequent batches
const LOAD_THRESHOLD = 5; // Load more when 5 songs from end of loaded queue
const CLEANUP_THRESHOLD = 30; // Keep max 30 tracks behind current position
const BATCH_DELAY_MS = 30; // Small delay between operations for UI responsiveness

class LocalMusicQueueManager {
  constructor() {
    this.allSongs = []; // Full list of all local songs
    this.loadedStartIndex = 0; // Start index in allSongs of loaded tracks
    this.loadedEndIndex = 0; // End index in allSongs of loaded tracks
    this.isLoading = false; // Prevent concurrent batch loads
    this.trackChangeListener = null; // Event listener reference
    this.isActive = false; // Whether progressive loading is active
    this.startOffset = 0; // Original start index when initialized
  }

  /**
   * Format a local song for TrackPlayer
   * @param {Object} song - Local song object
   * @returns {Object} Formatted track object
   */
  _formatTrack(song) {
    if (!song || !song.path) {
      return null;
    }

    return {
      id: song.id,
      url: song.url || `file://${song.path}`,
      title: this._formatTitle(song.title),
      artist: this._formatArtist(song.artist),
      artwork: this._getArtwork(song),
      isLocal: true,
      sourceType: 'mymusic',
      duration: song.duration || 0,
    };
  }

  _formatTitle(title) {
    if (!title) {
      return 'Unknown Title';
    }
    let formatted = title.replace(/\.(mp3|m4a|wav|ogg|flac)$/i, '');
    return formatted.length > 50
      ? formatted.substring(0, 50) + '...'
      : formatted;
  }

  _formatArtist(artist) {
    if (!artist) {
      return 'Unknown Artist';
    }
    let formatted = artist.replace(/\.(mp3|m4a|wav|ogg|flac)$/i, '');
    return formatted.length > 50
      ? formatted.substring(0, 50) + '...'
      : formatted;
  }

  _getArtwork(song) {
    if (song.cover && typeof song.cover === 'object' && song.cover.uri) {
      return song.cover;
    }
    if (song.artwork && typeof song.artwork === 'object' && song.artwork.uri) {
      return song.artwork;
    }
    // Return default cover - will be resolved by component
    return null;
  }

  /**
   * Initialize progressive queue loading for local music
   * @param {Array} songs - Full array of local songs
   * @param {number} startIndex - Index of the song to start playing
   * @returns {Object} { initialBatch, success }
   */
  async initialize(songs, startIndex = 0) {
    // Cleanup any existing state
    this.cleanup();

    if (!songs || songs.length === 0) {
      return { initialBatch: [], success: false };
    }

    // Filter to only valid songs with paths
    const validSongs = songs.filter((song) => song && song.path);

    if (validSongs.length === 0) {
      return { initialBatch: [], success: false };
    }

    // Reorder songs: starting from startIndex, wrapping around to beginning
    this.allSongs = [
      ...validSongs.slice(startIndex),
      ...validSongs.slice(0, startIndex),
    ];
    this.startOffset = startIndex;
    this.isActive = true;

    // Calculate initial batch size
    const initialSize = Math.min(INITIAL_BATCH_SIZE, this.allSongs.length);

    // Process initial batch
    const initialBatch = [];
    for (let i = 0; i < initialSize; i++) {
      const formatted = this._formatTrack(this.allSongs[i]);
      if (formatted) {
        initialBatch.push(formatted);
      }
    }

    this.loadedStartIndex = 0;
    this.loadedEndIndex = initialBatch.length;

    // Setup track change listener for threshold-based loading
    this._setupTrackChangeListener();

    return {
      initialBatch,
      success: true,
      hasMore: this.loadedEndIndex < this.allSongs.length,
    };
  }

  /**
   * Setup listener for track changes to trigger batch loading and cleanup
   */
  _setupTrackChangeListener() {
    // Remove any existing listener
    if (this.trackChangeListener) {
      this.trackChangeListener.remove();
    }

    this.trackChangeListener = TrackPlayer.addEventListener(
      Event.PlaybackActiveTrackChanged,
      async (event) => {
        if (!this.isActive) {
          return;
        }

        const currentIndex = event.index;
        if (currentIndex === undefined || currentIndex === null) {
          return;
        }

        // Check if we need to load more songs (approaching end of loaded queue)
        const queueLength = await getQueueLength();
        const remainingLoaded = queueLength - currentIndex - 1;

        if (
          remainingLoaded <= LOAD_THRESHOLD &&
          this.loadedEndIndex < this.allSongs.length
        ) {
          await this._loadNextBatch();
        }

        // Check if we need to cleanup old tracks
        if (currentIndex > CLEANUP_THRESHOLD) {
          await this._cleanupOldTracks(currentIndex);
        }
      }
    );
  }

  /**
   * Load the next batch of songs
   */
  async _loadNextBatch() {
    if (
      this.isLoading ||
      !this.isActive ||
      this.loadedEndIndex >= this.allSongs.length
    ) {
      return;
    }

    this.isLoading = true;

    try {
      // Use InteractionManager to avoid blocking UI
      await new Promise((resolve) => {
        InteractionManager.runAfterInteractions(() => resolve());
      });

      // Calculate batch range
      const batchStart = this.loadedEndIndex;
      const batchEnd = Math.min(
        batchStart + BACKGROUND_BATCH_SIZE,
        this.allSongs.length
      );

      // Small delay for UI responsiveness
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));

      // Process batch
      const batch = [];
      for (let i = batchStart; i < batchEnd; i++) {
        const formatted = this._formatTrack(this.allSongs[i]);
        if (formatted) {
          batch.push(formatted);
        }
      }

      if (batch.length > 0) {
        await TrackPlayer.add(batch);
        invalidateQueueSnapshot();
        this.loadedEndIndex = batchEnd;

        // Emit event for UI updates
        DeviceEventEmitter.emit('queue-updated', {
          count: this.loadedEndIndex,
          total: this.allSongs.length,
          isLocalMusic: true,
        });
      }
    } catch (error) {
      console.error(
        '❌ LocalMusicQueueManager: Error loading batch:',
        error.message
      );
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Cleanup old tracks that are far behind current position
   * @param {number} currentIndex - Current track index in player queue
   */
  async _cleanupOldTracks(currentIndex) {
    if (!this.isActive) {
      return;
    }

    try {
      // Only cleanup if we have enough tracks behind us
      const tracksToRemove = currentIndex - CLEANUP_THRESHOLD;

      if (tracksToRemove > 0) {
        // Remove tracks from the beginning of the queue
        const indicesToRemove = [];
        for (let i = 0; i < Math.min(tracksToRemove, 10); i++) {
          indicesToRemove.push(i);
        }

        if (indicesToRemove.length > 0) {
          // Remove in reverse order to maintain indices
          for (let i = indicesToRemove.length - 1; i >= 0; i--) {
            await TrackPlayer.remove(indicesToRemove[i]);
            invalidateQueueSnapshot();
          }

          this.loadedStartIndex += indicesToRemove.length;
        }
      }
    } catch (error) {
      console.error(
        '❌ LocalMusicQueueManager: Error cleaning up:',
        error.message
      );
    }
  }

  /**
   * Get current loading status
   */
  getStatus() {
    return {
      isActive: this.isActive,
      loadedCount: this.loadedEndIndex - this.loadedStartIndex,
      totalCount: this.allSongs.length,
      isLoading: this.isLoading,
      progress:
        this.allSongs.length > 0
          ? this.loadedEndIndex / this.allSongs.length
          : 0,
    };
  }

  /**
   * Cleanup and reset state
   */
  cleanup() {
    if (this.trackChangeListener) {
      this.trackChangeListener.remove();
      this.trackChangeListener = null;
    }

    this.allSongs = [];
    this.loadedStartIndex = 0;
    this.loadedEndIndex = 0;
    this.isLoading = false;
    this.isActive = false;
    this.startOffset = 0;
  }
}

// Export singleton instance
export default new LocalMusicQueueManager();
