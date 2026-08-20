/**
 * AutoRecommendations.js
 *
 * Automatically fetches and appends YouTube Music recommendations
 * to maintain infinite playback.
 *
 * Flow:
 * 1. Fetch 20 recommendations when user starts playing
 * 2. Monitor current track position in queue
 * 3. When at song 19 (or queue length - 1), fetch 20 more
 * 4. Append seamlessly without interrupting playback
 */

import TrackPlayer, { Event } from 'react-native-track-player';
import { AddSongsToQueue } from '../MusicPlayerFunctions';
import YTMusic from '../Api/YTMusic';
import { debounce } from './EventDebouncer';
import NetInfo from '@react-native-community/netinfo';
import YouTubeMusicService from './YouTubeMusicService';
import FormatTitleAndArtist from '../Utils/FormatTitleAndArtist';
import { upgradeArtworkQuality } from './YTMusicArtworkUtils';
import { getQueueSnapshot } from './QueueSnapshot';

class AutoRecommendations {
  constructor() {
    this.isEnabled = false;
    this.isFetching = false;
    this.currentVideoId = null;
    this.continuation = null;
    this.lastQueueLength = 0;
    this.fetchThreshold = 3; // Fetch when 3 songs left
  }

  /**
   * Start auto-recommendations for a videoId
   */
  async start(videoId) {
    this.currentVideoId = videoId;
    this.continuation = null;
    this.isEnabled = true;

    // Fetch initial recommendations
    await this.fetchAndAppendRecommendations();
  }

  /**
   * Stop auto-recommendations
   */
  stop() {
    this.isEnabled = false;
    this.currentVideoId = null;
    this.continuation = null;
    this.isFetching = false;
  }

  /**
   * Check if we should fetch more recommendations
   */
  async checkAndFetch() {
    if (!this.isEnabled || this.isFetching) {
      return;
    }

    try {
      const queue = await getQueueSnapshot();
      const currentIndex = await TrackPlayer.getActiveTrackIndex();

      if (currentIndex === null || !queue || queue.length === 0) {
        return;
      }

      const songsRemaining = queue.length - currentIndex;
      // Fetch when approaching end of queue
      if (songsRemaining <= this.fetchThreshold) {
        await this.fetchAndAppendRecommendations();
      }
    } catch (error) {
      console.error('AutoRecommendations checkAndFetch error:', error);
    }
  }

  /**
   * Fetch 20 recommendations and append to queue
   */
  async fetchAndAppendRecommendations() {
    if (this.isFetching || !this.currentVideoId) {
      return;
    }

    this.isFetching = true;

    try {
      // Call YouTube Music's getNext API
      const result = await YouTubeMusicService.getNext(
        this.currentVideoId,
        null,
        this.continuation
      );

      if (!result || !result.items || result.items.length === 0) {
        this.isFetching = false;
        return;
      }
      // Store continuation for next fetch
      this.continuation = result.continuation;

      // Format songs for TrackPlayer
      const formattedSongs = result.items
        .slice(0, 20)
        .map((song) => {
          const artistNames =
            song.artists?.map((a) => a.name).join(', ') ||
            song.artist ||
            'Unknown';
          const songId = song.videoId || song.id;
          const artworkUrl = upgradeArtworkQuality(
            song.thumbnail || song.thumbnails?.[0]?.url || ''
          );

          return {
            url: `ytmusic://${songId}`, // Placeholder - will be resolved at playback time
            title: FormatTitleAndArtist(song.title || song.name || ''),
            artist: FormatTitleAndArtist(artistNames),
            artwork: artworkUrl,
            image: artworkUrl,
            duration: song.duration || 0,
            id: songId,
            language: '',
            source: 'ytmusic',
            sourceType: 'online', // CRITICAL: Set for queue filtering and prefetch
            isYTMusic: true,
            isRecommendation: true,
            _needsStream: true,
          };
        })
        .filter((song) => song.id); // Filter out invalid songs

      if (formattedSongs.length === 0) {
        this.isFetching = false;
        return;
      }

      // Append to queue
      await TrackPlayer.add(formattedSongs);
      // Update currentVideoId to last song for next fetch
      if (formattedSongs.length > 0) {
        this.currentVideoId = formattedSongs[formattedSongs.length - 1].id;
      }
    } catch (error) {
      console.error('AutoRecommendations fetch error:', error);
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Handle track change event
   */
  async onTrackChanged() {
    if (!this.isEnabled) {
      return;
    }

    // Check if we need to fetch more
    await this.checkAndFetch();
  }

  /**
   * Initialize event listeners
   */
  initializeListeners() {
    // Debounced track change handler to prevent excessive processing during rapid skips
    const debouncedTrackHandler = debounce(async (event) => {
      if (this.isEnabled && event.nextTrack !== undefined) {
        await this.onTrackChanged();
      }
    }, 500); // 500ms debounce for auto-recommendations

    // Listen for track changes
    TrackPlayer.addEventListener(
      Event.PlaybackTrackChanged,
      debouncedTrackHandler
    );
  }
}

// Singleton instance
const autoRecommendations = new AutoRecommendations();

export default autoRecommendations;
