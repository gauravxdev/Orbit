/**
 * InnerTubeClient.js
 *
 * Pure JavaScript implementation of YouTube Music InnerTube API.
 * Pure JavaScript implementation for YouTube Music InnerTube API.
 */

import { enhanceYTMusicArtwork } from '../Utils/ArtworkEnhancer';
import { getCachedData, CACHE_GROUPS } from './CacheManager';

// Cache constants for home feed
const HOME_FEED_CACHE_KEY = 'ytmusic_home_sections_unified';
const HOME_FEED_CACHE_TTL_MINUTES = 1440; // 24 hours

const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_API_URL = 'https://music.youtube.com/youtubei/v1';

// Client ID for WEB_REMIX (YouTube Music Web)
const WEB_REMIX_CLIENT_ID = '67';
const WEB_REMIX_CLIENT_VERSION = '1.20260405.01.00';
const WEB_REMIX_CLIENT_NAME = 'WEB_REMIX';

// Match OuterTune's headers exactly
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Content-Type': 'application/json',
  Origin: 'https://music.youtube.com',
  Referer: 'https://music.youtube.com/',
  'X-Goog-Api-Format-Version': '1',
  'X-YouTube-Client-Name': WEB_REMIX_CLIENT_ID,
  'X-YouTube-Client-Version': WEB_REMIX_CLIENT_VERSION,
};

const WEB_REMIX_CONTEXT = {
  context: {
    client: {
      clientName: WEB_REMIX_CLIENT_NAME,
      clientVersion: WEB_REMIX_CLIENT_VERSION,
      originalUrl: 'https://music.youtube.com',
      hl: 'en',
      gl: 'US',
      // visitorData will be added dynamically if available
    },
  },
};

class InnerTubeClient {
  /**
   * Helper to make API requests
   * @param {string} endpoint - API endpoint
   * @param {object} body - Request body
   * @param {string} gl - Country code
   * @param {string|null} authCookies - Optional auth cookies for personalized content
   * @param {string} hl - Host language (e.g., 'en', 'hi', 'en-IN')
   * @param {string|null} visitorData - Optional visitor data for personalization
   * @param {string|null} dataSyncId - Optional data sync ID for logged-in personalization
   */
  static async request(
    endpoint,
    body,
    gl = 'US',
    authCookies = null,
    hl = 'en',
    visitorData = null,
    dataSyncId = null
  ) {
    try {
      const url = `${INNERTUBE_API_URL}/${endpoint}?key=${INNERTUBE_API_KEY}`;

      // Get stored visitorData if not provided
      let effectiveVisitorData = visitorData;
      if (!effectiveVisitorData) {
        try {
          const AsyncStorage =
            require('@react-native-async-storage/async-storage').default;
          effectiveVisitorData = await AsyncStorage.getItem(
            'innertube_visitor_data'
          );
        } catch (e) {}
      }
      // Create context with dynamic GL, HL, and visitorData (like OuterTune)
      const client = {
        ...WEB_REMIX_CONTEXT.context.client,
        visitorData: effectiveVisitorData,
      };

      // Only add gl and hl if they are not SYSTEM_DEFAULT
      if (gl && gl !== 'SYSTEM_DEFAULT') {
        client.gl = gl;
      }
      if (hl && hl !== 'SYSTEM_DEFAULT') {
        client.hl = hl;
      }

      const requestContext = {
        context: {
          client: client,
          user: {
            lockedSafetyMode: false,
            // Add onBehalfOfUser for logged-in personalization (like OuterTune)
            ...(dataSyncId && authCookies
              ? { onBehalfOfUser: dataSyncId }
              : {}),
          },
        },
      };

      // Build headers with optional auth cookies
      const requestHeaders = { ...HEADERS };
      if (authCookies) {
        requestHeaders.Cookie = authCookies;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({
          ...requestContext,
          ...body,
        }),
      });

      const data = await response.json();

      // Extract and store visitorData from response for future requests (like OuterTune)
      if (data?.responseContext?.visitorData && !effectiveVisitorData) {
        try {
          const AsyncStorage =
            require('@react-native-async-storage/async-storage').default;
          await AsyncStorage.setItem(
            'innertube_visitor_data',
            data.responseContext.visitorData
          );
        } catch (e) {}
      }

      return data;
    } catch (error) {
      console.error(`InnerTube request failed for ${endpoint}:`, error);
      return null;
    }
  }

  /**
   * Parse time string (e.g., "3:45", "1:23:45") to seconds
   * Matches OuterTune's parseTime function
   */
  static parseTime(timeString) {
    if (!timeString) {
      return null;
    }

    const parts = timeString.split(':').map((p) => parseInt(p, 10));
    if (parts.some(isNaN)) {
      return null;
    }

    if (parts.length === 2) {
      // MM:SS format
      return parts[0] * 60 + parts[1];
    } else if (parts.length === 3) {
      // HH:MM:SS format
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    return null;
  }

  /**
   * Reset visitor data to get fresh personalization
   * Call this when user wants to reset their YouTube Music recommendations
   */
  static async resetVisitorData() {
    try {
      const AsyncStorage =
        require('@react-native-async-storage/async-storage').default;
      await AsyncStorage.removeItem('innertube_visitor_data');
      // Also clear the home feed cache
      await AsyncStorage.removeItem('ytmusic_home_feed_full_v6');
      return true;
    } catch (e) {
      console.error('Failed to reset visitorData:', e);
      return false;
    }
  }

  /**
   * Get current visitor data (for debugging)
   */
  static async getVisitorData() {
    try {
      const AsyncStorage =
        require('@react-native-async-storage/async-storage').default;
      return await AsyncStorage.getItem('innertube_visitor_data');
    } catch (e) {
      return null;
    }
  }
/**
 * Get Home Feed - cache-aware wrapper
 * Checks cache first, fetches fresh if cache miss or forceRefresh
 * @param {number} sectionLimit - Maximum number of sections to fetch
 * @param {boolean} forceRefresh - Skip cache if true
 * @returns {Promise<Array>} Array of home feed sections
 */
static async getHome(sectionLimit = 20, forceRefresh = false) {
  if (forceRefresh) {
    // Skip cache on force refresh
    return await InnerTubeClient.getHomeWithContinuation(sectionLimit);
  }

  try {
    const cachedResult = await getCachedData(
      HOME_FEED_CACHE_KEY,
      async () => {
        // Fetch fresh data and wrap in success object for getCachedData
        const data = await InnerTubeClient.getHomeWithContinuation(sectionLimit);
        return { sections: data, success: true };
      },
      HOME_FEED_CACHE_TTL_MINUTES,
      CACHE_GROUPS.HOME,
      false // forceRefresh handled above
    );

    // getCachedData returns the data from fetchFunction directly on cache miss
    // On cache hit, it returns the cached data
    if (cachedResult && Array.isArray(cachedResult)) {
      return cachedResult;
    }
    if (cachedResult?.sections && Array.isArray(cachedResult.sections)) {
      return cachedResult.sections;
    }
    // Fallback to fresh fetch
    return await InnerTubeClient.getHomeWithContinuation(sectionLimit);
  } catch (error) {
    console.warn('YTMusic home cache error, fetching fresh:', error.message);
    return await InnerTubeClient.getHomeWithContinuation(sectionLimit);
  }
}

/**
 * Internal method - does the actual API fetching with continuation
 * @param {number} sectionLimit - Maximum number of sections to fetch
 */
static async getHomeWithContinuation(sectionLimit = 20) {
  let authCookies = null;

  // Try to get auth cookies for personalized content
  try {
    const ytAuthService = require('../Utils/YouTubeAuthService').default;
    if (ytAuthService.isAuth()) {
      authCookies = await ytAuthService.getCookies();
    }
  } catch (e) {}

  // Get user's language and country preference from settings
  // Note: Language affects UI text, songs are based on listening HISTORY (visitorData)
  // Use an account with listening history for personalized recommendations
  let userLanguage = 'SYSTEM_DEFAULT';
  let userCountry = 'SYSTEM_DEFAULT';
  try {
    const AsyncStorage =
      require('@react-native-async-storage/async-storage').default;
    const storedLang = await AsyncStorage.getItem('ytmusic_language');
    const storedCountry = await AsyncStorage.getItem('ytmusic_country');
    if (storedLang) {
      userLanguage = storedLang;
    }
    if (storedCountry) {
      userCountry = storedCountry;
    }
  } catch (e) {}

  // Initial request with user's language preference
  const data = await this.request(
    'browse',
    { browseId: 'FEmusic_home' },
    userCountry,
    authCookies,
    userLanguage
  );

  // Parse initial sections, chips, and continuation token
  let { sections, chips, continuation } =
    this.parseHomeWithContinuation(data);
  let allSections = [...sections];
  const seenTitles = new Set(sections.map((s) => s.title));

  // 1. Follow continuations iteratively (Main Home Feed)
  let continuationCount = 0;
  const MAX_CONTINUATIONS = 5;

  while (
    continuation &&
    allSections.length < sectionLimit &&
    continuationCount < MAX_CONTINUATIONS
  ) {
    const contData = await this.request(
      'browse',
      { continuation },
      userCountry,
      authCookies,
      userLanguage
    );
    const contResult = this.parseHomeContinuation(contData);

    let addedInThisCont = 0;
    contResult.sections.forEach((section) => {
      if (section.title && !seenTitles.has(section.title)) {
        seenTitles.add(section.title);
        allSections.push(section);
        addedInThisCont++;
      }
    });
    continuation = contResult.continuation;
    continuationCount++;

    if (addedInThisCont === 0) {
      break;
    } // Stop if no new sections found
  }

  // 2. Fetch from chips (additional variety like OuterTune)
  if (chips && chips.length > 0 && allSections.length < sectionLimit) {
    const chipsToFetch = [];

    // Prioritize the "Music" chip if found (contains personalized "Albums for you")
    const musicChip = chips.find((c) =>
      c.title.toLowerCase().includes('music')
    );
    if (musicChip) {
      chipsToFetch.push(musicChip);
    }

    // Add other chips up to limit
    chips.forEach((c) => {
      if (c !== musicChip && chipsToFetch.length < 8) {
        chipsToFetch.push(c);
      }
    });

    const chipPromises = chipsToFetch.map(async (chip, idx) => {
      if (!chip.params) {
        return [];
      }

      try {
        const chipData = await this.request(
          'browse',
          {
            browseId: 'FEmusic_home',
            params: chip.params,
          },
          userCountry,
          authCookies,
          userLanguage
        );

        const chipResult = this.parseHomeWithContinuation(chipData);
        return chipResult.sections;
      } catch (e) {
        return [];
      }
    });

    const chipResultsArr = await Promise.all(chipPromises);

    chipResultsArr.forEach((chipSections) => {
      chipSections.forEach((section) => {
        if (section.title && !seenTitles.has(section.title)) {
          seenTitles.add(section.title);
          allSections.push(section);
        }
      });
    });
  }
  return allSections;
}

  /**
   * Get Search Results
   */
  static async search(query, filter = null) {
    // OuterTune's exact filter params
    let params = null;
    if (filter === 'songs') {
      params = 'EgWKAQIIAWoKEAkQBRAKEAMQBA==';
    }
    if (filter === 'videos') {
      params = 'EgWKAQIQAWoKEAkQChAFEAMQBA==';
    }
    if (filter === 'albums') {
      params = 'EgWKAQIYAWoKEAkQChAFEAMQBA==';
    }
    if (filter === 'artists') {
      params = 'EgWKAQIgAWoKEAkQChAFEAMQBA==';
    }
    if (filter === 'playlists') {
      params = 'EgeKAQQoAEABagoQAxAEEAoQCRAF';
    }

    const data = await this.request('search', { query, params });
    return this.parseSearch(data, filter);
  }

  /**
   * Get Search Suggestions
   * Uses music/get_search_suggestions endpoint
   */
  static async getSearchSuggestions(query) {
    try {
      const url = `${INNERTUBE_API_URL}/music/get_search_suggestions?key=${INNERTUBE_API_KEY}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          ...WEB_REMIX_CONTEXT,
          input: query,
        }),
      });

      const data = await response.json();

      // Parse suggestions from response
      const suggestions = [];
      const recommendedItems = [];
      const contents = data?.contents;

      if (contents && Array.isArray(contents)) {
        // First section typically contains text suggestions
        const suggestionsSection =
          contents[0]?.searchSuggestionsSectionRenderer?.contents;
        if (suggestionsSection) {
          for (const item of suggestionsSection) {
            if (item.searchSuggestionRenderer?.suggestion?.runs) {
              const text = item.searchSuggestionRenderer.suggestion.runs
                .map((run) => run.text)
                .join('');
              if (text) {
                suggestions.push(text);
              }
            }
          }
        }

        // Second section contains recommended item cards (songs/artists)
        const recommendedSection =
          contents[1]?.searchSuggestionsSectionRenderer?.contents;
        if (recommendedSection && Array.isArray(recommendedSection)) {
          for (const item of recommendedSection) {
            const renderer = item.musicResponsiveListItemRenderer;
            if (renderer) {
              const title =
                renderer.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
              const subtitleRuns =
                renderer.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
              const artist = subtitleRuns?.map((r) => r.text).join('') || '';
              const videoId =
                renderer.playlistItemData?.videoId ||
                renderer.navigationEndpoint?.watchEndpoint?.videoId;
              const thumbnails =
                renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
              const artwork = thumbnails?.[thumbnails.length - 1]?.url || '';

              if (title && videoId) {
                recommendedItems.push({
                  id: videoId,
                  title: title,
                  name: title,
                  artist: artist,
                  artwork: artwork,
                  image: artwork,
                  url: `https://www.youtube.com/watch?v=${videoId}`,
                  type: 'song',
                });
              }
            }
          }
        }
      }

      return {
        queries: suggestions,
        recommendedItems: recommendedItems,
      };
    } catch (error) {
      console.error('InnerTubeClient getSearchSuggestions error:', error);
      return { queries: [], recommendedItems: [] };
    }
  }

  static async getArtist(browseId) {
    const data = await this.request('browse', { browseId });

    return this.parseArtist(data);
  }

  static async getAlbum(browseId) {
    // For OLAK IDs (which are playlist IDs), try with VL prefix FIRST
    // This avoids the unnecessary 400 error from direct browse
    if (browseId.startsWith('OLAK')) {
      const playlistBrowseId = `VL${browseId}`;
      const data = await this.request('browse', { browseId: playlistBrowseId });

      if (!data?.error) {
        const playlist = this.parsePlaylist(data);
        if (playlist && playlist.songs?.length > 0) {
          // Convert playlist format to album format
          return {
            title: playlist.title,
            name: playlist.title, // Also add 'name' for compatibility
            artist: playlist.author || 'Various Artists',
            artists: [{ name: playlist.author || 'Various Artists', id: null }],
            year: playlist.year,
            thumbnails: playlist.thumbnails || [],
            thumbnail: playlist.thumbnail,
            tracks: playlist.songs,
            songs: playlist.songs,
            browseId: browseId,
          };
        }
      } else {
        console.warn(
          'getAlbum: VL prefix browse failed for OLAK, trying direct...'
        );
      }
    }

    // Try direct browse as album (for MPRE IDs and other album types)
    let data = await this.request('browse', { browseId });

    // Check if we got an error response
    if (data?.error) {
      console.error(
        'getAlbum: API returned error:',
        JSON.stringify(data.error)
      );

      // Try converting OLAK to MPRE format and browse
      if (browseId.startsWith('OLAK')) {
        const mpreId = browseId.replace('OLAK', 'MPREb_');
        data = await this.request('browse', { browseId: mpreId });

        if (!data?.error) {
          return this.parseAlbum(data);
        }
      }

      return null;
    }

    return this.parseAlbum(data);
  }

  static async getPlaylist(browseId) {
    const data = await this.request('browse', {
      browseId: browseId.startsWith('VL') ? browseId : `VL${browseId}`,
    });
    const playlist = this.parsePlaylist(data);

    // Handle continuations (load all songs)
    if (playlist && playlist.continuation) {
      let continuation = playlist.continuation;
      // Limit to reasonable amount to prevent infinite loops (e.g. 50 requests * 100 songs = 5000 songs)
      let loops = 0;
      const MAX_LOOPS = 50;

      while (continuation && loops < MAX_LOOPS) {
        try {
          const contData = await this.request('browse', { continuation });
          const shelf =
            contData?.continuationContents?.musicPlaylistShelfContinuation;

          if (shelf) {
            const newSongs =
              shelf.contents?.map((t) => this.parseItem(t)).filter((i) => i) ||
              [];
            if (newSongs.length > 0) {
              playlist.songs.push(...newSongs);
              // Update count
              playlist.count = playlist.songs.length;
            }

            continuation =
              shelf.continuations?.[0]?.nextContinuationData?.continuation ||
              shelf.continuations?.[0]?.reloadContinuationData?.continuation;
          } else {
            break;
          }
          loops++;
        } catch (e) {
          console.error('Error fetching playlist continuation:', e);
          break;
        }
      }
    }

    return playlist;
  }

  static async getRelated(browseId) {
    const data = await this.request('next', { videoId: browseId });
    return this.parseRelated(data);
  }

  /**
   * Get Next/Recommendations for a video (YouTube Music Radio)
   * This is similar to OuterTune's YouTube.next() function
   */
  static async getNext(videoId, playlistId = null, continuation = null) {
    const body = {
      videoId,
      isAudioOnly: true,
    };

    if (playlistId) {
      body.playlistId = playlistId;
    }

    if (continuation) {
      body.continuation = continuation;
    }

    const data = await this.request('next', body);
    const result = this.parseNext(data);

    // If we got an automix playlist endpoint, fetch the radio playlist
    if (result.automixPlaylistId) {
      const radioResult = await this.getNextWithPlaylist(
        videoId,
        result.automixPlaylistId
      );
      if (radioResult && radioResult.items && radioResult.items.length > 0) {
        // Combine current items with radio items
        return {
          items: [...result.items, ...radioResult.items],
          continuation: radioResult.continuation,
          title: result.title || radioResult.title,
          automixPlaylistId: null, // Already processed
        };
      }
    }

    return result;
  }

  /**
   * Get Section Items (See All)
   * Supports lazy loading via continuation
   */
  static async getSection(browseId, params = null, continuation = null) {
    const fetchFunction = async () => {
      if (continuation) {
        const data = await this.request('browse', { continuation });
        return this.parseSection(data);
      }

      const data = await this.request('browse', { browseId, params });
      return this.parseSection(data);
    };

    if (continuation) {
      return await fetchFunction();
    }

    const cacheKey = `ytmusic_section_${browseId}_${params || 'none'}`;
    try {
      return await getCachedData(
        cacheKey,
        fetchFunction,
        30,
        CACHE_GROUPS.SEARCH
      );
    } catch (e) {
      console.error('Error caching section:', e);
      return await fetchFunction();
    }
  }

  /**
   * Get Next with a specific playlist ID (for automix/radio)
   */
  static async getNextWithPlaylist(videoId, playlistId) {
    const body = {
      videoId,
      playlistId,
      isAudioOnly: true,
      enablePersistentPlaylistPanel: true,
      tunerSettingValue: 'AUTOMIX_SETTING_NORMAL',
    };

    const data = await this.request('next', body);
    return this.parseNext(data);
  }

  // --- Parsers ---

  static parseHome(data) {
    const sections = [];
    try {
      // Home Feed logic
      const tabs = data?.contents?.singleColumnBrowseResultsRenderer?.tabs;
      if (!tabs) {
        return [];
      }
      const content =
        tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents;

      content?.forEach((section) => {
        if (section.musicCarouselShelfRenderer) {
          const shelf = section.musicCarouselShelfRenderer;
          const items =
            shelf.contents
              ?.map((item) => this.parseItem(item))
              .filter((i) => i) || [];
          if (items.length > 0) {
            sections.push({
              title:
                shelf.header?.musicCarouselShelfBasicHeaderRenderer?.title
                  ?.runs?.[0]?.text || '',
              contents: items,
            });
          }
        }
      });
    } catch (e) {
      console.error('Parse Home Error', e);
    }
    return sections;
  }

  /**
   * Parse home response and extract continuation token and chips
   */
  static parseHomeWithContinuation(data) {
    const sections = [];
    let continuation = null;
    let chips = [];

    try {
      const tabs = data?.contents?.singleColumnBrowseResultsRenderer?.tabs;
      if (!tabs) {
        return { sections: [], continuation: null, chips: [] };
      }

      const sectionListRenderer =
        tabs[0]?.tabRenderer?.content?.sectionListRenderer;
      const content = sectionListRenderer?.contents;
      // Extract chips from header (used for loading more content)
      const chipCloud = sectionListRenderer?.header?.chipCloudRenderer?.chips;
      if (chipCloud && Array.isArray(chipCloud)) {
        chips = chipCloud
          .map((chip) => {
            const chipRenderer = chip.chipCloudChipRenderer;
            if (!chipRenderer) {
              return null;
            }
            return {
              title: chipRenderer.text?.runs?.[0]?.text || '',
              params:
                chipRenderer.navigationEndpoint?.browseEndpoint?.params || null,
              isSelected: chipRenderer.isSelected || false,
            };
          })
          .filter((c) => c && c.params && !c.isSelected);
      }

      // Get continuation token for more sections
      continuation =
        sectionListRenderer?.continuations?.[0]?.nextContinuationData
          ?.continuation ||
        sectionListRenderer?.continuations?.[0]?.reloadContinuationData
          ?.continuation;
      content?.forEach((section, idx) => {
        if (section.musicCarouselShelfRenderer) {
          const shelf = section.musicCarouselShelfRenderer;
          const headerRenderer =
            shelf.header?.musicCarouselShelfBasicHeaderRenderer;
          const title = headerRenderer?.title?.runs?.[0]?.text || '';
          const strapline = headerRenderer?.strapline?.runs?.[0]?.text;
          const items =
            shelf.contents
              ?.map((item) => this.parseItem(item))
              .filter((i) => i) || [];
          if (items.length > 0) {
            sections.push({
              title,
              strapline,
              contents: items,
            });
          }
        } else if (section.musicImmersiveCarouselShelfRenderer) {
          // Handle immersive carousel (sometimes used for featured content)
          const shelf = section.musicImmersiveCarouselShelfRenderer;
          const headerRenderer =
            shelf.header?.musicCarouselShelfBasicHeaderRenderer;
          const title = headerRenderer?.title?.runs?.[0]?.text || 'Featured';
          const strapline = headerRenderer?.strapline?.runs?.[0]?.text;
          const items =
            shelf.contents
              ?.map((item) => this.parseItem(item))
              .filter((i) => i) || [];
          if (items.length > 0) {
            sections.push({
              title,
              strapline,
              contents: items,
            });
          }
        } else {
        }
      });
    } catch (e) {
      console.error('Parse Home With Continuation Error', e);
    }
    return { sections, continuation, chips };
  }

  /**
   * Parse home continuation response
   * Handles both continuationContents (proper continuation) and contents (fallback)
   */
  static parseHomeContinuation(data) {
    const sections = [];
    let continuation = null;

    try {
      const sectionListContinuation =
        data?.continuationContents?.sectionListContinuation;

      if (sectionListContinuation) {
        // Get next continuation token
        continuation =
          sectionListContinuation.continuations?.[0]?.nextContinuationData
            ?.continuation ||
          sectionListContinuation.continuations?.[0]?.reloadContinuationData
            ?.continuation;

        // Parse sections
        sectionListContinuation.contents?.forEach((section, idx) => {
          if (section.musicCarouselShelfRenderer) {
            const shelf = section.musicCarouselShelfRenderer;
            const headerRenderer =
              shelf.header?.musicCarouselShelfBasicHeaderRenderer;
            const title = headerRenderer?.title?.runs?.[0]?.text || '';
            const strapline = headerRenderer?.strapline?.runs?.[0]?.text;
            const items =
              shelf.contents
                ?.map((item) => this.parseItem(item))
                .filter((i) => i) || [];
            if (items.length > 0) {
              sections.push({
                title,
                strapline,
                contents: items,
              });
            }
          }
        });
      } else if (data?.contents?.singleColumnBrowseResultsRenderer) {
        // Fallback: API returned fresh content instead of continuation
        // Parse it as a fresh response but skip duplicates
        const result = this.parseHomeWithContinuation(data);
        sections.push(...result.sections);
        continuation = result.continuation;
      } else {
      }
    } catch (e) {
      console.error('Parse Home Continuation Error', e);
    }
    return { sections, continuation };
  }

  static parseSearch(data, filter) {
    const results = [];
    try {
      const contents =
        data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer
          ?.content?.sectionListRenderer?.contents;
      if (!contents) {
        return [];
      }

      // YouTube wraps results in itemSectionRenderer - need to look inside
      let musicShelfRenderer = null;

      for (const section of contents) {
        // Check for DIRECT musicShelfRenderer (when results exist)
        if (section.musicShelfRenderer) {
          musicShelfRenderer = section.musicShelfRenderer;
          break;
        }

        // Check inside itemSectionRenderer wrapper (no results case)
        if (section.itemSectionRenderer?.contents) {
          for (const item of section.itemSectionRenderer.contents) {
            const keys = Object.keys(item);
            // Check for messageRenderer (no results message)
            if (item.messageRenderer) {
              const message = item.messageRenderer.text?.runs?.[0]?.text;
            }

            if (item.musicShelfRenderer) {
              musicShelfRenderer = item.musicShelfRenderer;
              break;
            }
          }
        }
        if (musicShelfRenderer) {
          break;
        }
      }

      if (!musicShelfRenderer) {
        return [];
      }

      if (musicShelfRenderer?.contents) {
        musicShelfRenderer.contents.forEach((item, idx) => {
          const parsed = this.parseItem(item);
          if (parsed) {
            results.push(parsed);
          }
        });
      }
    } catch (e) {
      console.error('Parse Search Error', e);
    }
    return results;
  }

  static parseArtist(data) {
    try {
      // Get artist header - try multiple possible renderers (OuterTune style)
      const immersiveHeader = data?.header?.musicImmersiveHeaderRenderer;
      const visualHeader = data?.header?.musicVisualHeaderRenderer;
      const detailHeader = data?.header?.musicDetailHeaderRenderer;
      const headerRenderer = data?.header?.musicHeaderRenderer;

      // Extract artist name from various header types
      const artistName =
        immersiveHeader?.title?.runs?.[0]?.text ||
        visualHeader?.title?.runs?.[0]?.text ||
        headerRenderer?.title?.runs?.[0]?.text ||
        detailHeader?.title?.runs?.[0]?.text;

      // Extract thumbnail - try all possible paths (OuterTune exact paths)
      const immersiveThumbs =
        immersiveHeader?.thumbnail?.musicThumbnailRenderer?.thumbnail
          ?.thumbnails;
      const visualThumbs =
        visualHeader?.foregroundThumbnail?.musicThumbnailRenderer?.thumbnail
          ?.thumbnails;
      const detailThumbs =
        detailHeader?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;

      // Get highest quality thumbnail
      const thumbnail =
        (immersiveThumbs?.length > 0
          ? immersiveThumbs[immersiveThumbs.length - 1]?.url
          : null) ||
        (visualThumbs?.length > 0
          ? visualThumbs[visualThumbs.length - 1]?.url
          : null) ||
        (detailThumbs?.length > 0
          ? detailThumbs[detailThumbs.length - 1]?.url
          : null);

      // Extract channel ID for subscription
      const channelId =
        immersiveHeader?.subscriptionButton?.subscribeButtonRenderer?.channelId;

      // Extract play/shuffle/radio endpoints from header
      const playEndpoint =
        data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
          ?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
          ?.musicShelfRenderer?.contents?.[0]?.musicResponsiveListItemRenderer
          ?.overlay?.musicItemThumbnailOverlayRenderer?.content
          ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint;

      const shuffleEndpoint =
        immersiveHeader?.playButton?.buttonRenderer?.navigationEndpoint
          ?.watchEndpoint ||
        data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
          ?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
          ?.musicShelfRenderer?.contents?.[0]?.musicResponsiveListItemRenderer
          ?.navigationEndpoint?.watchPlaylistEndpoint;

      const radioEndpoint =
        immersiveHeader?.startRadioButton?.buttonRenderer?.navigationEndpoint
          ?.watchEndpoint;

      // Extract share link
      const shareLink = `https://music.youtube.com/channel/${channelId || ''}`;

      // Extract description
      const description = immersiveHeader?.description?.runs?.[0]?.text;

      // Build artist object (matching OuterTune's ArtistItem structure)
      const artist = {
        id: channelId,
        title: artistName,
        thumbnail,
        channelId,
        playEndpoint,
        shuffleEndpoint,
        radioEndpoint,
        shareLink,
      };

      // Parse all sections dynamically (matching OuterTune's approach)
      const sectionContents =
        data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
          ?.tabRenderer?.content?.sectionListRenderer?.contents || [];

      const sections = [];

      for (const section of sectionContents) {
        const parsedSection = this.parseArtistSection(section);
        if (parsedSection && parsedSection.items.length > 0) {
          // Deduplicate items by id
          const seenIds = new Set();
          parsedSection.items = parsedSection.items.filter((item) => {
            const id = item.videoId || item.id || item.browseId;
            if (!id || seenIds.has(id)) {
              return false;
            }
            seenIds.add(id);
            return true;
          });
          sections.push(parsedSection);
        }
      }

      // Legacy support: also return flat arrays for backward compatibility
      const songs = [];
      const albums = [];
      const singles = [];
      const videos = [];
      const playlists = [];
      const relatedArtists = [];
      const seenSongIds = new Set();

      for (const sec of sections) {
        const titleLower = sec.title.toLowerCase();
        if (titleLower === 'songs' || titleLower.includes('song')) {
          // Deduplicate songs
          for (const item of sec.items) {
            const id = item.videoId || item.id;
            if (id && !seenSongIds.has(id)) {
              seenSongIds.add(id);
              songs.push(item);
            }
          }
        } else if (titleLower === 'albums') {
          albums.push(...sec.items);
        } else if (
          titleLower === 'singles' ||
          titleLower.includes('single') ||
          titleLower.includes('ep')
        ) {
          singles.push(...sec.items);
        } else if (titleLower === 'videos' || titleLower.includes('video')) {
          videos.push(...sec.items);
        } else if (titleLower.includes('playlist')) {
          playlists.push(...sec.items);
        } else if (
          titleLower.includes('fans might') ||
          titleLower.includes('similar') ||
          titleLower.includes('like')
        ) {
          relatedArtists.push(...sec.items);
        }
      }

      return {
        artist,
        sections,
        description,
        // Legacy flat arrays for backward compatibility
        name: artistName,
        songs,
        albums,
        singles,
        videos,
        playlists,
        relatedArtists,
        thumbnails: thumbnail ? [{ url: thumbnail }] : [],
      };
    } catch (e) {
      console.error('parseArtist error:', e);
      return null;
    }
  }

  /**
   * Parse individual artist section (musicShelfRenderer or musicCarouselShelfRenderer)
   * Matching OuterTune's ArtistPage.fromSectionListRendererContent
   */
  static parseArtistSection(section) {
    try {
      // Handle musicShelfRenderer (songs displayed as list)
      if (section.musicShelfRenderer) {
        const renderer = section.musicShelfRenderer;
        const title = renderer.title?.runs?.[0]?.text || '';

        // OuterTune uses getItems() which handles continuationItemRenderer
        const rawContents = renderer.contents || [];

        const items =
          rawContents
            .map((i) => this.parseArtistSongItem(i))
            .filter((i) => i) || [];
        const moreEndpoint =
          renderer.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint;

        return {
          title,
          items,
          moreEndpoint: moreEndpoint
            ? {
                browseId: moreEndpoint.browseId,
                params: moreEndpoint.params,
              }
            : null,
          type: 'songs',
        };
      }

      // Handle musicCarouselShelfRenderer (albums, playlists, artists as horizontal scroll)
      if (section.musicCarouselShelfRenderer) {
        const renderer = section.musicCarouselShelfRenderer;
        const headerRenderer =
          renderer.header?.musicCarouselShelfBasicHeaderRenderer;
        const title = headerRenderer?.title?.runs?.[0]?.text || '';
        const moreEndpoint =
          headerRenderer?.moreContentButton?.buttonRenderer?.navigationEndpoint
            ?.browseEndpoint;

        const rawContents = renderer.contents || [];

        const items =
          rawContents
            .map((i) => {
              if (i.musicTwoRowItemRenderer) {
                return this.parseMusicTwoRowItem(i.musicTwoRowItemRenderer);
              }
              if (i.musicResponsiveListItemRenderer) {
                return this.parseArtistSongItem(i);
              }
              return this.parseItem(i);
            })
            .filter((i) => i) || [];

        // Determine section type based on first item's type OR title
        let type = 'carousel';
        const firstItem = items[0];
        if (firstItem?.type === 'artist') {
          type = 'artists';
        } else if (firstItem?.type === 'album') {
          type = 'albums';
        } else if (firstItem?.type === 'playlist') {
          type = 'playlists';
        } else if (firstItem?.type === 'song') {
          type = 'songs';
        } else {
          // Fallback to title-based detection
          const titleLower = title.toLowerCase();
          if (titleLower.includes('album')) {
            type = 'albums';
          } else if (
            titleLower.includes('single') ||
            titleLower.includes('ep')
          ) {
            type = 'singles';
          } else if (titleLower.includes('video')) {
            type = 'videos';
          } else if (titleLower.includes('playlist')) {
            type = 'playlists';
          } else if (
            titleLower.includes('fan') ||
            titleLower.includes('like') ||
            titleLower.includes('similar')
          ) {
            type = 'artists';
          } else if (titleLower.includes('featured')) {
            type = 'featured';
          } else if (titleLower.includes('live')) {
            type = 'live';
          }
        }

        return {
          title,
          items,
          moreEndpoint: moreEndpoint
            ? {
                browseId: moreEndpoint.browseId,
                params: moreEndpoint.params,
              }
            : null,
          type,
        };
      }

      // Unknown section type
      return null;
    } catch (e) {
      console.error('parseArtistSection error:', e);
      return null;
    }
  }

  /**
   * Parse song item from artist's songs section (musicResponsiveListItemRenderer)
   * Matches OuterTune's fromMusicResponsiveListItemRenderer in ArtistPage.kt
   */
  static parseArtistSongItem(itemWrapper) {
    try {
      const renderer = itemWrapper.musicResponsiveListItemRenderer;
      if (!renderer) {
        return this.parseItem(itemWrapper);
      }

      // OuterTune: id = renderer.playlistItemData?.videoId ?: return null
      const videoId = renderer.playlistItemData?.videoId;
      if (!videoId) {
        return null;
      }

      // OuterTune: title = renderer.flexColumns.firstOrNull()?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.firstOrNull()?.text
      const title =
        renderer.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer
          ?.text?.runs?.[0]?.text;
      if (!title) {
        return null;
      }

      // OuterTune: artists = PageHelper.extractRuns(renderer.flexColumns, "MUSIC_PAGE_TYPE_ARTIST").oddElements()
      // Simplified: get artists from second column, odd indices are artist names
      const artistRuns =
        renderer.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer
          ?.text?.runs || [];
      const artists = artistRuns
        .filter((_, idx) => idx % 2 === 0)
        .map((run) => ({
          name: run.text,
          id: run.navigationEndpoint?.browseEndpoint?.browseId,
        }));

      // OuterTune: album = from flexColumns using MUSIC_PAGE_TYPE_ALBUM
      const albumRuns =
        renderer.flexColumns?.[2]?.musicResponsiveListItemFlexColumnRenderer
          ?.text?.runs ||
        renderer.flexColumns?.[3]?.musicResponsiveListItemFlexColumnRenderer
          ?.text?.runs;
      const album = albumRuns?.[0]
        ? {
            name: albumRuns[0].text,
            id: albumRuns[0].navigationEndpoint?.browseEndpoint?.browseId,
          }
        : null;

      // OuterTune: thumbnail = renderer.thumbnail?.musicThumbnailRenderer?.getThumbnailUrl()
      const thumbnails =
        renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
      const thumbnail =
        thumbnails?.length > 0 ? thumbnails[thumbnails.length - 1]?.url : null;

      const explicit = renderer.badges?.some(
        (b) =>
          b.musicInlineBadgeRenderer?.icon?.iconType === 'MUSIC_EXPLICIT_BADGE'
      );
      const endpoint =
        renderer.overlay?.musicItemThumbnailOverlayRenderer?.content
          ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint;

      return {
        videoId,
        id: videoId,
        title,
        name: title,
        artists,
        artist: artists.map((a) => a.name).join(', '),
        album,
        thumbnail,
        thumbnails: thumbnails || [],
        explicit,
        endpoint,
        type: 'song',
        image: [{ url: thumbnail, quality: 'hd' }],
        artwork: thumbnail,
      };
    } catch (e) {
      console.error('parseArtistSongItem error:', e);
      return this.parseItem(itemWrapper);
    }
  }

  /**
   * Parse musicTwoRowItemRenderer (albums, playlists, artists in carousel)
   * Uses pageType from browseEndpointContextSupportedConfigs like OuterTune
   */
  static parseMusicTwoRowItem(renderer) {
    try {
      const title = renderer.title?.runs?.[0]?.text;
      const thumbnails =
        renderer.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail
          ?.thumbnails;
      const thumbnail =
        thumbnails?.length > 0 ? thumbnails[thumbnails.length - 1]?.url : null;
      const subtitle =
        renderer.subtitle?.runs?.map((r) => r.text).join('') || '';

      const browseEndpoint = renderer.navigationEndpoint?.browseEndpoint;
      const watchEndpoint = renderer.navigationEndpoint?.watchEndpoint;
      const browseId = browseEndpoint?.browseId;

      // Get pageType from browseEndpointContextSupportedConfigs (OuterTune method)
      const pageType =
        browseEndpoint?.browseEndpointContextSupportedConfigs
          ?.browseEndpointContextMusicConfig?.pageType;

      // Song (has watchEndpoint with videoId) - OuterTune: isSong = navigationEndpoint.endpoint is WatchEndpoint
      if (watchEndpoint?.videoId) {
        const artistRun = renderer.subtitle?.runs?.[0];
        return {
          videoId: watchEndpoint.videoId,
          id: watchEndpoint.videoId,
          title,
          name: title,
          artists: artistRun
            ? [
                {
                  name: artistRun.text,
                  id: artistRun.navigationEndpoint?.browseEndpoint?.browseId,
                },
              ]
            : [],
          artist: artistRun?.text || 'Unknown',
          thumbnail,
          thumbnails: thumbnails || [],
          explicit: renderer.subtitleBadges?.some(
            (b) =>
              b.musicInlineBadgeRenderer?.icon?.iconType ===
              'MUSIC_EXPLICIT_BADGE'
          ),
          type: 'song',
          image: [{ url: thumbnail }],
          artwork: thumbnail,
        };
      }

      // Album - OuterTune: isAlbum = pageType == MUSIC_PAGE_TYPE_ALBUM || MUSIC_PAGE_TYPE_AUDIOBOOK
      if (
        pageType === 'MUSIC_PAGE_TYPE_ALBUM' ||
        pageType === 'MUSIC_PAGE_TYPE_AUDIOBOOK' ||
        browseId?.startsWith('MPRE') ||
        browseId?.startsWith('OLAK')
      ) {
        const playlistId =
          renderer.thumbnailOverlay?.musicItemThumbnailOverlayRenderer?.content
            ?.musicPlayButtonRenderer?.playNavigationEndpoint?.anyWatchEndpoint
            ?.playlistId ||
          renderer.thumbnailOverlay?.musicItemThumbnailOverlayRenderer?.content
            ?.musicPlayButtonRenderer?.playNavigationEndpoint
            ?.watchPlaylistEndpoint?.playlistId;

        const yearRun = renderer.subtitle?.runs?.slice(-1)[0];
        const year = yearRun?.text?.match(/^\d{4}$/)
          ? parseInt(yearRun.text)
          : null;

        return {
          browseId,
          id: browseId,
          playlistId,
          title,
          name: title,
          thumbnail,
          thumbnails: thumbnails || [],
          year,
          subtitle,
          explicit: renderer.subtitleBadges?.some(
            (b) =>
              b.musicInlineBadgeRenderer?.icon?.iconType ===
              'MUSIC_EXPLICIT_BADGE'
          ),
          type: 'album',
          image: [{ url: thumbnail }],
        };
      }

      // Playlist - OuterTune: isPlaylist = pageType == MUSIC_PAGE_TYPE_PLAYLIST
      if (
        pageType === 'MUSIC_PAGE_TYPE_PLAYLIST' ||
        browseId?.startsWith('VL') ||
        browseId?.startsWith('PL') ||
        browseId?.startsWith('RDCLAK')
      ) {
        const playlistId = browseId?.startsWith('VL')
          ? browseId.substring(2)
          : browseId;
        const authorRun = renderer.subtitle?.runs?.slice(-1)[0];

        // Get play/shuffle/radio endpoints like OuterTune
        const playEndpoint =
          renderer.thumbnailOverlay?.musicItemThumbnailOverlayRenderer?.content
            ?.musicPlayButtonRenderer?.playNavigationEndpoint
            ?.watchPlaylistEndpoint;
        const menuItems = renderer.menu?.menuRenderer?.items || [];
        const shuffleEndpoint = menuItems.find(
          (i) =>
            i.menuNavigationItemRenderer?.icon?.iconType === 'MUSIC_SHUFFLE'
        )?.menuNavigationItemRenderer?.navigationEndpoint
          ?.watchPlaylistEndpoint;
        const radioEndpoint = menuItems.find(
          (i) => i.menuNavigationItemRenderer?.icon?.iconType === 'MIX'
        )?.menuNavigationItemRenderer?.navigationEndpoint
          ?.watchPlaylistEndpoint;

        return {
          id: playlistId,
          browseId,
          playlistId,
          title,
          name: title,
          thumbnail,
          thumbnails: thumbnails || [],
          author: authorRun?.text,
          subtitle,
          type: 'playlist',
          playEndpoint,
          shuffleEndpoint,
          radioEndpoint,
          image: [{ url: thumbnail }],
        };
      }

      // Artist - OuterTune: isArtist = pageType == MUSIC_PAGE_TYPE_ARTIST
      if (pageType === 'MUSIC_PAGE_TYPE_ARTIST' || browseId?.startsWith('UC')) {
        const menuItems = renderer.menu?.menuRenderer?.items || [];
        const channelId = menuItems.find(
          (i) =>
            i.toggleMenuServiceItemRenderer?.defaultIcon?.iconType ===
            'SUBSCRIBE'
        )?.toggleMenuServiceItemRenderer?.defaultServiceEndpoint
          ?.subscribeEndpoint?.channelIds?.[0];
        const shuffleEndpoint = menuItems.find(
          (i) =>
            i.menuNavigationItemRenderer?.icon?.iconType === 'MUSIC_SHUFFLE'
        )?.menuNavigationItemRenderer?.navigationEndpoint
          ?.watchPlaylistEndpoint;
        const radioEndpoint = menuItems.find(
          (i) => i.menuNavigationItemRenderer?.icon?.iconType === 'MIX'
        )?.menuNavigationItemRenderer?.navigationEndpoint
          ?.watchPlaylistEndpoint;

        return {
          id: browseId,
          browseId,
          channelId,
          title,
          name: title,
          thumbnail,
          thumbnails: thumbnails || [],
          subtitle,
          type: 'artist',
          shuffleEndpoint,
          radioEndpoint,
          image: [{ url: thumbnail }],
        };
      }

      // Generic fallback
      return {
        id: browseId || watchEndpoint?.videoId,
        browseId,
        title,
        name: title,
        thumbnail,
        thumbnails: thumbnails || [],
        subtitle,
        type: 'unknown',
        image: [{ url: thumbnail }],
      };
    } catch (e) {
      console.error('parseMusicTwoRowItem error:', e);
      return null;
    }
  }

  static parseAlbum(data) {
    try {
      // Debug: Log top-level keys to understand structure
      // Check for error response first
      if (data?.error) {
        console.error(
          'parseAlbum: API error response:',
          JSON.stringify(data.error)
        );
        return null;
      }

      if (data?.contents) {
      }
      if (data?.header) {
      }

      // Try multiple possible structures for album header
      let header =
        data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer
          ?.content?.sectionListRenderer?.contents?.[0]
          ?.musicResponsiveHeaderRenderer;

      // Alternative structure: some albums use musicDetailHeaderRenderer in header
      if (!header) {
        header = data?.header?.musicDetailHeaderRenderer;
      }

      // Alternative: musicImmersiveHeaderRenderer (used for some albums)
      if (!header) {
        header = data?.header?.musicImmersiveHeaderRenderer;
      }

      // Another alternative: singleColumnBrowseResultsRenderer for some album types
      if (!header) {
        header =
          data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
            ?.musicResponsiveHeaderRenderer;
      }

      // Fallback: Check in twoColumnBrowseResultsRenderer directly
      if (!header) {
        const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs;
        if (tabs && tabs.length > 0) {
          const tabContent = tabs[0]?.tabRenderer?.content;
          if (tabContent?.sectionListRenderer?.contents) {
            for (const section of tabContent.sectionListRenderer.contents) {
              if (section.musicResponsiveHeaderRenderer) {
                header = section.musicResponsiveHeaderRenderer;
                break;
              }
              if (section.musicDetailHeaderRenderer) {
                header = section.musicDetailHeaderRenderer;
                break;
              }
            }
          }
        }
      }

      // Try multiple possible structures for tracks
      let tracksContent =
        data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents
          ?.sectionListRenderer?.contents?.[0]?.musicPlaylistShelfRenderer
          ?.contents;

      // Alternative: musicShelfRenderer in secondaryContents
      if (!tracksContent) {
        tracksContent =
          data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents
            ?.sectionListRenderer?.contents?.[0]?.musicShelfRenderer?.contents;
      }

      // Alternative: Check all sections in secondaryContents
      if (!tracksContent) {
        const secondaryContents =
          data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents
            ?.sectionListRenderer?.contents;
        if (secondaryContents) {
          for (const section of secondaryContents) {
            if (section.musicPlaylistShelfRenderer?.contents) {
              tracksContent = section.musicPlaylistShelfRenderer.contents;
              break;
            }
            if (section.musicShelfRenderer?.contents) {
              tracksContent = section.musicShelfRenderer.contents;
              break;
            }
          }
        }
      }

      // Another alternative for single column layout
      if (!tracksContent) {
        const sectionContents =
          data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content?.sectionListRenderer?.contents;
        for (const section of sectionContents || []) {
          if (section.musicShelfRenderer?.contents) {
            tracksContent = section.musicShelfRenderer.contents;
            break;
          }
          if (section.musicPlaylistShelfRenderer?.contents) {
            tracksContent = section.musicPlaylistShelfRenderer.contents;
            break;
          }
        }
      }

      // Extract title from multiple possible paths
      let title = header?.title?.runs?.[0]?.text || header?.title?.simpleText;

      // Fallback: Try to get title from menu or other header properties
      if (!title && header?.menu?.menuRenderer?.title?.runs) {
        title = header.menu.menuRenderer.title.runs[0]?.text;
      }

      // Artist can be in different places - try more paths
      let artist =
        header?.straplineTextOne?.runs?.[0]?.text ||
        header?.subtitle?.runs?.[0]?.text ||
        header?.secondTitle?.runs?.[0]?.text;

      // Fallback: Try to find artist in subtitle runs with navigation to artist page
      if (!artist && header?.subtitle?.runs) {
        for (const run of header.subtitle.runs) {
          const browseEndpoint = run.navigationEndpoint?.browseEndpoint;
          if (browseEndpoint?.browseId?.startsWith('UC')) {
            artist = run.text;
            break;
          }
        }
        // If still no artist, just take first run
        if (!artist && header.subtitle.runs.length > 0) {
          artist = header.subtitle.runs[0].text;
        }
      }

      // Year extraction - try multiple positions
      let year = null;
      const subtitleRuns = header?.subtitle?.runs;
      if (subtitleRuns && Array.isArray(subtitleRuns)) {
        for (const run of subtitleRuns) {
          if (run.text && /^\d{4}$/.test(run.text)) {
            year = run.text;
            break;
          }
        }
      }

      // Get thumbnails array (not just single thumbnail) - try more paths
      let thumbnailsData =
        header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
        header?.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail
          ?.thumbnails ||
        [];

      // Fallback: Try foregroundThumbnail (used in musicImmersiveHeaderRenderer)
      if (thumbnailsData.length === 0) {
        thumbnailsData =
          header?.foregroundThumbnail?.musicThumbnailRenderer?.thumbnail
            ?.thumbnails || [];
      }

      // Create thumbnails array in expected format
      const thumbnails = thumbnailsData.map((thumb) => ({
        url: enhanceYTMusicArtwork(thumb.url, 'album-header'),
        link: enhanceYTMusicArtwork(thumb.url, 'album-header'),
        width: thumb.width,
        height: thumb.height,
      }));

      // Parse tracks
      const tracks =
        tracksContent?.map((t) => this.parseItem(t)).filter((i) => i) || [];

      // Get browseId from the data if available
      const browseId =
        data?.responseContext?.serviceTrackingParams?.[0]?.params?.find(
          (p) => p.key === 'browse_id'
        )?.value;
      // Return in format expected by getYTMusicAlbumData
      return {
        title,
        artist,
        artists: artist ? [{ name: artist, id: null }] : [],
        year,
        thumbnails, // Array format expected by getYTMusicAlbumData
        thumbnail: thumbnails[thumbnails.length - 1]?.url, // Also include single for backward compat
        tracks, // 'tracks' expected by getYTMusicAlbumData
        songs: tracks, // Also include 'songs' for backward compat
        browseId,
      };
    } catch (e) {
      console.error('parseAlbum error:', e);
      return null;
    }
  }

  static parseSection(data) {
    try {
      // Check for various renderer types
      const tabContent =
        data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
          ?.tabRenderer?.content;
      const sectionList = tabContent?.sectionListRenderer?.contents;
      const secondaryContents =
        data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents
          ?.sectionListRenderer?.contents;

      // Grid Renderer
      const gridRenderer =
        sectionList?.[0]?.gridRenderer ||
        secondaryContents?.[0]?.gridRenderer ||
        tabContent?.gridRenderer || // Direct grid renderer
        data?.continuationContents?.gridContinuation;

      // Music Shelf Renderer (List of Songs)
      const musicShelfRenderer =
        sectionList?.[0]?.musicShelfRenderer ||
        secondaryContents?.[0]?.musicShelfRenderer ||
        tabContent?.musicShelfRenderer || // Direct shelf renderer
        data?.continuationContents?.musicShelfContinuation;

      // Playlist Shelf Renderer (Playlist content)
      const musicPlaylistShelfRenderer =
        sectionList?.[0]?.musicPlaylistShelfRenderer ||
        secondaryContents?.[0]?.musicPlaylistShelfRenderer ||
        tabContent?.musicPlaylistShelfRenderer || // Direct playlist shelf
        data?.continuationContents?.musicPlaylistShelfContinuation;

      const section =
        gridRenderer || musicShelfRenderer || musicPlaylistShelfRenderer;

      const header = data?.header?.musicHeaderRenderer;
      const title = header?.title?.runs?.[0]?.text || '';

      const rawItems = section?.items || section?.contents || [];
      const items = rawItems
        .map((i) => {
          if (i.musicTwoRowItemRenderer) {
            return this.parseMusicTwoRowItem(i.musicTwoRowItemRenderer);
          }
          if (i.musicResponsiveListItemRenderer) {
            return this.parseArtistSongItem(i);
          }
          return this.parseItem(i);
        })
        .filter((i) => i);

      // Get continuation token - check multiple locations
      const continuations = section?.continuations;
      const continuation =
        continuations?.[0]?.nextContinuationData?.continuation;
      return {
        title,
        items,
        continuation,
      };
    } catch (e) {
      console.error('parseSection error:', e);
      return { items: [], continuation: null };
    }
  }

  static parsePlaylist(data) {
    try {
      // Debug: Log structure
      if (data?.header) {
      }
      if (data?.contents) {
      }

      // Try multiple header locations
      let header = data?.header?.musicDetailHeaderRenderer;

      // Alternative: musicEditablePlaylistDetailHeaderRenderer (for editable playlists)
      if (!header && data?.header?.musicEditablePlaylistDetailHeaderRenderer) {
        header =
          data.header.musicEditablePlaylistDetailHeaderRenderer.header
            ?.musicDetailHeaderRenderer ||
          data.header.musicEditablePlaylistDetailHeaderRenderer.header
            ?.musicResponsiveHeaderRenderer ||
          data.header.musicEditablePlaylistDetailHeaderRenderer;
      }

      // Alternative: musicVisualHeaderRenderer (for some album playlists)
      if (!header) {
        header = data?.header?.musicVisualHeaderRenderer;
      }

      // Alternative: musicImmersiveHeaderRenderer
      if (!header) {
        header = data?.header?.musicImmersiveHeaderRenderer;
      }

      if (!header) {
        // Try finding responsive header in contents
        const sectionList =
          data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer
            ?.content?.sectionListRenderer?.contents;
        header = sectionList?.[0]?.musicResponsiveHeaderRenderer;
      }

      // Try single column layout
      if (!header) {
        const singleColumnSections =
          data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content?.sectionListRenderer?.contents;
        if (singleColumnSections) {
          for (const section of singleColumnSections) {
            if (section.musicResponsiveHeaderRenderer) {
              header = section.musicResponsiveHeaderRenderer;
              break;
            }
            if (section.musicDetailHeaderRenderer) {
              header = section.musicDetailHeaderRenderer;
              break;
            }
          }
        }
      }

      // Try multiple tracks locations
      let tracks =
        data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents
          ?.sectionListRenderer?.contents?.[0]?.musicPlaylistShelfRenderer
          ?.contents;

      // Alternative: primary contents area
      if (!tracks) {
        tracks =
          data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer
            ?.content?.sectionListRenderer?.contents?.[0]
            ?.musicPlaylistShelfRenderer?.contents;
      }

      // Single column layout
      if (!tracks) {
        tracks =
          data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
            ?.musicPlaylistShelfRenderer?.contents;
      }

      // Try looking in all sections
      if (!tracks) {
        const allSections =
          data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents
            ?.sectionListRenderer?.contents ||
          data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content?.sectionListRenderer?.contents ||
          [];
        for (const section of allSections) {
          if (section.musicPlaylistShelfRenderer?.contents) {
            tracks = section.musicPlaylistShelfRenderer.contents;
            break;
          }
          if (section.musicShelfRenderer?.contents) {
            tracks = section.musicShelfRenderer.contents;
            break;
          }
        }
      }

      // Extract title from multiple possible paths
      let title = header?.title?.runs?.[0]?.text || header?.title?.simpleText;

      // Fallback: Try strapline (used in some headers)
      if (!title) {
        title = header?.strapline?.runs?.[0]?.text;
      }

      // Extract songs
      const songs =
        tracks?.map((t) => this.parseItem(t)).filter((i) => i) || [];

      // If we still don't have a title but have songs, try to get album name from first song
      if (!title && songs.length > 0) {
        const firstSong = songs[0];
        if (firstSong.album?.name) {
          title = firstSong.album.name;
        }
      }

      // Extract additional metadata - try more paths
      let thumbnails =
        header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
        header?.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail
          ?.thumbnails ||
        header?.foregroundThumbnail?.musicThumbnailRenderer?.thumbnail
          ?.thumbnails;

      // Fallback: Get thumbnail from first song
      if ((!thumbnails || thumbnails.length === 0) && songs.length > 0) {
        const firstSongThumb = songs[0].thumbnail || songs[0].artwork;
        if (firstSongThumb) {
          thumbnails = [{ url: firstSongThumb }];
        }
      }

      const description =
        header?.description?.runs?.[0]?.text || header?.description?.simpleText;

      // Author/Subtitle extraction
      let author = 'YouTube Music';
      let year = null;

      // Subtitle runs logic depends on header type
      const subtitleRuns =
        header?.subtitle?.runs ||
        header?.straplineTextOne?.runs ||
        header?.secondSubtitle?.runs;

      if (subtitleRuns) {
        author =
          subtitleRuns?.find((r) =>
            r.navigationEndpoint?.browseEndpoint?.browseId?.startsWith('UC')
          )?.text ||
          subtitleRuns?.[0]?.text ||
          'YouTube Music';
        const yearMatch = subtitleRuns?.find((r) => r.text?.match(/^\d{4}$/));
        year = yearMatch?.text || null;
      }

      // If no author found but songs have artist info, use first song's artist
      if (author === 'YouTube Music' && songs.length > 0 && songs[0].artist) {
        author = songs[0].artist;
      }

      // Extract playlist thumbnail
      const playlistThumbnail = thumbnails?.[thumbnails?.length - 1]?.url;

      // Extract ID safely
      const headerId =
        header?.menu?.menuRenderer?.topLevelButtons?.[0]?.buttonRenderer
          ?.navigationEndpoint?.watchEndpoint?.playlistId;
      const dataBrowseId =
        data?.responseContext?.serviceTrackingParams?.[0]?.params?.find(
          (p) => p.key === 'browse_id'
        )?.value;
      // Clean VL prefix if present in the data browseId
      const cleanBrowseId = dataBrowseId?.startsWith('VL')
        ? dataBrowseId.substring(2)
        : dataBrowseId;

      // Extract continuation token
      // We need to find the renderer that contained the tracks again to get its continuation
      let continuation = null;

      // Re-find the renderer that holds the tracks
      const allSections =
        data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents
          ?.sectionListRenderer?.contents ||
        data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
          ?.tabRenderer?.content?.sectionListRenderer?.contents ||
        data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer
          ?.content?.sectionListRenderer?.contents?.[0]
          ?.musicPlaylistShelfRenderer
          ? [
              {
                musicPlaylistShelfRenderer:
                  data.contents.twoColumnBrowseResultsRenderer.tabs[0]
                    .tabRenderer.content.sectionListRenderer.contents[0]
                    .musicPlaylistShelfRenderer,
              },
            ]
          : [];

      for (const section of allSections) {
        if (section.musicPlaylistShelfRenderer) {
          if (section.musicPlaylistShelfRenderer.contents) {
            continuation =
              section.musicPlaylistShelfRenderer.continuations?.[0]
                ?.nextContinuationData?.continuation;
            break;
          }
        } else if (section.musicShelfRenderer) {
          if (section.musicShelfRenderer.contents) {
            continuation =
              section.musicShelfRenderer.continuations?.[0]
                ?.nextContinuationData?.continuation;
            break;
          }
        }
      }

      const id = headerId || cleanBrowseId;
      return {
        id,
        title,
        songs,
        thumbnails: thumbnails || [],
        thumbnail: playlistThumbnail,
        description,
        author,
        year,
        count: songs.length,
        continuation,
      };
    } catch (e) {
      console.error('Parse Playlist Error', e);
      return null;
    }
  }

  static parseRelated(data) {
    try {
      const panel =
        data?.contents?.singleColumnMusicWatchNextResultsRenderer
          ?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]
          ?.tabRenderer?.content?.musicQueueRenderer?.content
          ?.playlistPanelRenderer;
      const items =
        panel?.contents?.map((i) => this.parseItem(i)).filter((i) => i) || [];
      return items;
    } catch (e) {
      return null;
    }
  }

  /**
   * Parse Next/Recommendations response
   * Returns an object with items (songs), continuation token, and automix playlist ID
   */
  static parseNext(data) {
    try {
      const panel =
        data?.contents?.singleColumnMusicWatchNextResultsRenderer
          ?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]
          ?.tabRenderer?.content?.musicQueueRenderer?.content
          ?.playlistPanelRenderer;

      if (!panel) {
        return { items: [], continuation: null, automixPlaylistId: null };
      }

      // Parse all items (songs) - skip automix preview items for now
      const items = [];
      let automixPlaylistId = null;

      for (const item of panel.contents || []) {
        // Check for automix preview - extract the playlist endpoint
        if (item.automixPreviewVideoRenderer) {
          const watchEndpoint =
            item.automixPreviewVideoRenderer?.content
              ?.automixPlaylistVideoRenderer?.navigationEndpoint
              ?.watchPlaylistEndpoint;
          if (watchEndpoint?.playlistId) {
            automixPlaylistId = watchEndpoint.playlistId;
          }
          continue;
        }

        const parsed = this.parseItem(item);
        if (parsed) {
          items.push(parsed);
        }
      }

      // Get continuation token for loading more recommendations
      const continuation =
        panel.continuations?.[0]?.nextContinuationData?.continuation || null;
      return {
        items,
        continuation,
        automixPlaylistId,
        // Also return the title if available
        title:
          data?.contents?.singleColumnMusicWatchNextResultsRenderer
            ?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content?.musicQueueRenderer?.header
            ?.musicQueueHeaderRenderer?.subtitle?.runs?.[0]?.text || null,
      };
    } catch (e) {
      console.error('Parse Next Error:', e);
      return { items: [], continuation: null, automixPlaylistId: null };
    }
  }

  // --- generic Item Parser ---
  static parseItem(itemWrapper) {
    try {
      const item =
        itemWrapper.musicResponsiveListItemRenderer ||
        itemWrapper.musicTwoRowItemRenderer ||
        itemWrapper.playlistPanelVideoRenderer;
      if (!item) {
        // Debug: log what keys are present in itemWrapper
        return null;
      }

      // CRITICAL: Search results store videoId in playlistItemData.videoId (OuterTune's approach)
      // Also try overlay for album tracks which use a different structure
      const videoId =
        item.playlistItemData?.videoId ||
        item.videoId ||
        item.onTap?.watchEndpoint?.videoId ||
        item.navigationEndpoint?.watchEndpoint?.videoId ||
        item.overlay?.musicItemThumbnailOverlayRenderer?.content
          ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint
          ?.videoId;
      let browseId =
        item.navigationEndpoint?.browseEndpoint?.browseId ||
        item.onTap?.browseEndpoint?.browseId;

      // Try flexColumns first (used in search results), then fallback to direct title
      let title =
        item.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text
          ?.runs?.[0]?.text;
      if (!title) {
        title = item.title?.runs?.[0]?.text || item.title?.simpleText;
      }

      // Thumbnail - get highest quality available
      const thumbnails =
        item.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
        item.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
        item.thumbnails ||
        [];

      // Sort thumbnails by width (ascending) to match Saavn format (highest quality last)
      const sortedThumbnails = [...thumbnails].sort(
        (a, b) => (a.width || 0) - (b.width || 0)
      );
      let thumbnail = sortedThumbnails[sortedThumbnails.length - 1]?.url;

      // If we have a videoId, construct the highest quality YouTube thumbnail URL
      // YouTube provides these quality levels:
      // - maxresdefault.jpg (1280x720)
      // - sddefault.jpg (640x480)
      // - hqdefault.jpg (480x360)
      // - mqdefault.jpg (320x180)
      if (
        videoId &&
        (!thumbnail || thumbnail.includes('60-') || thumbnail.includes('w60'))
      ) {
        thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      }

      // Also provide a high-res version for full player
      const highResThumbnail = videoId
        ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
        : thumbnail;

      // Type detection
      let type = 'song';
      let playlistId = null;

      if (
        browseId &&
        (browseId.startsWith('MPRE') || browseId.startsWith('OLAK'))
      ) {
        type = 'album';
      }
      if (browseId && browseId.startsWith('VL')) {
        type = 'playlist';
        playlistId = browseId;
      } else if (browseId && browseId.startsWith('PL')) {
        playlistId = `VL${browseId}`;
        type = 'playlist';
      }
      if (browseId && browseId.startsWith('UC')) {
        type = 'artist';
      }

      if (itemWrapper.musicTwoRowItemRenderer && !videoId && type === 'song') {
        type = 'album/playlist';
      }

      // Artist extraction - handle multiple structures:
      // 1. Search results: flexColumns[1].text.runs
      // 2. Recommendations (playlistPanelVideoRenderer): longBylineText.runs or shortBylineText.runs
      let artist = 'Unknown';
      let artistsList = [];

      // Try flexColumns first (search results)
      const flexColumn1 =
        item.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text
          ?.runs;
      if (flexColumn1 && Array.isArray(flexColumn1) && flexColumn1.length > 0) {
        // Filter to get only even-indexed elements (skip " • " separators)
        const oddElements = flexColumn1.filter((_, index) => index % 2 === 0);
        artistsList = oddElements.map((run) => ({
          name: run.text,
          id: run.navigationEndpoint?.browseEndpoint?.browseId,
        }));
        artist = oddElements.map((run) => run.text).join(', ') || 'Unknown';
      }
      // Try longBylineText (used in playlistPanelVideoRenderer for recommendations)
      else if (
        item.longBylineText?.runs &&
        Array.isArray(item.longBylineText.runs)
      ) {
        const runs = item.longBylineText.runs;
        // Filter out view counts, likes, and other metadata - only keep actual artist names
        // Format is often: "Artist • 91M views • 533K likes" or "Artist1, Artist2 • Album"
        const artistRuns = runs.filter((run, index) => {
          // Skip separator runs (odd indices like " • ")
          if (index % 2 !== 0) {
            return false;
          }
          const text = run.text?.toLowerCase() || '';
          // Skip metadata patterns: views, likes, subscribers, plays, etc.
          if (
            /\d+[KMB]?\s*(views?|likes?|subscribers?|plays?|listens?)/i.test(
              run.text
            )
          ) {
            return false;
          }
          // Skip year-only entries (4 digits)
          if (/^\d{4}$/.test(run.text)) {
            return false;
          }
          return true;
        });
        artistsList = artistRuns.map((run) => ({
          name: run.text,
          id: run.navigationEndpoint?.browseEndpoint?.browseId,
        }));
        artist = artistRuns.map((run) => run.text).join(', ') || 'Unknown';
      }
      // Try shortBylineText as fallback
      else if (
        item.shortBylineText?.runs &&
        Array.isArray(item.shortBylineText.runs)
      ) {
        const runs = item.shortBylineText.runs;
        // Same filtering for metadata
        const artistRuns = runs.filter((run, index) => {
          if (index % 2 !== 0) {
            return false;
          }
          const text = run.text?.toLowerCase() || '';
          if (
            /\d+[KMB]?\s*(views?|likes?|subscribers?|plays?|listens?)/i.test(
              run.text
            )
          ) {
            return false;
          }
          if (/^\d{4}$/.test(run.text)) {
            return false;
          }
          return true;
        });
        artistsList = artistRuns.map((run) => ({
          name: run.text,
          id: run.navigationEndpoint?.browseEndpoint?.browseId,
        }));
        artist = artistRuns.map((run) => run.text).join(', ') || 'Unknown';
      }
      // Try subtitle as last resort (used in some UI)
      else if (item.subtitle?.runs && Array.isArray(item.subtitle.runs)) {
        // Usually format: "Artist • Duration" or "Artist • Album • Year"
        const firstRun = item.subtitle.runs[0];
        if (firstRun?.text) {
          artist = firstRun.text;
          artistsList = [
            {
              name: firstRun.text,
              id: firstRun.navigationEndpoint?.browseEndpoint?.browseId,
            },
          ];
        }
      }

      // Duration extraction - from fixedColumns[0] or lengthText (for playlistPanelVideoRenderer)
      let durationText =
        item.fixedColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text
          ?.runs?.[0]?.text;
      if (!durationText) {
        durationText =
          item.lengthText?.runs?.[0]?.text || item.lengthText?.simpleText;
      }
      const duration = durationText ? this.parseTime(durationText) : null;

      // Album extraction - look for runs with MUSIC_PAGE_TYPE_ALBUM navigation
      let album = null;
      // Try flexColumns (typically column 2 or 3 contains album info)
      for (let col = 1; col < (item.flexColumns?.length || 0); col++) {
        const colRuns =
          item.flexColumns[col]?.musicResponsiveListItemFlexColumnRenderer?.text
            ?.runs || [];
        for (const run of colRuns) {
          const browseEndpoint = run.navigationEndpoint?.browseEndpoint;
          const pageType =
            browseEndpoint?.browseEndpointContextSupportedConfigs
              ?.browseEndpointContextMusicConfig?.pageType;
          if (
            pageType === 'MUSIC_PAGE_TYPE_ALBUM' ||
            browseEndpoint?.browseId?.startsWith('MPRE')
          ) {
            album = {
              name: run.text,
              id: browseEndpoint?.browseId,
            };
            break;
          }
        }
        if (album) {
          break;
        }
      }
      // Fallback: Check longBylineText for album info
      if (!album && item.longBylineText?.runs) {
        for (const run of item.longBylineText.runs) {
          const browseEndpoint = run.navigationEndpoint?.browseEndpoint;
          const pageType =
            browseEndpoint?.browseEndpointContextSupportedConfigs
              ?.browseEndpointContextMusicConfig?.pageType;
          if (
            pageType === 'MUSIC_PAGE_TYPE_ALBUM' ||
            browseEndpoint?.browseId?.startsWith('MPRE')
          ) {
            album = {
              name: run.text,
              id: browseEndpoint?.browseId,
            };
            break;
          }
        }
      }

      return {
        videoId,
        browseId,
        playlistId,
        title,
        artist,
        artists: artistsList, // Array of artist objects
        album, // Album object with name and id
        duration, // Duration in seconds
        thumbnail,
        highResThumbnail, // High resolution for full-screen player
        thumbnails,
        type,
        // UI Compat
        id: videoId || browseId,
        name: title,
        subtitle:
          item.subtitle?.runs?.map((r) => r.text).join('') ||
          item.longBylineText?.runs?.map((r) => r.text).join('') ||
          item.shortBylineText?.runs?.map((r) => r.text).join('') ||
          '',
        image: videoId
          ? [
              { url: thumbnail, quality: 'default' },
              {
                url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                quality: 'hq',
              },
              {
                url: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
                quality: 'max',
              },
            ]
          : sortedThumbnails.map((t) => ({ url: t.url, quality: 'hd' })),
        artwork: highResThumbnail || thumbnail, // Use original quality for cards/lists (performance optimized)
        year: item.subtitle?.runs?.[item.subtitle.runs.length - 1]?.text || '',
      };
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  // --- InnerTube Player API (Stream URL Resolution) ---

  /**
   * Cached visitorData (required by YouTube to avoid LOGIN_REQUIRED).
   * Fetched from sw.js_data endpoint like vivi-music.
   */
  static _visitorData = null;
  static _visitorDataTimestamp = 0;
  static _VISITOR_DATA_TTL = 6 * 60 * 60 * 1000; // 6 hours

  /**
   * Fetch visitorData from YouTube's sw.js_data endpoint.
   * vivi-music pattern: parse the JSON array and find a string matching /^Cg[ts]/
   */
  static async _fetchVisitorData() {
    // Return cached if still fresh
    if (
      this._visitorData &&
      Date.now() - this._visitorDataTimestamp < this._VISITOR_DATA_TTL
    ) {
      return this._visitorData;
    }

    try {
      const resp = await fetch('https://music.youtube.com/sw.js_data', {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });
      const text = await resp.text();
      // Response starts with ")]}'" then JSON array
      const jsonStr = text.replace(/^\)\]\}'?\s*/, '');
      const parsed = JSON.parse(jsonStr);
      // Walk the nested array to find visitorData matching /^Cg[ts]/
      const findVisitorData = (arr) => {
        if (typeof arr === 'string' && /^Cg[ts]/.test(arr)) {
          return arr;
        }
        if (Array.isArray(arr)) {
          for (const item of arr) {
            const found = findVisitorData(item);
            if (found) {
              return found;
            }
          }
        }
        return null;
      };
      const vd = findVisitorData(parsed);
      if (vd) {
        this._visitorData = vd;
        this._visitorDataTimestamp = Date.now();
        return vd;
      }
    } catch (e) {
      console.warn('Failed to fetch visitorData:', e.message);
    }
    return this._visitorData; // return stale if fetch failed
  }

  /**
   * Generate SAPISIDHASH Authorization header from cookies (matches Kotlin InnerTube.kt).
   * Required by YouTube for authenticated player requests.
   * @param {string} cookies - Cookie string containing SAPISID
   * @returns {string|null} Authorization header value or null
   */
  static _generateSapisidHash(cookies) {
    if (!cookies) return null;
    try {
      // Parse SAPISID from cookie string
      const match = cookies.match(/SAPISID=([^;]+)/);
      if (!match) return null;
      const sapisid = match[1];
      const time = Math.floor(Date.now() / 1000);
      const origin = 'https://music.youtube.com';
      // SHA-1 hash of "{time} {SAPISID} {origin}"
      const input = `${time} ${sapisid} ${origin}`;
      // Simple SHA-1 implementation for React Native
      const sha1 = this._sha1(input);
      return `SAPISIDHASH ${time}_${sha1}`;
    } catch (e) {
      console.warn('Failed to generate SAPISIDHASH:', e.message);
      return null;
    }
  }

  /**
   * SHA-1 hash (pure JS, no dependencies). Matches Kotlin sha1() utility.
   */
  static _sha1(str) {
    function rotl(n, s) {
      return (n << s) | (n >>> (32 - s));
    }
    const utf8 = unescape(encodeURIComponent(str));
    const len = utf8.length;
    const words = [];
    for (let i = 0; i < len - 3; i += 4) {
      words.push(
        (utf8.charCodeAt(i) << 24) |
          (utf8.charCodeAt(i + 1) << 16) |
          (utf8.charCodeAt(i + 2) << 8) |
          utf8.charCodeAt(i + 3)
      );
    }
    const rem = len % 4;
    if (rem === 0) {
      words.push(0x80000000);
    } else if (rem === 1) {
      words.push((utf8.charCodeAt(len - 1) << 24) | 0x800000);
    } else if (rem === 2) {
      words.push(
        (utf8.charCodeAt(len - 2) << 24) |
          (utf8.charCodeAt(len - 1) << 16) |
          0x8000
      );
    } else {
      words.push(
        (utf8.charCodeAt(len - 3) << 24) |
          (utf8.charCodeAt(len - 2) << 16) |
          (utf8.charCodeAt(len - 1) << 8) |
          0x80
      );
    }
    while (words.length % 16 !== 14) words.push(0);
    words.push(0);
    words.push(len * 8);
    let h0 = 0x67452301;
    let h1 = 0xefcdab89;
    let h2 = 0x98badcfe;
    let h3 = 0x10325476;
    let h4 = 0xc3d2e1f0;
    const w = new Array(80);
    for (let j = 0; j < words.length; j += 16) {
      for (let i = 0; i < 16; i++) w[i] = words[j + i];
      for (let i = 16; i < 80; i++)
        w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
      let a = h0,
        b = h1,
        c = h2,
        d = h3,
        e = h4;
      for (let i = 0; i < 80; i++) {
        let f, k;
        if (i < 20) {
          f = (b & c) | (~b & d);
          k = 0x5a827999;
        } else if (i < 40) {
          f = b ^ c ^ d;
          k = 0x6ed9eba1;
        } else if (i < 60) {
          f = (b & c) | (b & d) | (c & d);
          k = 0x8f1bbcdc;
        } else {
          f = b ^ c ^ d;
          k = 0xca62c1d6;
        }
        const temp = (rotl(a, 5) + f + e + k + w[i]) & 0xffffffff;
        e = d;
        d = c;
        c = rotl(b, 30);
        b = a;
        a = temp;
      }
      h0 = (h0 + a) & 0xffffffff;
      h1 = (h1 + b) & 0xffffffff;
      h2 = (h2 + c) & 0xffffffff;
      h3 = (h3 + d) & 0xffffffff;
      h4 = (h4 + e) & 0xffffffff;
    }
    const hex = (n) => {
      let s = '';
      for (let i = 7; i >= 0; i--) s += ((n >>> (i * 4)) & 0xf).toString(16);
      return s;
    };
    return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
  }

  /**
   * Client definitions for player requests.
   * Updated versions matching Kotlin YouTubeClient.kt (2026).
   */
  static ANDROID_VR_CONTEXT = {
    client: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.61.48',
      androidSdkVersion: '32',
      osName: 'Android',
      osVersion: '12',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      hl: 'en',
      gl: 'US',
    },
  };

  static ANDROID_VR_USER_AGENT =
    'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12; en_US; Oculus Quest 3; Build/SQ3A.220605.009.A1; Cronet/132.0.6808.3)';

  static IOS_CONTEXT = {
    client: {
      clientName: 'IOS',
      clientVersion: '20.10.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
      hl: 'en',
      gl: 'US',
    },
  };

  static IOS_USER_AGENT =
    'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)';

  static WEB_REMIX_CONTEXT = {
    client: {
      clientName: 'WEB_REMIX',
      clientVersion: '1.20260405.01.00',
      hl: 'en',
      gl: 'US',
    },
  };

  static WEB_REMIX_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

  static ANDROID_MUSIC_CONTEXT = {
    client: {
      clientName: 'ANDROID_MUSIC',
      clientVersion: '7.27.52',
      androidSdkVersion: '30',
      osName: 'Android',
      osVersion: '11',
      hl: 'en',
      gl: 'US',
    },
  };

  static ANDROID_MUSIC_USER_AGENT =
    'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 11) gzip';

  /**
   * List of clients to try in order.
   * WEB_REMIX with SAPISIDHASH auth is tried first (requires cookies).
   * ANDROID_VR_NO_AUTH is the best anonymous fallback.
   * ANDROID_MUSIC and IOS are additional fallbacks.
   */
  /**
   * Name of the last client that successfully resolved a stream.
   * Tried first on subsequent requests so we stop burning a failed
   * round-trip (LOGIN_REQUIRED / bot-check) on every cache miss.
   */
  static _lastGoodPlayerClient = null;

  /** Throttle for visitorData invalidation on LOGIN_REQUIRED. */
  static _lastVisitorReset = 0;

  static _PLAYER_CLIENTS = [
    {
      context: 'WEB_REMIX_CONTEXT',
      userAgent: 'WEB_REMIX_USER_AGENT',
      clientId: '67',
      clientVersion: '1.20260405.01.00',
      requiresAuth: true,
    },
    {
      context: 'IOS_CONTEXT',
      userAgent: 'IOS_USER_AGENT',
      clientId: '5',
      clientVersion: '20.10.4',
      requiresAuth: false,
    },
    {
      context: 'ANDROID_VR_CONTEXT',
      userAgent: 'ANDROID_VR_USER_AGENT',
      clientId: '28',
      clientVersion: '1.61.48',
      requiresAuth: false,
    },
    {
      context: 'ANDROID_MUSIC_CONTEXT',
      userAgent: 'ANDROID_MUSIC_USER_AGENT',
      clientId: '21',
      clientVersion: '7.27.52',
      requiresAuth: false,
    },
  ];

  /**
   * Fetch player response from InnerTube player API.
   * Strategy:
   *   1. WEB_REMIX with SAPISIDHASH auth (if user is logged in with cookies)
   *   2. ANDROID_VR no-auth (best anonymous client)
   *   3. ANDROID_MUSIC (YouTube Music native client)
   *   4. IOS fallback
   *
   * @param {string} videoId - YouTube video ID
   * @param {string|null} userCookies - Stored user cookies (yt_cookies)
   * @param {boolean} preferM4A - If true, prefer M4A format for downloads (supports metadata embedding)
   * @returns {Promise<{url: string, mimeType: string, bitrate: number, duration: number, title: string, author: string, thumbnail: string}|null>}
   */
  static async getPlayerResponse(
    videoId,
    userCookies = null,
    preferM4A = false,
    signal = null
  ) {
    // Fetch visitorData (required to avoid LOGIN_REQUIRED)
    const visitorData = await this._fetchVisitorData();

    // Check stored user cookies if not explicitly provided
    let cookies = userCookies;
    if (!cookies) {
      try {
        const AsyncStorage =
          require('@react-native-async-storage/async-storage').default;
        cookies = await AsyncStorage.getItem('yt_cookies');
      } catch (e) {
        // Ignored
      }
    }

    // Generate SAPISIDHASH for authenticated requests
    const sapisidAuth = this._generateSapisidHash(cookies);

    // Try the client that worked last time first - YouTube bot-checks rotate
    // between clients, so remembering the winner avoids paying for a failed
    // LOGIN_REQUIRED round-trip on every single stream resolution.
    const clients = [...this._PLAYER_CLIENTS];
    if (this._lastGoodPlayerClient) {
      const idx = clients.findIndex(
        (c) => c.context === this._lastGoodPlayerClient
      );
      if (idx > 0) {
        const [preferred] = clients.splice(idx, 1);
        clients.unshift(preferred);
      }
    }

    for (const clientDef of clients) {
      if (signal?.aborted) {
        throw new Error('AbortError');
      }
      try {
        // Skip auth-required clients if we don't have valid cookies
        if (clientDef.requiresAuth && !sapisidAuth) {
          continue;
        }

        const clientContext = this[clientDef.context];
        const ua = this[clientDef.userAgent];

        const contextWithVisitor = {
          ...clientContext,
          client: {
            ...clientContext.client,
            ...(visitorData ? { visitorData } : {}),
          },
        };

        const body = {
          context: contextWithVisitor,
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        };

        const headers = {
          'Content-Type': 'application/json',
          'User-Agent': ua,
          'X-Goog-Api-Format-Version': '1',
          'X-YouTube-Client-Name': clientDef.clientId,
          'X-YouTube-Client-Version': clientDef.clientVersion,
          'X-Origin': 'https://music.youtube.com',
          Referer: 'https://music.youtube.com/',
          ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}),
        };

        // Add auth headers for authenticated clients
        if (clientDef.requiresAuth && cookies) {
          headers['Cookie'] = cookies;
          if (sapisidAuth) {
            headers['Authorization'] = sapisidAuth;
          }
        }

        const response = await fetch(
          `${INNERTUBE_API_URL}/player?key=${INNERTUBE_API_KEY}&prettyPrint=false`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            ...(signal ? { signal } : {}),
          }
        );

        const data = await response.json();

        const status = data?.playabilityStatus?.status;
        const reason = data?.playabilityStatus?.reason || '';

        if (status !== 'OK') {
          console.warn(
            `⚠️ InnerTube player [${clientContext.client.clientName}]: ${status} - ${reason}`
          );

          if (
            reason.includes('LOGIN_REQUIRED') ||
            status === 'LOGIN_REQUIRED'
          ) {
            // Drop this client from the fast path so we stop leading with it
            if (this._lastGoodPlayerClient === clientDef.context) {
              this._lastGoodPlayerClient = null;
            }

            // Reset visitorData cache so a fresh visitor ID is requested next
            // time - but at most once a minute. Some clients are permanently
            // bot-checked, and refetching sw.js_data per track added a whole
            // extra network round-trip to every stream resolution.
            const nowTs = Date.now();
            if (nowTs - (this._lastVisitorReset || 0) > 60000) {
              this._lastVisitorReset = nowTs;
              this._visitorData = null;
              this._visitorDataTimestamp = 0;
            }
          }

          continue; // Try next client
        }

        const result = this._extractBestAudio(data, videoId, preferM4A);
        if (result) {
          this._lastGoodPlayerClient = clientDef.context;

          // CRITICAL: googlevideo ties the stream URL to the client that
          // requested it. Playing an IOS-issued URL with an Android UA gets a
          // 403 from the CDN, which surfaces as a TrackPlayer PlaybackError.
          // Hand the caller the exact UA/client that resolved this URL.
          return {
            ...result,
            userAgent: ua,
            clientName: clientContext.client.clientName,
          };
        }
      } catch (error) {
        if (error.name === 'AbortError' || error.message === 'AbortError') {
          throw error;
        }
        console.warn(
          `InnerTube player [${clientDef.context}] failed for ${videoId}:`,
          error.message
        );
      }
    }

    return null; // All clients failed
  }

  /**
   * Extract the best audio stream URL from a player response.
   * @private
   */
  static _extractBestAudio(data, videoId, preferM4A = false) {
    const adaptiveFormats = data?.streamingData?.adaptiveFormats || [];

    const audioFormats = adaptiveFormats.filter(
      (f) => f.mimeType && f.mimeType.startsWith('audio/')
    );

    if (audioFormats.length === 0) {
      console.warn(`⚠️ No audio formats in InnerTube response for ${videoId}`);
      return null;
    }

    let bestFormat;
    if (preferM4A) {
      // DOWNLOAD MODE: Prefer M4A/MP4 for metadata embedding support
      const m4aFormats = audioFormats.filter(
        (f) => f.mimeType.includes('mp4') || f.mimeType.includes('m4a')
      );
      if (m4aFormats.length > 0) {
        bestFormat = m4aFormats.sort(
          (a, b) => (b.bitrate || 0) - (a.bitrate || 0)
        )[0];
      } else {
        // No M4A available, fall back to highest bitrate of any format
        console.warn(
          `⚠️ No M4A formats found for ${videoId}, using highest bitrate`
        );
        bestFormat = audioFormats.sort(
          (a, b) => (b.bitrate || 0) - (a.bitrate || 0)
        )[0];
      }
    } else {
      // STREAMING MODE: Prefer opus/webm, then sort by bitrate descending
      bestFormat = audioFormats.sort((a, b) => {
        const aIsOpus = a.mimeType.includes('opus') ? 1 : 0;
        const bIsOpus = b.mimeType.includes('opus') ? 1 : 0;
        if (aIsOpus !== bIsOpus) {
          return bIsOpus - aIsOpus;
        }
        return (b.bitrate || 0) - (a.bitrate || 0);
      })[0];
    }

    if (!bestFormat.url) {
      console.warn(`⚠️ Best audio format has no direct URL for ${videoId}`);
      return null;
    }

    const videoDetails = data?.videoDetails || {};
    const thumbnails = videoDetails?.thumbnail?.thumbnails || [];

    return {
      url: bestFormat.url,
      mimeType: bestFormat.mimeType,
      bitrate: bestFormat.bitrate,
      duration: parseInt(videoDetails.lengthSeconds || '0', 10),
      title: videoDetails.title,
      author: videoDetails.author || videoDetails.channelId,
      thumbnail:
        thumbnails.length > 0
          ? thumbnails[thumbnails.length - 1].url
          : null,
    };
  }
}

export default InnerTubeClient;
