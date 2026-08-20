/**
 * SmartPrefetchManager
 *
 * YOUTUBE MUSIC ONLY - Saavn doesn't need prefetching as it provides direct stream URLs
 *
 * Fixed prefetch strategy that PREVENTS race conditions:
 *
 * 1. Listen for PlaybackState.Playing (not track change)
 * 2. Wait 2 seconds after playback starts
 * 3. Prefetch ONLY the next song (not 3)
 * 4. Handle playback errors with on-demand fetch fallback
 * 5. Cancel prefetch if track changes before completion
 *
 * This ensures tracks are ready BEFORE auto-progression occurs.
 */

import TrackPlayer, { Event, State } from 'react-native-track-player';
import youtubeStreamingService from './YouTubeStreamingService';
import {
  getQueueSnapshot,
  invalidateQueueSnapshot,
} from './QueueSnapshot';
import { InteractionManager, DeviceEventEmitter } from 'react-native';

// Constants for configuration
const PREFETCH_DELAY_MS = 2000; // 2 seconds after playback starts
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes cache TTL
const MAX_RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 200;

class SmartPrefetchManager {
  constructor() {
    // Cache and state management
    this.prefetchedTracks = new Map(); // id -> { url, headers, timestamp }
    this.prefetchInProgress = new Set(); // Currently prefetching IDs

    // Timing control
    this.prefetchTimer = null;
    this.currentTrackIndex = -1;
    this.isInitialized = false;

    // Error handling
    this.errorHandlerRegistered = false;

    // Circuit Breaker (Prevent looping storms)
    this.consecutiveErrors = 0;
    this.lastErrorTimestamp = 0;

    // Recovery lock - prevents queue cleanup during error recovery
    this.isRecovering = false;

    // Abort controller for cancelling in-flight prefetches on skip
    this.prefetchAbortController = null;
  }

  /**
   * Signal shared by all in-flight prefetches, so a skip can actually cancel
   * them. Previously `prefetchAbortController` was never assigned and no fetch
   * received a signal, so "cancelled" prefetches kept running and rewrote the
   * queue mid-skip.
   */
  _getPrefetchSignal() {
    if (!this.prefetchAbortController) {
      this.prefetchAbortController = new AbortController();
    }
    return this.prefetchAbortController.signal;
  }

  /**
   * Cancel all pending prefetch operations (called when user skips)
   */
  cancelAllPrefetches() {
    this._cancelPendingPrefetch();

    if (this.prefetchAbortController) {
      this.prefetchAbortController.abort();
      this.prefetchAbortController = null;
    }
    // The aborted fetches clear their own entries in their finally blocks, but
    // clear eagerly so a fresh prefetch for the same id isn't blocked.
    this.prefetchInProgress.clear();
  }

  // ==========================================
  // INITIALIZATION
  // ==========================================

  /**
   * Initialize the prefetch manager with correct event listeners
   */
  initialize() {
    if (this.isInitialized) {
      return;
    }

    // FIXED: Listen to PlaybackState instead of track change
    TrackPlayer.addEventListener(
      Event.PlaybackState,
      this._handlePlaybackState.bind(this)
    );

    // Listen for track changes to cancel pending prefetches
    TrackPlayer.addEventListener(
      Event.PlaybackActiveTrackChanged,
      this._handleTrackChanged.bind(this)
    );

    // CRITICAL: Listen for playback errors to handle auto-completion failures
    TrackPlayer.addEventListener(
      Event.PlaybackError,
      this._handlePlaybackError.bind(this)
    );

    // NEW: Listen for queue updates to retry prefetch when queue grows
    // This handles the case where prefetch starts before queue is built
    this.queueUpdateListener = DeviceEventEmitter.addListener(
      'queue-updated',
      async () => {
        try {
          const currentIndex = await TrackPlayer.getActiveTrackIndex();
          if (currentIndex === undefined) {
            return;
          }

          // PERFORMANCE: Use getTrack() instead of getQueue() - avoids serializing 120+ tracks
          const nextTrack = await TrackPlayer.getTrack(currentIndex + 1);

          // If we have a next track and haven't prefetched it yet, do it now
          if (
            nextTrack &&
            this.needsStream(nextTrack) &&
            !this.prefetchedTracks.has(nextTrack.id)
          ) {
            await this._prefetchTrackAtIndex(currentIndex + 1);

            // Also try N+2
            const next2Track = await TrackPlayer.getTrack(currentIndex + 2);
            if (
              next2Track &&
              this.needsStream(next2Track) &&
              !this.prefetchedTracks.has(next2Track.id)
            ) {
              await this._prefetchTrackAtIndex(currentIndex + 2);
            }
          }
        } catch (e) {
          // Silently ignore errors during retry
        }
      }
    );

    this.isInitialized = true;
    this.errorHandlerRegistered = true;
  }

  // ==========================================
  // EVENT HANDLERS
  // ==========================================

  /**
   * Handle playback state changes
   * Triggers prefetch 2 seconds after playback starts
   */
  /**
   * Handle playback state changes
   * Triggers N+2 prefetch 2 seconds after playback starts
   */
  async _handlePlaybackState(event) {
    if (event.state === State.Playing) {
      // Check if current track is a YouTube Music track (by source, not by stream status)
      // We always want to prefetch next tracks for YTMusic, even if current track is ready
      const currentTrack = await TrackPlayer.getActiveTrack();
      if (!currentTrack) {
        return;
      }

      // FIXED: Identify Saavn and Local songs explicitly
      const isSaavn =
        currentTrack.source === 'saavn' ||
        (currentTrack.id &&
          currentTrack.id.length !== 11 &&
          !currentTrack.isLocalMusic &&
          !currentTrack.source);

      const isLocal =
        currentTrack.isLocalMusic ||
        currentTrack.isDownloaded ||
        currentTrack.sourceType === 'download' ||
        currentTrack.sourceType === 'mymusic' ||
        (currentTrack.url &&
          (currentTrack.url.startsWith('file://') ||
            currentTrack.url.includes('/storage/')));

      if (isSaavn || isLocal) {
        return;
      }

      // Check if it's YouTube Music source - always prefetch for YT tracks
      const isYTMusic =
        currentTrack.source === 'ytmusic' ||
        currentTrack.isYTMusic === true ||
        (currentTrack.id &&
          currentTrack.id.length === 11 &&
          !currentTrack.isLocalMusic);

      if (!isYTMusic) {
        // Silently skip - not a YouTube Music track
        return;
      }

      // Get current track index
      const currentIndex = await TrackPlayer.getActiveTrackIndex();

      // Cancel any pending prefetch
      this._cancelPendingPrefetch();

      // Store current index for validation
      this.currentTrackIndex = currentIndex;

      // Wait 2 seconds, then prefetch ONLY N+1 (Next song)
      // Simple and reliable - avoids bridge saturation
      this.prefetchTimer = setTimeout(async () => {
        // Validate we're still on the same track
        const nowPlaying = await TrackPlayer.getActiveTrackIndex();
        if (nowPlaying === this.currentTrackIndex) {
          this._prefetchTrackAtIndex(nowPlaying + 1).catch((err) => {
            // Only log real errors, not expected ones like 'track doesn't exist'
            if (
              !err.message?.includes("doesn't exist") &&
              !err.message?.includes('Invalid index')
            ) {
              console.log('Prefetch error:', err.message);
            }
          });
        }
      }, PREFETCH_DELAY_MS);
    }
  }

  /**
   * Handle track changes - cancel pending prefetch
   */
  /**
   * Handle track changes - IMMEDIATE N+1, N+2, N+3 prefetch + queue cleanup
   * PERFORMANCE FIX: Deferred with InteractionManager to prevent UI lag
   */
  _handleTrackChanged(event) {
    // Get track from event
    const track = event.track;

    // We want to prefetch NEXT tracks for ALL streaming sources
    // Even if current track is resolved, next tracks may need prefetch
    // So we check by source type, not by whether current track needs streaming

    let shouldPrefetch = false;
    let detectedSource = 'unknown';

    if (track) {
      // YTMusic tracks (including resolved ones with valid URLs)
      const isYTMusic =
        track.source === 'ytmusic' ||
        track.isYTMusic === true ||
        (track.id &&
          typeof track.id === 'string' &&
          track.id.length === 11 &&
          !track.isLocalMusic);

      // Spotify tracks (even after resolution, source stays 'spotify')
      const isSpotify =
        track.source === 'spotify' ||
        track.spotifyId ||
        track.mappedFromSpotify;

      // DAB tracks
      const isDab = track.source === 'dab' || track.isDabTrack;

      // Saavn tracks
      const isSaavn =
        track.source === 'saavn' ||
        (track.id &&
          typeof track.id === 'string' &&
          track.id.length !== 11 &&
          !track.isLocalMusic &&
          !track.source);

      // Local tracks
      const isLocal =
        track.isLocalMusic ||
        track.isDownloaded ||
        track.sourceType === 'download' ||
        track.sourceType === 'mymusic' ||
        (track.url &&
          (track.url.startsWith('file://') || track.url.includes('/storage/')));

      shouldPrefetch = isYTMusic && !isSaavn && !isLocal;
      detectedSource = isLocal
        ? 'local'
        : isYTMusic
        ? 'ytmusic'
        : isSpotify
        ? 'spotify'
        : isDab
        ? 'dab'
        : isSaavn
        ? 'saavn'
        : 'other';
    } else {
      // No track in event - try to check queue directly
      // This can happen in some edge cases
      shouldPrefetch = true; // Optimistically try to prefetch
    }

    if (event.index !== undefined && event.index !== null && shouldPrefetch) {
      this._cancelPendingPrefetch();

      // PERFORMANCE FIX: Defer heavy operations to prevent UI lag during playback start
      InteractionManager.runAfterInteractions(() => {
        this._handleTrackChangedAsync(event).catch((err) =>
          console.error('SmartPrefetch: Background handler error:', err)
        );
      });
    }
  }

  /**
   * Async handler for track changed - contains the heavy lifting
   * Runs in background via InteractionManager
   * @private
   *
   * PERFORMANCE: Uses parallel prefetch for Spotify playlists (search+stream = 2 calls/track)
   */
  async _handleTrackChangedAsync(event) {
    let effectiveIndex = event.index;

    // 🧹 QUEUE CLEANUP: Remove old tracks, keep only 5 previous
    // CRITICAL: Skip cleanup if we're in recovery mode to prevent index shifts
    if (!this.isRecovering) {
      effectiveIndex = await this._cleanupOldTracks(event.index);
    }

    this.currentTrackIndex = effectiveIndex;

    // Get current index and check if next track is Spotify
    // PERFORMANCE: Use getTrack() instead of getQueue() - avoids serializing 120+ tracks
    const currentIdx = await TrackPlayer.getActiveTrackIndex();
    const nextTrack = await TrackPlayer.getTrack(currentIdx + 1);

    // Detect Spotify playlist (each track needs search + stream fetch)
    const isSpotifyPlaylist =
      nextTrack &&
      (nextTrack.source === 'spotify' ||
        nextTrack.spotifyId ||
        nextTrack._needsSpotifyMapping ||
        nextTrack.url?.startsWith('spotify://'));

    if (isSpotifyPlaylist) {
      // 🚀 PARALLEL PREFETCH for Spotify: N+1 and N+2 simultaneously
      // This reduces total prefetch time from ~4s to ~2s (2 network calls per track)
      Promise.all([
        this._prefetchTrackAtIndex(currentIdx + 1).catch(() => null),
        this._prefetchTrackAtIndex(currentIdx + 2).catch(() => null),
        currentIdx > 0
          ? this._prefetchTrackAtIndex(currentIdx - 1).catch(() => null)
          : Promise.resolve(null),
      ]).then(() => {
        // Parallel prefetch complete
      });
    } else {
      // 🎵 SEQUENTIAL PREFETCH: N+1 first, then N+2 after N+1 completes
      // IMPORTANT: Use dynamic index lookup to handle queue rearrangement
      try {
        await this._prefetchNextFromCurrent();

        // Only after N+1 completes, start N+2 and N-1 (non-blocking).
        // N-1 matters: nothing used to prefetch backwards, so pressing
        // previous on a YTMusic queue always paid a full resolve.
        setImmediate(async () => {
          try {
            // Get FRESH current index - queue may have been rearranged
            const freshIdx = await TrackPlayer.getActiveTrackIndex();
            if (freshIdx !== null && freshIdx !== undefined) {
              await this._prefetchTrackAtIndex(freshIdx + 2);
              if (freshIdx > 0) {
                await this._prefetchTrackAtIndex(freshIdx - 1);
              }
            }
          } catch (err) {
            // Silence expected errors
          }
        });
      } catch (err) {
        // Silence expected errors
      }
    }
  }

  /**
   * Prefetch the next song relative to CURRENT playing position
   * Uses fresh index lookup to handle queue rearrangement
   */
  async _prefetchNextFromCurrent() {
    const currentIdx = await TrackPlayer.getActiveTrackIndex();
    if (currentIdx !== null && currentIdx !== undefined) {
      await this._prefetchTrackAtIndex(currentIdx + 1);
    }
  }

  /**
   * CRITICAL: Handle playback errors for auto-completion failures
   * This is the key fix - when TrackPlayer fails on placeholder URL,
   * we fetch on-demand and retry playback
   */
  async _handlePlaybackError(event) {
    const now = Date.now();

    // DIAGNOSTICS: the event carries the real reason. Without this every
    // failure looked identical in the logs, whether it was a 403 from
    // googlevideo (missing PO token), a network drop, or a codec problem.
    const errCode = event?.code || 'unknown';
    const errMessage = event?.message || '';
    console.log(
      `PlaybackError [${errCode}] ${errMessage} (consecutive: ${
        this.consecutiveErrors + 1
      })`
    );

    // Circuit Breaker Reset (if error was long ago)
    if (now - this.lastErrorTimestamp > 5000) {
      this.consecutiveErrors = 0;
    }

    this.lastErrorTimestamp = now;
    this.consecutiveErrors++;

    // A 403/401 from googlevideo means the URL itself was rejected - the
    // resolver that produced it can't be trusted for the retry.
    const isHttpRejection =
      /bad-http-status|403|401|Forbidden|Unauthorized/i.test(
        `${errCode} ${errMessage}`
      );

    // STOP if looping too fast (Max 3 retries in 5 seconds)
    if (this.consecutiveErrors > 3) {
      await TrackPlayer.pause();
      this.consecutiveErrors = 0;
      this.isRecovering = false;
      return;
    }

    // Set recovery lock to prevent queue cleanup during recovery
    this.isRecovering = true;

    try {
      const currentTrack = await TrackPlayer.getActiveTrack();

      if (!currentTrack) {
        this.isRecovering = false;
        return;
      }

      // Which resolver produced the URL that just failed? Retry with the other
      // one - re-running the same resolver just returns the same dead link.
      const retryOptions = isHttpRejection
        ? {
            forceRefresh: true,
            preferStrategy:
              currentTrack._resolvedBy === 'native' ? 'innertube' : 'native',
          }
        : {};

      // Check if track needs stream (has placeholder URL)
      if (this.needsStream(currentTrack)) {
        // Fetch stream on-demand - pass the track so we skip a queue scan
        const streamData = await this.fetchOnDemand(
          currentTrack.id,
          null,
          currentTrack,
          retryOptions
        );

        if (streamData && streamData.url) {
          // Replace current track with valid URL using ID-based lookup
          await this._replaceAndPlayTrackById(currentTrack, streamData);
          this.consecutiveErrors = 0; // Reset on success
        } else {
          // Failed to get stream - skip to next
          await this._skipToNextValidTrackById(currentTrack.id);
        }
      } else if (this.isStreamingSource(currentTrack)) {
        // URL looked valid but playback still failed (expired CDN URL is the
        // usual cause). Drop the stale cache entries - both ours and the
        // shared stream cache, otherwise the re-resolve just hands back the
        // same dead URL. Guarded to streaming sources so local/downloaded
        // files are never sent through a network resolver.
        this.prefetchedTracks.delete(currentTrack.id);
        try {
          const { CacheManager } = require('./NavigationCacheManager');
          CacheManager.invalidateStreamUrl(
            currentTrack.id,
            currentTrack.source === 'dab' ? 'dab' : 'ytmusic'
          );
        } catch (e) {}
        const streamData = await this.fetchOnDemand(
          currentTrack.id,
          null,
          currentTrack,
          { forceRefresh: true, ...retryOptions }
        );
        if (streamData && streamData.url) {
          await this._replaceAndPlayTrackById(currentTrack, streamData);
          this.consecutiveErrors = 0;
        }
      }
    } catch (error) {
      console.error('❌ Error in playback error handler:', error.message);
    } finally {
      // Release recovery lock after a delay to let queue stabilize
      setTimeout(() => {
        this.isRecovering = false;
      }, 250);
    }
  }

  // ==========================================
  // PREFETCH OPERATIONS
  // ==========================================

  /**
   * Prefetch ONLY the next song (not multiple)
   */
  async _prefetchNextSong(currentIndex) {
    const nextIndex = currentIndex + 1;
    await this._prefetchTrackAtIndex(nextIndex);
  }

  /**
   * Prefetch a single track by queue index
   */
  async _prefetchTrackAtIndex(index) {
    let trackId = null; // Track ID for cleanup in finally block

    try {
      if (index < 0) {
        return;
      }

      // PERFORMANCE: getTrack() is authoritative here. The old getQueue()
      // fallback serialized the entire queue over the bridge just to discover
      // the index didn't exist yet - the common case during lazy loading.
      const track = await TrackPlayer.getTrack(index);
      if (!track) {
        return;
      }

      trackId = track.id; // Capture ID for finally block

      // Skip if not a YouTube track or already has valid URL
      if (!this.needsStream(track)) {
        return;
      }

      // Skip if already prefetched and not expired
      const cached = this.getPrefetchedStream(track.id);
      if (cached) {
        // Still replace in queue if needed
        await this._replaceTrackInQueue(index, track, cached);
        return;
      }

      // Skip if already prefetching this track
      if (this.prefetchInProgress.has(track.id)) {
        return;
      }

      this.prefetchInProgress.add(track.id);


      let streamData = null;

      // SPOTIFY HANDLING: Map to YTMusic first, then get stream
      if (
        track.source === 'spotify' ||
        track.spotifyId ||
        track._needsSpotifyMapping ||
        track.url?.startsWith('spotify://')
      ) {
        try {
          const YouTubeMusicService = require('./YouTubeMusicService').default;
          const ytMusicResult = await YouTubeMusicService.searchAndStream(
            track.title || track.name,
            track.artist || ''
          );

          if (ytMusicResult && ytMusicResult.url && !ytMusicResult.error) {
            streamData = {
              url: ytMusicResult.url,
              headers: ytMusicResult.headers,
              videoId: ytMusicResult.videoId,
              mappedFromSpotify: true,
            };
          } else {
            console.error(
              `❌ Failed to map Spotify track to YTMusic: ${track.title}`
            );
          }
        } catch (error) {
          console.error(
            `❌ Spotify mapping error for prefetch: ${error.message}`
          );
        }
      }
      // DAB HANDLING: Get DAB stream
      else if (
        track.source === 'dab' ||
        track.isDabTrack ||
        track._needsDabStream ||
        track.url?.startsWith('dab://')
      ) {
        try {
          const dabMusicService = require('./DabMusicService').default;
          await dabMusicService.initialize();
          const dabStreamUrl = await dabMusicService.getStreamUrl(track.id);

          if (dabStreamUrl) {
            streamData = {
              url: dabStreamUrl,
              headers: {},
            };
          }
        } catch (error) {
          console.error(`❌ DAB stream error for prefetch: ${error.message}`);
        }
      }
      // YTMUSIC HANDLING: Standard YouTube stream fetch
      else {
        streamData = await youtubeStreamingService.getStreamUrl(
          track.id,
          false,
          this._getPrefetchSignal()
        );
      }

      if (streamData && streamData.url) {
        // Store prefetched data
        this._cacheStream(track.id, streamData);

        // NON-BLOCKING: Defer queue replacement to avoid blocking UI
        // Use setImmediate to run after current call stack clears
        setImmediate(async () => {
          try {
            // PERFORMANCE: Try optimized index check first
            const trackAtIndex = await TrackPlayer.getTrack(index);

            // If track ID matches, we can proceed directly
            if (trackAtIndex && trackAtIndex.id === track.id) {
              if (this.needsStream(trackAtIndex)) {
                await this._replaceTrackInQueue(index, track, streamData);
              }
              return;
            }

            // Fallback: queue may have shifted - locate by ID
            const currentIndex = await this._findTrackIndexById(track.id);
            if (currentIndex !== -1) {
              const shifted = await TrackPlayer.getTrack(currentIndex);
              if (shifted && this.needsStream(shifted)) {
                await this._replaceTrackInQueue(currentIndex, track, streamData);
              }
            }
          } catch (e) {
            // Queue replacement failed
          }
        });
      }
    } catch (error) {
      // Aborts are expected whenever the user skips - not worth logging.
      if (error.name !== 'AbortError' && error.message !== 'AbortError') {
        console.error(`Prefetch failed for index ${index}:`, error.message);
      }
    } finally {
      // Clean up in-progress set only if trackId was set
      if (trackId) {
        this.prefetchInProgress.delete(trackId);
      }
    }
  }

  // ==========================================
  // QUEUE OPERATIONS
  // ==========================================

  /**
   * Replace a track and WAIT for completion (for manual skips)
   * SAFE: Verifies track ID before replacing to handle queue rearrangement
   */
  async replaceTrackAndWait(index, originalTrack, streamData) {
    try {
      // PERFORMANCE: Optimistic check - try TrackPlayer.getTrack(index) first
      // This avoids serializing the entire queue (O(N)) over the bridge
      let actualIndex = index;
      let trackAtIndex = await TrackPlayer.getTrack(index);

      // Check if track at index matches our ID
      if (!trackAtIndex || trackAtIndex.id !== originalTrack.id) {
        const resolved = await this._findTrackIndexById(originalTrack.id);
        if (resolved === -1) {
          return;
        }
        actualIndex = resolved;
        trackAtIndex = await TrackPlayer.getTrack(actualIndex);
      }

      // Skip if already has valid URL (already replaced)
      if (!trackAtIndex || !this.needsStream(trackAtIndex)) {
        return;
      }

      // SAFETY: never rewrite the entry that is currently playing here -
      // removing the active item restarts playback. Error recovery owns that
      // case via _replaceAndPlayTrackById().
      const activeIndex = await TrackPlayer.getActiveTrackIndex();
      if (activeIndex === actualIndex) {
        return;
      }

      const updatedTrack = this._createUpdatedTrack(originalTrack, streamData);

      // Insert the resolved copy first, then drop the placeholder. Doing it in
      // this order means the queue is never missing the entry, so a concurrent
      // skip can't land on a hole.
      await TrackPlayer.add(updatedTrack, actualIndex);
      await TrackPlayer.remove(actualIndex + 1);
      invalidateQueueSnapshot();
    } catch (error) {
      console.error('Error replacing track:', error.message);
    }
  }

  /**
   * Find a queue index by track id without serializing the whole queue.
   * Scans the window around the active track first (where skips happen), and
   * only falls back to a full getQueue() if that misses.
   */
  async _findTrackIndexById(trackId) {
    try {
      const activeIndex = await TrackPlayer.getActiveTrackIndex();
      if (activeIndex !== undefined && activeIndex !== null) {
        for (const offset of [0, 1, -1, 2, -2, 3, -3]) {
          const idx = activeIndex + offset;
          if (idx < 0) {
            continue;
          }
          const candidate = await TrackPlayer.getTrack(idx);
          if (candidate && candidate.id === trackId) {
            return idx;
          }
        }
      }

      const queue = await getQueueSnapshot();
      return queue.findIndex((t) => t.id === trackId);
    } catch (e) {
      return -1;
    }
  }

  /**
   * Replace a track in queue with updated URL
   * CRITICAL FIX: MUST await completion to prevent playback errors
   */
  async _replaceTrackInQueue(index, originalTrack, streamData) {
    // WAIT for replacement to complete - this is CRITICAL
    // Previous fire-and-forget caused race conditions where player
    // would advance to tracks before their URLs were updated
    await this.replaceTrackAndWait(index, originalTrack, streamData);
  }

  /**
   * Replace CURRENT track and restart playback (for error recovery)
   * @deprecated Use _replaceAndPlayTrackById instead for race-condition safety
   */
  async _replaceAndPlayTrack(index, originalTrack, streamData) {
    // Delegate to ID-based method for safety
    await this._replaceAndPlayTrackById(originalTrack, streamData);
  }

  /**
   * Replace track by ID and restart playback (race-condition safe)
   * Finds track by ID instead of relying on index which may shift
   */
  async _replaceAndPlayTrackById(originalTrack, streamData) {
    try {
      // Find track by ID - this is stable even if queue indices shift
      const currentIndex = await this._findTrackIndexById(originalTrack.id);

      if (currentIndex === -1) {
        console.warn('⚠️ Track no longer in queue:', originalTrack.id);
        // Track was removed - try to play whatever is current
        await TrackPlayer.play();
        return;
      }

      const updatedTrack = this._createUpdatedTrack(originalTrack, streamData);

      // Remove old track and insert new one at same position
      await TrackPlayer.remove(currentIndex);
      await TrackPlayer.add(updatedTrack, currentIndex);
      invalidateQueueSnapshot();

      // Skip to it and play
      await TrackPlayer.skip(currentIndex);
      await TrackPlayer.play();
    } catch (error) {
      console.error('Error in replaceAndPlayTrackById:', error.message);
      // Last resort - try to just play
      try {
        await TrackPlayer.play();
      } catch (e) {
        console.error('Failed to resume playback:', e.message);
      }
    }
  }

  /**
   * Skip to next valid track when current one fails completely
   * @deprecated Use _skipToNextValidTrackById instead
   */
  async _skipToNextValidTrack(failedIndex) {
    // Find track ID at that index first
    try {
      const failedTrack = await TrackPlayer.getTrack(failedIndex);
      if (failedTrack) {
        await this._skipToNextValidTrackById(failedTrack.id);
      }
    } catch (e) {
      console.error('Error in legacy skipToNextValidTrack:', e.message);
    }
  }

  /**
   * Skip to next valid track when current one fails completely (ID-based)
   */
  async _skipToNextValidTrackById(failedTrackId) {
    try {
      // Find the failed track by ID
      const failedIndex = await this._findTrackIndexById(failedTrackId);

      if (failedIndex === -1) {
        // Track already removed - just try to play current
        await TrackPlayer.play();
        return;
      }

      // Remove the failed track
      await TrackPlayer.remove(failedIndex);
      invalidateQueueSnapshot();

      // Get new queue state
      const newQueue = await getQueueSnapshot(0);

      if (newQueue.length === 0) {
        await TrackPlayer.stop();
        return;
      }

      // Try to play the next track (now at same index or first)
      const nextIndex = Math.min(failedIndex, newQueue.length - 1);
      const nextTrack = newQueue[nextIndex];

      if (nextTrack && this.needsStream(nextTrack)) {
        // Fetch stream on-demand for next track
        const streamData = await this.fetchOnDemand(
          nextTrack.id,
          null,
          nextTrack
        );
        if (streamData && streamData.url) {
          await this._replaceAndPlayTrackById(nextTrack, streamData);
          return;
        }
      }

      // Just try to skip and play
      await TrackPlayer.skip(nextIndex);
      await TrackPlayer.play();
    } catch (error) {
      console.error('Error skipping to next valid track:', error.message);
      // Last resort
      try {
        await TrackPlayer.play();
      } catch (e) {}
    }
  }

  // ==========================================
  // UTILITY METHODS
  // ==========================================

  /**
   * Create updated track object with stream data
   */
  _createUpdatedTrack(originalTrack, streamData) {
    return {
      ...originalTrack,
      url: streamData.url,
      headers: streamData.headers,
      userAgent: streamData.headers?.['User-Agent'],
      _needsStream: false,
      _prefetched: true,
      // Remember which resolver produced this URL so error recovery can
      // fail over to the other one instead of retrying the same path.
      _resolvedBy: streamData.resolvedBy || originalTrack._resolvedBy || null,
      // Store videoId for history tracking (enables playback from history)
      videoId: streamData.videoId || originalTrack.videoId,
      // Track if this was mapped from Spotify (for history)
      mappedFromSpotify:
        streamData.mappedFromSpotify || originalTrack.mappedFromSpotify,
      spotifyId:
        originalTrack.spotifyId ||
        (originalTrack.source === 'spotify' ? originalTrack.id : null),
    };
  }

  /**
   * True when a track's audio comes from a remote resolver (YTMusic / Spotify
   * mapping / DAB) rather than a local file or a direct CDN url.
   */
  isStreamingSource(track) {
    if (!track) {
      return false;
    }

    const isLocal =
      track.isLocalMusic ||
      track.isDownloaded ||
      track.sourceType === 'download' ||
      track.sourceType === 'mymusic' ||
      (track.url &&
        (track.url.startsWith('file://') || track.url.includes('/storage/')));

    if (isLocal || track.source === 'saavn') {
      return false;
    }

    return (
      track.source === 'ytmusic' ||
      track.source === 'spotify' ||
      track.source === 'dab' ||
      track.isYTMusic === true ||
      track.isDabTrack === true ||
      !!track.spotifyId ||
      (typeof track.id === 'string' && track.id.length === 11)
    );
  }

  /**
   * Check if track needs stream fetching
   */
  needsStream(track) {
    if (!track) {
      return false;
    }

    // Explicit flags take priority (set by AddSongsToQueue, AutoRecommendations)
    if (track._prefetched === true) {
      return false;
    }
    if (track._needsStream === true) {
      return true;
    }

    // Check if it's a YouTube track needing stream
    // Check multiple indicators: ID length, isYTMusic flag, source property
    const hasYouTubeIdFormat =
      track.id &&
      typeof track.id === 'string' &&
      track.id.length === 11 &&
      !track.isLocalMusic;
    const hasYTMusicFlag = track.isYTMusic === true;
    const hasYTMusicSource = track.source === 'ytmusic';

    const isYTMusic = hasYouTubeIdFormat || hasYTMusicFlag || hasYTMusicSource;

    // SPOTIFY SUPPORT: Check if it's a Spotify track needing mapping to YTMusic
    const isSpotify =
      track.source === 'spotify' ||
      track.spotifyId ||
      track._needsSpotifyMapping;

    // DAB SUPPORT: Check if it's a DAB track needing stream
    const isDab =
      track.source === 'dab' || track.isDabTrack || track._needsDabStream;

    // SAAVN AND LOCAL EXCLUSION: Explicitly check for Saavn and local sources
    const isSaavn =
      track.source === 'saavn' ||
      (!track.source &&
        track.id &&
        track.id.length !== 11 &&
        !track.isLocalMusic);
    const isLocal =
      track.isLocalMusic ||
      track.isDownloaded ||
      track.sourceType === 'download' ||
      track.sourceType === 'mymusic' ||
      (track.url &&
        (track.url.startsWith('file://') || track.url.includes('/storage/')));

    if (isSaavn || isLocal || (!isYTMusic && !isSpotify && !isDab)) {
      return false;
    }

    // Check if URL is placeholder or missing
    const url = track.url || '';
    return (
      !url ||
      url.startsWith('ytmusic://') ||
      url.startsWith('spotify://') ||
      url.startsWith('dab://') ||
      url.includes('music.youtube.com')
    );
  }

  /**
   * Cancel pending prefetch timer
   */
  _cancelPendingPrefetch() {
    if (this.prefetchTimer) {
      clearTimeout(this.prefetchTimer);
      this.prefetchTimer = null;
    }
  }

  /**
   * 🧹 QUEUE CLEANUP: Remove old tracks to save memory and prevent queue bloat
   * Keeps only 5 previous songs before current track
   */
  async _cleanupOldTracks(currentIndex) {
    try {
      // Only cleanup if we have more than 5 songs before current
      if (currentIndex <= 5) {
        return currentIndex;
      }

      const tracksToRemove = currentIndex - 5;

      // Remove tracks from the beginning of the queue
      const removeIndices = [];
      for (let i = 0; i < tracksToRemove; i++) {
        removeIndices.push(i);
      }

      if (removeIndices.length > 0) {
        await TrackPlayer.remove(removeIndices);
        invalidateQueueSnapshot();

        // Update current track index after removal
        this.currentTrackIndex = 5; // After cleanup, current is always at index 5

        return 5;
      }
      return currentIndex;
    } catch (error) {
      console.error('Queue cleanup error:', error.message);
      return currentIndex;
    }
  }

  // ==========================================
  // CACHE OPERATIONS
  // ==========================================

  /**
   * Cache stream data
   */
  _cacheStream(trackId, streamData) {
    this.prefetchedTracks.set(trackId, {
      url: streamData.url,
      headers: streamData.headers,
      timestamp: Date.now(),
    });
  }

  /**
   * Get prefetched stream for a track
   */
  getPrefetchedStream(trackId) {
    const cached = this.prefetchedTracks.get(trackId);
    if (!cached) {
      return null;
    }

    // Check if expired
    if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
      this.prefetchedTracks.delete(trackId);
      return null;
    }

    return cached;
  }

  /**
   * On-demand fetch for random song selection (with retry)
   * Handles Spotify (maps to YTMusic) and DAB tracks
   */
  async fetchOnDemand(trackId, signal = null, knownTrack = null, options = {}) {
    // Check prefetch cache first - unless the caller is explicitly retrying
    // after a failure, in which case the cached entry is the bad one.
    if (!options.forceRefresh) {
      const cached = this.getPrefetchedStream(trackId);
      if (cached) {
        return cached;
      }
    } else {
      this.prefetchedTracks.delete(trackId);
    }

    // Determine the source. PERFORMANCE: prefer a track handed to us by the
    // caller - looking it up used to call getQueue(), serializing the entire
    // queue over the bridge on every on-demand fetch.
    let track = knownTrack;
    if (!track) {
      try {
        const activeTrack = await TrackPlayer.getActiveTrack();
        if (activeTrack && activeTrack.id === trackId) {
          track = activeTrack;
        } else {
          const activeIndex = await TrackPlayer.getActiveTrackIndex();
          if (activeIndex !== undefined && activeIndex !== null) {
            // Manual skips only ever target immediate neighbours.
            for (const offset of [1, -1, 2, -2]) {
              const candidate = await TrackPlayer.getTrack(
                activeIndex + offset
              );
              if (candidate && candidate.id === trackId) {
                track = candidate;
                break;
              }
            }
          }
        }
      } catch (e) {
        // ignore - we fall back to the YTMusic path below
      }
    }

    // Fetch with retry
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      if (signal?.aborted) {
        throw new Error('AbortError');
      }

      try {
        let streamData = null;

        // SPOTIFY HANDLING: Map to YTMusic first
        if (
          track &&
          (track.source === 'spotify' ||
            track.spotifyId ||
            track._needsSpotifyMapping ||
            track.url?.startsWith('spotify://'))
        ) {
          const YouTubeMusicService = require('./YouTubeMusicService').default;
          const ytMusicResult = await YouTubeMusicService.searchAndStream(
            track.title || track.name,
            track.artist || ''
          );

          if (ytMusicResult && ytMusicResult.url && !ytMusicResult.error) {
            streamData = {
              url: ytMusicResult.url,
              headers: ytMusicResult.headers,
              videoId: ytMusicResult.videoId,
              mappedFromSpotify: true,
            };
          }
        }
        // DAB HANDLING: Get DAB stream
        else if (
          track &&
          (track.source === 'dab' ||
            track.isDabTrack ||
            track._needsDabStream ||
            track.url?.startsWith('dab://'))
        ) {
          const dabMusicService = require('./DabMusicService').default;
          await dabMusicService.initialize();
          const dabStreamUrl = await dabMusicService.getStreamUrl(trackId);

          if (dabStreamUrl) {
            streamData = {
              url: dabStreamUrl,
              headers: {},
            };
          }
        }
        // YTMUSIC HANDLING: Standard YouTube stream fetch
        else {
          streamData = await youtubeStreamingService.getStreamUrl(
            trackId,
            false,
            signal,
            options
          );
        }

        if (streamData && streamData.url) {
          // Cache it
          this._cacheStream(trackId, streamData);
          return streamData;
        }
      } catch (error) {
        if (error.name === 'AbortError' || error.message === 'AbortError') {
          throw error;
        }

        console.warn(`On-demand attempt ${attempt} failed:`, error.message);

        if (attempt < MAX_RETRY_ATTEMPTS) {
          // Wait before retry
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }

    console.error(
      `On-demand fetch failed after ${MAX_RETRY_ATTEMPTS} attempts: ${trackId}`
    );
    return null;
  }

  /**
   * Clear all prefetched data
   */
  clearCache() {
    this._cancelPendingPrefetch();
    this.prefetchedTracks.clear();
    this.prefetchInProgress.clear();
    this.currentTrackIndex = -1;
  }
}

// Singleton instance
const smartPrefetchManager = new SmartPrefetchManager();

export default smartPrefetchManager;
