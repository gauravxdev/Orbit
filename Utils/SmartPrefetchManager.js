/**
 * SmartPrefetchManager
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
    }

    // ==========================================
    // INITIALIZATION
    // ==========================================

    /**
     * Initialize the prefetch manager with correct event listeners
     */
    initialize() {
        if (this.isInitialized) return;

        // FIXED: Listen to PlaybackState instead of track change
        TrackPlayer.addEventListener(Event.PlaybackState, this._handlePlaybackState.bind(this));

        // Listen for track changes to cancel pending prefetches
        TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, this._handleTrackChanged.bind(this));

        // CRITICAL: Listen for playback errors to handle auto-completion failures
        TrackPlayer.addEventListener(Event.PlaybackError, this._handlePlaybackError.bind(this));

        this.isInitialized = true;
        this.errorHandlerRegistered = true;
        console.log('✨ SmartPrefetchManager initialized (FIXED VERSION)');
    }

    // ==========================================
    // EVENT HANDLERS
    // ==========================================

    /**
     * Handle playback state changes
     * Triggers prefetch 2 seconds after playback starts
     */
    async _handlePlaybackState(event) {
        if (event.state === State.Playing) {
            // Get current track index
            const currentIndex = await TrackPlayer.getActiveTrackIndex();

            // Cancel any pending prefetch
            this._cancelPendingPrefetch();

            // Store current index for validation
            this.currentTrackIndex = currentIndex;

            // Wait 2 seconds, then prefetch next song
            this.prefetchTimer = setTimeout(async () => {
                // Validate we're still on the same track
                const nowPlaying = await TrackPlayer.getActiveTrackIndex();
                if (nowPlaying === this.currentTrackIndex) {
                    console.log(`🎵 2s after playing index ${nowPlaying}, prefetching next...`);
                    await this._prefetchNextSong(nowPlaying);
                }
            }, PREFETCH_DELAY_MS);
        }
    }

    /**
     * Handle track changes - cancel pending prefetch
     */
    async _handleTrackChanged(event) {
        if (event.index !== undefined && event.index !== null) {
            this._cancelPendingPrefetch();
            this.currentTrackIndex = event.index;
        }
    }

    /**
     * CRITICAL: Handle playback errors for auto-completion failures
     * This is the key fix - when TrackPlayer fails on placeholder URL,
     * we fetch on-demand and retry playback
     */
    async _handlePlaybackError(event) {
        console.log('🔴 PlaybackError detected, attempting recovery...');

        try {
            const currentTrack = await TrackPlayer.getActiveTrack();
            const currentIndex = await TrackPlayer.getActiveTrackIndex();

            if (!currentTrack) {
                console.log('⚠️ No current track during error');
                return;
            }

            // Check if track needs stream (has placeholder URL)
            if (this.needsStream(currentTrack)) {
                console.log(`🔄 Auto-recovery: fetching stream for: ${currentTrack.title}`);

                // Fetch stream on-demand
                const streamData = await this.fetchOnDemand(currentTrack.id);

                if (streamData && streamData.url) {
                    // Replace current track with valid URL
                    await this._replaceAndPlayTrack(currentIndex, currentTrack, streamData);
                    console.log('✅ Auto-recovery successful');
                } else {
                    // Failed to get stream - skip to next
                    console.log('⚠️ Recovery failed, skipping to next track');
                    await this._skipToNextValidTrack(currentIndex);
                }
            }
        } catch (error) {
            console.error('❌ Error in playback error handler:', error.message);
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
        try {
            const queue = await TrackPlayer.getQueue();

            if (index < 0 || index >= queue.length) {
                return; // Invalid index
            }

            const track = queue[index];

            // Skip if not a YouTube track or already has valid URL
            if (!this.needsStream(track)) {
                console.log(`⏭️ Track ${index} doesn't need prefetch`);
                return;
            }

            // Skip if already prefetched and not expired
            const cached = this.getPrefetchedStream(track.id);
            if (cached) {
                console.log(`✅ Track ${index} already prefetched: ${track.title}`);
                // Still replace in queue if needed
                await this._replaceTrackInQueue(index, track, cached);
                return;
            }

            // Skip if already prefetching this track
            if (this.prefetchInProgress.has(track.id)) {
                console.log(`⏳ Track ${index} prefetch already in progress`);
                return;
            }

            this.prefetchInProgress.add(track.id);

            console.log(`🔄 Prefetching track ${index}: ${track.title}`);

            const streamData = await youtubeStreamingService.getStreamUrl(track.id);

            if (streamData && streamData.url) {
                // Store prefetched data
                this._cacheStream(track.id, streamData);

                // Replace track in queue with valid URL
                await this._replaceTrackInQueue(index, track, streamData);

                console.log(`✅ Prefetched & replaced track ${index}: ${track.title}`);
            }

        } catch (error) {
            console.error(`❌ Prefetch failed for index ${index}:`, error.message);
        } finally {
            // Clean up in-progress set
            const queue = await TrackPlayer.getQueue();
            if (index < queue.length) {
                this.prefetchInProgress.delete(queue[index]?.id);
            }
        }
    }

    // ==========================================
    // QUEUE OPERATIONS
    // ==========================================

    /**
     * Replace a track in queue with updated URL
     */
    async _replaceTrackInQueue(index, originalTrack, streamData) {
        try {
            const currentIndex = await TrackPlayer.getActiveTrackIndex();

            // Don't replace the currently playing track (use _replaceAndPlayTrack for that)
            if (index === currentIndex) {
                console.log(`⚠️ Can't replace currently playing track via prefetch`);
                return;
            }

            const updatedTrack = this._createUpdatedTrack(originalTrack, streamData);

            // Remove old track and insert new one at same position
            await TrackPlayer.remove(index);
            await TrackPlayer.add(updatedTrack, index);

            console.log(`🔄 Replaced track at index ${index}`);

        } catch (error) {
            console.error('Error replacing track:', error.message);
        }
    }

    /**
     * Replace CURRENT track and restart playback (for error recovery)
     */
    async _replaceAndPlayTrack(index, originalTrack, streamData) {
        try {
            const updatedTrack = this._createUpdatedTrack(originalTrack, streamData);

            // Remove current track
            await TrackPlayer.remove(index);

            // Add updated track at same position
            await TrackPlayer.add(updatedTrack, index);

            // Skip to it and play
            await TrackPlayer.skip(index);
            await TrackPlayer.play();

            console.log(`✅ Replaced and playing track at index ${index}`);

        } catch (error) {
            console.error('Error in replaceAndPlayTrack:', error.message);
        }
    }

    /**
     * Skip to next valid track when current one fails completely
     */
    async _skipToNextValidTrack(failedIndex) {
        try {
            const queue = await TrackPlayer.getQueue();

            // Remove the failed track
            await TrackPlayer.remove(failedIndex);

            // Get new queue state
            const newQueue = await TrackPlayer.getQueue();

            if (newQueue.length === 0) {
                console.log('⏹️ Queue empty after removing failed track');
                await TrackPlayer.stop();
                return;
            }

            // Try to play the next track (now at same index)
            const nextTrack = newQueue[failedIndex] || newQueue[0];

            if (nextTrack && this.needsStream(nextTrack)) {
                // Fetch stream on-demand for next track
                const streamData = await this.fetchOnDemand(nextTrack.id);
                if (streamData && streamData.url) {
                    const nextIndex = failedIndex < newQueue.length ? failedIndex : 0;
                    await this._replaceAndPlayTrack(nextIndex, nextTrack, streamData);
                    return;
                }
            }

            // Just try to play whatever is next
            await TrackPlayer.play();

        } catch (error) {
            console.error('Error skipping to next valid track:', error.message);
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
            _prefetched: true
        };
    }

    /**
     * Check if track needs stream fetching
     */
    needsStream(track) {
        if (!track) return false;

        // Check if it's a YouTube track needing stream
        const isYTMusic = track.id && typeof track.id === 'string' &&
            track.id.length === 11 && !track.isLocalMusic;

        if (!isYTMusic) return false;

        // Check if URL is placeholder or missing
        const url = track.url || '';
        return !url || url.startsWith('ytmusic://') || url.includes('music.youtube.com');
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
            timestamp: Date.now()
        });
    }

    /**
     * Get prefetched stream for a track
     */
    getPrefetchedStream(trackId) {
        const cached = this.prefetchedTracks.get(trackId);
        if (!cached) return null;

        // Check if expired
        if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
            this.prefetchedTracks.delete(trackId);
            return null;
        }

        return cached;
    }

    /**
     * On-demand fetch for random song selection (with retry)
     */
    async fetchOnDemand(trackId) {
        console.log(`🎯 On-demand fetch for: ${trackId}`);

        // Check prefetch cache first
        const cached = this.getPrefetchedStream(trackId);
        if (cached) {
            console.log(`✅ Using prefetched stream for: ${trackId}`);
            return cached;
        }

        // Fetch with retry
        for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
            try {
                console.log(`🔄 Fetch attempt ${attempt}/${MAX_RETRY_ATTEMPTS} for: ${trackId}`);

                const streamData = await youtubeStreamingService.getStreamUrl(trackId);

                if (streamData && streamData.url) {
                    // Cache it
                    this._cacheStream(trackId, streamData);
                    console.log(`✅ On-demand fetch successful for: ${trackId}`);
                    return streamData;
                }

            } catch (error) {
                console.warn(`⚠️ Attempt ${attempt} failed:`, error.message);

                if (attempt < MAX_RETRY_ATTEMPTS) {
                    // Wait before retry
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                }
            }
        }

        console.error(`❌ On-demand fetch failed after ${MAX_RETRY_ATTEMPTS} attempts: ${trackId}`);
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
        console.log('🗑️ Prefetch cache cleared');
    }
}

// Singleton instance
const smartPrefetchManager = new SmartPrefetchManager();

export default smartPrefetchManager;
