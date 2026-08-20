import AsyncStorage from '@react-native-async-storage/async-storage';
import NativeStreaming from './NativeStreaming';
import { CacheManager } from './NavigationCacheManager';
import { GetYtMusicQuality } from '../LocalStorage/AppSettings';

// UA used by the native (NewPipe) resolver. Only valid for URLs that resolver
// issued - InnerTube URLs must be played back with the UA of the client that
// requested them, otherwise googlevideo answers 403.
const ANDROID_CLIENT = {
  headers: {
    'User-Agent':
      'com.google.android.youtube/19.09.37 (Linux; U; Android 12; en_IN)',
    'X-YouTube-Client-Name': '3',
    'X-YouTube-Client-Version': '19.09.37',
  },
};

const DEFAULT_USER_AGENT = ANDROID_CLIENT.headers['User-Agent'];

let cachedQualityPref = null;
let qualityCacheTTL = 0;
const QUALITY_CACHE_TTL = 60000;

const buildHeaders = (userAgent) => ({
  'User-Agent': userAgent || DEFAULT_USER_AGENT,
  Range: 'bytes=0-',
});

class YouTubeStreamingService {
  constructor() {
    this.cookies = null;
    this.cookiesLoaded = false;
    this.cachedCookies = null;
    this.cookiesCacheTimestamp = 0;
    this.COOKIES_CACHE_TTL = 300000; // 5 minutes
  }

  /**
   * Get streaming URL using InnerTube (with native NewPipe fallback).
   * Uses the shared stream cache to avoid repeated API calls.
   *
   * @param {string} videoId - YouTube video ID
   * @param {boolean} preferM4A - Prefer M4A for downloads (metadata support)
   * @param {AbortSignal|null} signal - Cancels an in-flight resolution
   * @returns {Promise<{url: string, headers: object, thumbnail?: string, duration?: number, title?: string, format: string, mimeType: string, bitrate?: number}|null>}
   */
  async getStreamUrl(videoId, preferM4A = false, signal = null, options = {}) {
    const { forceRefresh = false, preferStrategy = null } = options;

    try {
      if (signal?.aborted) {
        throw new Error('AbortError');
      }

      if (!preferM4A && !forceRefresh) {
        const cachedData = await CacheManager.getStreamUrlAsync(
          videoId,
          'ytmusic'
        );
        // Cache schema guard. An entry is only trustworthy if it records BOTH
        // the User-Agent it was issued to and which resolver produced it.
        // Older entries predate those fields and are exactly the ones holding
        // dead pre-PO-token URLs, so drop them and re-resolve once rather than
        // serving a link that is guaranteed to 403.
        if (
          cachedData &&
          cachedData.url &&
          (!cachedData.userAgent || !cachedData.resolvedBy)
        ) {
          CacheManager.invalidateStreamUrl(videoId, 'ytmusic');
        } else if (cachedData && cachedData.url) {
          const estimatedBitrate =
            cachedData.bitrate ||
            (cachedData.mimeType?.includes('webm') ? 148000 : 256000);
          return {
            url: cachedData.url,
            // Replay with the SAME UA the URL was issued to.
            headers: buildHeaders(cachedData.userAgent),
            userAgent: cachedData.userAgent || DEFAULT_USER_AGENT,
            format: cachedData.format || 'opus',
            mimeType: cachedData.mimeType || 'audio/webm',
            bitrate: estimatedBitrate,
            resolvedBy: cachedData.resolvedBy || null,
            fromCache: true,
          };
        }
      }

      let autoQuality = true;
      if (
        Date.now() - qualityCacheTTL > QUALITY_CACHE_TTL ||
        cachedQualityPref === null
      ) {
        cachedQualityPref = await GetYtMusicQuality();
        qualityCacheTTL = Date.now();
      }
      autoQuality = cachedQualityPref !== 'High';

      if (
        !this.cachedCookies ||
        Date.now() - this.cookiesCacheTimestamp > this.COOKIES_CACHE_TTL
      ) {
        this.cachedCookies = await AsyncStorage.getItem('yt_cookies');
        this.cookiesCacheTimestamp = Date.now();
      }
      const cookies = this.cachedCookies;

      if (signal?.aborted) {
        throw new Error('AbortError');
      }

      let result = null;
      let resolvedUserAgent = DEFAULT_USER_AGENT;
      let resolvedBy = null;

      /**
       * Native NewPipe extractor. Primary since Aug 2026: it performs
       * signature/nsig deciphering, so it can use player clients that the
       * JS path cannot, and it carries upstream's SABR workarounds.
       */
      const tryNative = async () => {
        const nativeResult = preferM4A
          ? await NativeStreaming.getStreamUrlForDownload(videoId, cookies || '')
          : await NativeStreaming.getStreamUrl(
              videoId,
              cookies || '',
              autoQuality
            );

        if (nativeResult && nativeResult.url) {
          resolvedUserAgent = DEFAULT_USER_AGENT;
          resolvedBy = 'native';
          return nativeResult;
        }
        return null;
      };

      /**
       * JS InnerTube client. Can only use the "JS-less" clients (ANDROID_VR /
       * IOS / ANDROID_MUSIC) because there is no decipher implementation here,
       * and those clients now require a GVS PO Token - without one googlevideo
       * answers 403. Kept as a fallback since it still works for some videos
       * and for signed-in users.
       */
      const tryInnerTube = async () => {
        const InnerTubeClient = require('../Api/InnertubeClient').default;
        const innertubeResult = await InnerTubeClient.getPlayerResponse(
          videoId,
          cookies,
          preferM4A,
          signal
        );
        if (innertubeResult && innertubeResult.url) {
          const mimeType = innertubeResult.mimeType || 'audio/webm';
          const isM4A = mimeType.includes('mp4') || mimeType.includes('m4a');
          resolvedUserAgent = innertubeResult.userAgent || DEFAULT_USER_AGENT;
          resolvedBy = 'innertube';
          return {
            url: innertubeResult.url,
            thumbnail: innertubeResult.thumbnail,
            duration: innertubeResult.duration,
            title: innertubeResult.title,
            author: innertubeResult.author,
            format: isM4A ? 'm4a' : 'opus',
            mimeType: mimeType,
            bitrate: innertubeResult.bitrate,
          };
        }
        return null;
      };

      // Order the strategies. `preferStrategy` lets error recovery retry with
      // the resolver that did NOT produce the URL that just failed, instead of
      // handing back the same dead link.
      let strategies = [
        { name: 'native', run: tryNative },
        { name: 'innertube', run: tryInnerTube },
      ];
      if (preferStrategy === 'innertube') {
        strategies = strategies.reverse();
      } else if (preferStrategy === 'native') {
        // already first
      }

      for (const strategy of strategies) {
        if (signal?.aborted) {
          throw new Error('AbortError');
        }
        try {
          result = await strategy.run();
          if (result && result.url) {
            break;
          }
        } catch (strategyErr) {
          if (
            strategyErr.name === 'AbortError' ||
            strategyErr.message === 'AbortError'
          ) {
            throw strategyErr;
          }
          console.warn(
            `[${strategy.name}] resolver failed for ${videoId}:`,
            strategyErr.message
          );
        }
      }

      if (result && result.url) {
        console.log(`Stream resolved for ${videoId} via ${resolvedBy}`);
        const format = result.format || (preferM4A ? 'm4a' : 'opus');
        const mimeType =
          result.mimeType || (preferM4A ? 'audio/mp4' : 'audio/webm');

        // Only cache streaming URLs - download URLs use a different format
        // preference and would poison the streaming cache.
        if (!preferM4A) {
          CacheManager.setStreamUrl(videoId, result.url, 'ytmusic', {
            format: format,
            mimeType: mimeType,
            userAgent: resolvedUserAgent,
            bitrate: result.bitrate,
            resolvedBy: resolvedBy,
          });
        }

        return {
          url: result.url,
          headers: buildHeaders(resolvedUserAgent),
          userAgent: resolvedUserAgent,
          thumbnail: result.thumbnail,
          duration: result.duration,
          title: result.title,
          author: result.author,
          format: format,
          mimeType: mimeType,
          bitrate: result.bitrate,
          resolvedBy: resolvedBy,
          fromCache: false,
        };
      }

      throw new Error('All stream resolution strategies returned empty result');
    } catch (error) {
      if (error.name === 'AbortError' || error.message === 'AbortError') {
        throw error;
      }
      console.error(`Streaming failed for ${videoId}:`, error.message);
      return null;
    }
  }
}

const youtubeStreamingService = new YouTubeStreamingService();

export default youtubeStreamingService;
