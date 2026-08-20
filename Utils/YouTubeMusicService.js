import InnerTubeClient from '../Api/InnertubeClient';
import NativeStreaming from './NativeStreaming';
import youtubeStreamingService from './YouTubeStreamingService';
import { GetYtMusicQuality } from '../LocalStorage/AppSettings';

// Cache quality preference to avoid repeated AsyncStorage calls
let cachedQualityPref = null;
let qualityCacheTTL = 0;
const QUALITY_CACHE_TTL = 60000; // 1 minute

/**
 * YouTubeMusicService
 *
 * Unified service layer for YouTube Music API operations.
 * Combines InnerTube API (JS) for metadata and Native Streaming (Kotlin) for audio URLs.
 */
class YouTubeMusicService {
  static initialized = true;

  static async initialize() {
    return true;
  }

  // Stream URL extraction via native bridge
  static async getStreamUrl(videoId) {
    try {
      // Get quality preference (cached for performance)
      let autoQuality = true; // Default to Auto (faster)
      if (
        Date.now() - qualityCacheTTL > QUALITY_CACHE_TTL ||
        cachedQualityPref === null
      ) {
        cachedQualityPref = await GetYtMusicQuality();
        qualityCacheTTL = Date.now();
      }
      // Auto = true (use first stream), High = false (select best quality)
      autoQuality = cachedQualityPref !== 'High';

      // Delegate to the shared streaming service so Spotify-mapped tracks get
      // the same InnerTube resolution, stream cache and - critically - the
      // matching User-Agent headers as native YTMusic tracks. Playing a
      // googlevideo URL without the UA it was issued to returns 403.
      let stream = await youtubeStreamingService.getStreamUrl(videoId);

      // Fallback to the native resolver only if the shared path came back empty
      if (!stream || !stream.url) {
        stream = await NativeStreaming.getStreamUrl(videoId, '', autoQuality);
      }

      // CRITICAL: Validate that we got a valid stream URL
      if (!stream || !stream.url) {
        console.error(
          `❌ YouTubeMusicService: Empty stream URL for videoId: ${videoId}`
        );
        return null;
      }

      // Map native result to expected format, including bitrate and mimeType
      return {
        ...stream,
        url: stream.url,
        videoId: videoId,
        // Add formats structure if needed (Native returns one best stream)
        all_formats: [],
        format: stream.format || 'opus',
        mimeType: stream.mimeType || 'audio/webm',
        bitrate: stream.bitrate || 0,
      };
    } catch (error) {
      console.error(
        `❌ YouTubeMusicService.getStreamUrl error for ${videoId}:`,
        error.message
      );

      // If the error indicates session expired, clear visitorData to force refresh
      if (error.message && error.message.includes('The page needs to be reloaded')) {
        try {
          const AsyncStorage = require('@react-native-async-storage/async-storage').default;
          await AsyncStorage.removeItem('innertube_visitor_data');
          console.log('🗑️ Cleared old visitorData due to session expiry');
        } catch (e) {
          console.error('Failed to clear visitorData:', e);
        }
      }

      return null;
    }
  }

  static async search(query, filter = 'songs', _limit = 20) {
    return await InnerTubeClient.search(query, filter);
  }

  static async getSearchSuggestions(query) {
    // Use pure JS implementation instead of native bridge (which returns 400 errors)
    return await InnerTubeClient.getSearchSuggestions(query);
  }

  static async getHomeFeed(limit = 10, forceRefresh = false) {
    return await InnerTubeClient.getHome(limit, forceRefresh);
  }

  static async getPlaylist(playlistId) {
    return await InnerTubeClient.getPlaylist(playlistId);
  }

  static async getAlbum(albumId) {
    return await InnerTubeClient.getAlbum(albumId);
  }

  static async getArtist(browseId) {
    return await InnerTubeClient.getArtist(browseId);
  }

  static async getSection(browseId, params = null, continuation = null) {
    return await InnerTubeClient.getSection(browseId, params, continuation);
  }

  static async getNext(videoId, playlistId = null, continuation = null) {
    return await InnerTubeClient.getNext(videoId, playlistId, continuation);
  }

  /**
   * Register playback with YouTube to update watch history and visitorData
   * crucial for personalized recommendations
   */
  static async registerPlayback(videoId) {
    // We use getNext as a lightweight way to register the "watch"
    // This updates the visitorData in InnerTubeClient
    // we don't await the result to avoid blocking, but we catch errors
    InnerTubeClient.getNext(videoId).catch((_e) => {
      // Silently fail, this is just for stats/history
    });
  }

  static async getCharts(_country = 'IN') {
    // Not implemented in InnerTubeClient yet, returning empty
    return { videos: [], artists: [], genres: [] };
  }

  static async searchAndStream(songName, artistName = '') {
    try {
      const results = await this.search(`${songName} ${artistName}`, 'songs');
      if (results && results.length > 0) {
        const videoId = results[0].videoId;
        const stream = await this.getStreamUrl(videoId);

        // CRITICAL: Validate stream before returning
        if (!stream || !stream.url) {
          console.error(
            `❌ searchAndStream: Failed to get stream for ${songName}`
          );
          return { error: 'Failed to get stream URL' };
        }

        return {
          ...stream,
          ...results[0], // Merge metadata (unchanged precedence)
          // ...but the playback fields must always come from the resolved
          // stream, never from the search result.
          url: stream.url,
          headers: stream.headers,
          userAgent: stream.userAgent,
          format: stream.format,
          mimeType: stream.mimeType,
          bitrate: stream.bitrate,
          videoId: videoId,
          stream_url: stream.url, // legacy key
        };
      }
      return { error: 'No results found' };
    } catch (error) {
      console.error(`❌ searchAndStream error for ${songName}:`, error.message);
      return { error: error.message };
    }
  }

  // Legacy stubs for backward compatibility
  static async clearCache() {
    return { status: 'success' };
  }
  static async resetSession() {
    return { status: 'success' };
  }
  static async getDiagnostics() {
    return { status: 'migrated_to_js' };
  }
}

export default YouTubeMusicService;
