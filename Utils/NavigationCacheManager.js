/**
 * Navigation Cache Manager
 *
 * Centralized caching system for screen data, stream URLs, and UI state.
 * Eliminates unnecessary API calls on back navigation by providing
 * instant cached data when available.
 *
 * Features:
 * - In-memory cache with TTL per entry
 * - LRU cache eviction to prevent memory bloat
 * - Stream URL caching (3 hours for YTMusic/DAB)
 * - Scroll position preservation
 * - Search state persistence
 * - Hybrid Caching (RAM + Disk) for restart persistence
 */

import { CACHE_TTL, CACHE_LIMITS, isCacheStale } from './CacheConfig';
import AsyncStorage from '@react-native-async-storage/async-storage';

class NavigationCacheManager {
  constructor() {
    // Main data cache: { key: { data, timestamp, ttl } }
    this.cache = new Map();

    // Stream URL cache: { videoId: { url, timestamp, ttl, source } }
    this.streamCache = new Map();

    // Scroll position cache: { screenKey: position }
    this.scrollCache = new Map();

    // Search state cache: { query, results, filters, timestamp }
    this.searchState = null;

    // Access order for LRU eviction
    this.accessOrder = [];

    // Initialize disk cache lazy loading
    this._initializeDiskCache();
  }

  /**
   * Load critical persistent data into RAM on startup
   * @private
   */
  async _initializeDiskCache() {
    try {
      // Pre-load Home Feed if available (fast startup)
      // We can implement strict preload here if needed, but getAsync handles it lazily
    } catch (e) {
      console.warn('[CacheManager] Failed to initialize disk cache:', e);
    }
  }

  // ============================================
  // MAIN DATA CACHE METHODS
  // ============================================

  /**
   * Get cached data
   * @param {string} key - Cache key
   * @returns {any|null} - Cached data or null if not found/stale
   */
  get(key) {
    // Fast path: RAM only
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    if (isCacheStale(entry.timestamp, entry.ttl)) {
      this.cache.delete(key);
      this._removeFromAccessOrder(key);
      // Fire-and-forget: clear disk cache too
      AsyncStorage.removeItem(`cache_${key}`).catch((e) =>
        console.warn('Failed to clear disk cache', e)
      );
      return null;
    }

    this._updateAccessOrder(key);
    return entry.data;
  }

  /**
   * Get cached data (Hybrid: RAM -> Disk)
   * @param {string} key - Cache key
   * @returns {Promise<any|null>}
   */
  async getAsync(key) {
    // 1. Try RAM first (Instant)
    const ramData = this.get(key);
    if (ramData) {
      return ramData;
    }

    // 2. Try Disk (Persistence)
    try {
      const diskData = await AsyncStorage.getItem(`cache_${key}`);
      if (diskData) {
        const entry = JSON.parse(diskData);

        // Check expiry
        if (isCacheStale(entry.timestamp, entry.ttl)) {
          // Stale - cleanup
          await AsyncStorage.removeItem(`cache_${key}`);
          return null;
        }

        // Restore to RAM for next time
        this.cache.set(key, entry);
        this._updateAccessOrder(key);
        return entry.data;
      }
    } catch (e) {
      console.warn(`[CacheManager] Disk read failed for ${key}`, e);
    }

    return null;
  }

  /**
   * Set cache data (Hybrid: RAM + Disk)
   * @param {string} key - Cache key
   * @param {any} data - Data to cache
   * @param {number} ttl - Time-to-live in milliseconds
   */
  set(key, data, ttl = CACHE_TTL.DEFAULT) {
    // Enforce cache size limit
    this._enforceLimit();

    const entry = {
      data,
      timestamp: Date.now(),
      ttl,
    };

    // 1. Write to RAM (Sync/Instant)
    this.cache.set(key, entry);
    this._updateAccessOrder(key);

    // 2. Write to Disk (Async/Background) - fire and forget with error handling
    (async () => {
      try {
        const dataString = JSON.stringify(entry);
        // Skip very large items (>500KB) to prevent SQLite issues
        if (dataString.length < 500000) {
          await AsyncStorage.setItem(`cache_${key}`, dataString);
        } else {
        }
      } catch (e) {
        // Handle disk full gracefully - don't log error, data is still in RAM
        if (
          e.message &&
          (e.message.includes('code 13') ||
            e.message.toLowerCase().includes('full'))
        ) {
        }
      }
    })();
  }

  /**
   * Check if cache has valid (non-stale) data
   * @param {string} key - Cache key
   * @returns {boolean}
   */
  has(key) {
    return this.get(key) !== null;
  }

  /**
   * Invalidate specific cache entry
   * @param {string} key - Cache key to invalidate
   */
  invalidate(key) {
    this.cache.delete(key);
    this._removeFromAccessOrder(key);
    // Clear disk cache as well
    AsyncStorage.removeItem(`cache_${key}`).catch(() => {});
  }

  /**
   * Invalidate all entries matching a prefix
   * @param {string} prefix - Key prefix to match
   */
  invalidateByPrefix(prefix) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        this._removeFromAccessOrder(key);
        // We should also clear from disk, but mapping prefixes to disk keys is harder without storing a list of keys.
        // For now, we rely on TTL expiry or manual precise invalidation for disk.
        // Or we could scan all AsyncStorage keys, but that is expensive.
        // Given the requirement, meaningful invalidation usually targets specific keys (like 'home_data').
        AsyncStorage.removeItem(`cache_${key}`).catch(() => {});
      }
    }
  }

  /**
   * Clear all cache data
   */
  invalidateAll() {
    this.cache.clear();
    this.accessOrder = [];
    // Note: This doesn't clear AsyncStorage to avoid wiping non-cache data.
    // Ideally we prefixes all cache keys with a specific namespace to allow bulk clear.
    // Current keys start with 'cache_' or 'stream_'.
    // For strict "clear all", we would need to scan keys.
  }

  // ============================================
  // STREAM URL CACHE METHODS (3-hour TTL)
  // ============================================

  /**
   * Get cached stream URL with metadata
   * @param {string} videoId - Video/track ID
   * @param {string} source - 'ytmusic' or 'dab'
   * @returns {{url: string, format: string|null, mimeType: string|null}|null} - Cached stream data or null
   */
  getStreamUrl(videoId, source = 'ytmusic') {
    // RAM only (Legacy/Fast)
    const key = `${source}_${videoId}`;
    const entry = this.streamCache.get(key);
    if (!entry) {
      return null;
    }

    if (isCacheStale(entry.timestamp, entry.ttl)) {
      this.streamCache.delete(key);
      // Fire-and-forget: clear disk cache
      AsyncStorage.removeItem(`stream_${key}`).catch(() => {});
      return null;
    }
    return {
      url: entry.url,
      format: entry.format || null,
      mimeType: entry.mimeType || null,
      userAgent: entry.userAgent || null,
      bitrate: entry.bitrate || null,
      resolvedBy: entry.resolvedBy || null,
    };
  }

  /**
   * Get stream URL with metadata (Hybrid: RAM -> Disk)
   * @param {string} videoId
   * @param {string} source
   * @returns {Promise<{url: string, format: string|null, mimeType: string|null}|null>}
   */
  async getStreamUrlAsync(videoId, source = 'ytmusic') {
    const key = `${source}_${videoId}`;

    // 1. RAM Check
    const ramData = this.getStreamUrl(videoId, source);
    if (ramData) {
      return ramData;
    }

    // 2. Disk Check
    try {
      const diskData = await AsyncStorage.getItem(`stream_${key}`);
      if (diskData) {
        const entry = JSON.parse(diskData);
        if (isCacheStale(entry.timestamp, entry.ttl)) {
          await AsyncStorage.removeItem(`stream_${key}`);
          return null;
        }

        // Restore to RAM
        this.streamCache.set(key, entry);
        return {
          url: entry.url,
          format: entry.format || null,
          mimeType: entry.mimeType || null,
          userAgent: entry.userAgent || null,
          bitrate: entry.bitrate || null,
          resolvedBy: entry.resolvedBy || null,
        };
      }
    } catch (e) {
      console.warn('[CacheManager] Stream disk read error:', e);
    }
    return null;
  }

  /**
   * Cache stream URL with specific TTL
   * @param {string} videoId - Video/track ID
   * @param {string} url - Stream URL
   * @param {string} source - 'ytmusic' or 'dab'
   * @param {object} metadata - Optional metadata like format, mimeType
   */
  setStreamUrl(videoId, url, source = 'ytmusic', metadata = {}) {
    if (!videoId || !url) {
      console.warn(
        '[CacheManager] Cannot cache stream URL: missing videoId or url'
      );
      return;
    }
    this._enforceStreamLimit();

    const ttl =
      source === 'ytmusic' ? CACHE_TTL.YTMUSIC_STREAM : CACHE_TTL.DAB_STREAM;
    const key = `${source}_${videoId}`;

    const entry = {
      url,
      timestamp: Date.now(),
      ttl,
      source,
      // Store format metadata for correct file extension on download
      format: metadata.format || null,
      mimeType: metadata.mimeType || null,
      // CRITICAL: the UA the URL was issued to. Replaying a cached URL with a
      // different UA gets a 403 from googlevideo.
      userAgent: metadata.userAgent || null,
      bitrate: metadata.bitrate || null,
      // Which resolver produced this URL ('native' | 'innertube'), so a
      // playback failure can retry with the other one.
      resolvedBy: metadata.resolvedBy || null,
    };

    // 1. RAM
    this.streamCache.set(key, entry);

    // 2. Disk - fire and forget with error handling
    (async () => {
      try {
        const dataString = JSON.stringify(entry);
        if (dataString.length < 500000) {
          await AsyncStorage.setItem(`stream_${key}`, dataString);
        }
      } catch (e) {
        if (
          e.message &&
          (e.message.includes('code 13') ||
            e.message.toLowerCase().includes('full'))
        ) {
        }
      }
    })();

    // Verbose logging removed for cleaner console
  }

  /**
   * Check if stream URL is cached and valid
   * @param {string} videoId - Video/track ID
   * @param {string} source - 'ytmusic' or 'dab'
   * @returns {boolean}
   */
  hasStreamUrl(videoId, source = 'ytmusic') {
    return this.getStreamUrl(videoId, source) !== null;
  }

  /**
   * Drop one cached stream URL (RAM + disk).
   * Used when playback fails on a URL that looked valid - googlevideo URLs can
   * expire or be rejected before our TTL runs out, and re-resolving is
   * pointless if the stale URL is just served straight back from cache.
   * @param {string} videoId
   * @param {string} source
   */
  invalidateStreamUrl(videoId, source = 'ytmusic') {
    if (!videoId) {
      return;
    }
    const key = `${source}_${videoId}`;
    this.streamCache.delete(key);
    AsyncStorage.removeItem(`stream_${key}`).catch(() => {});
  }

  /**
   * Clear all stream URL cache
   */
  clearStreamCache() {
    this.streamCache.clear();
  }

  // ============================================
  // SCROLL POSITION METHODS
  // ============================================

  /**
   * Get saved scroll position
   * @param {string} screenKey - Screen identifier
   * @returns {number} - Scroll position (0 if not found)
   */
  getScrollPosition(screenKey) {
    const entry = this.scrollCache.get(screenKey);

    if (!entry) {
      return 0;
    }

    // Check if scroll position is stale
    if (isCacheStale(entry.timestamp, CACHE_TTL.SCROLL_POSITION)) {
      this.scrollCache.delete(screenKey);
      return 0;
    }

    return entry.position;
  }

  /**
   * Save scroll position
   * @param {string} screenKey - Screen identifier
   * @param {number} position - Scroll position
   */
  setScrollPosition(screenKey, position) {
    // Limit scroll cache size
    if (this.scrollCache.size >= CACHE_LIMITS.MAX_SCROLL_ENTRIES) {
      const firstKey = this.scrollCache.keys().next().value;
      this.scrollCache.delete(firstKey);
    }

    this.scrollCache.set(screenKey, {
      position,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear all scroll positions
   */
  clearScrollPositions() {
    this.scrollCache.clear();
  }

  // ============================================
  // SEARCH STATE METHODS
  // ============================================

  /**
   * Get saved search state (Hybrid)
   * @returns {Promise<object|null>}
   */
  async getSearchStateAsync() {
    // 1. Memory check
    if (this.searchState) {
      if (!isCacheStale(this.searchState.timestamp, CACHE_TTL.SEARCH_QUERY)) {
        return this.searchState;
      }
      this.searchState = null;
    }

    // 2. Disk check
    try {
      const diskState = await AsyncStorage.getItem('cache_search_state');
      if (diskState) {
        const state = JSON.parse(diskState);
        if (!isCacheStale(state.timestamp, CACHE_TTL.SEARCH_QUERY)) {
          this.searchState = state; // Restore RAM
          return state;
        }
        // Stale
        await AsyncStorage.removeItem('cache_search_state');
      }
    } catch (e) {
      console.warn('[CacheManager] Search state read failed', e);
    }
    return null;
  }

  /**
   * Get saved search state (Sync RAM check for legacy)
   * @returns {object|null}
   */
  getSearchState() {
    if (!this.searchState) {
      return null;
    }
    return this.searchState;
  }

  /**
   * Save search state (Hybrid)
   * @param {object} state
   */
  setSearchState(state) {
    const entry = {
      ...state,
      timestamp: Date.now(),
    };
    this.searchState = entry;
    AsyncStorage.setItem('cache_search_state', JSON.stringify(entry)).catch(
      () => {}
    );
  }

  /**
   * Clear search state
   */
  clearSearchState() {
    this.searchState = null;
    AsyncStorage.removeItem('cache_search_state').catch(() => {});
  }

  // ============================================
  // PLAYER STATE METHODS
  // ============================================

  /**
   * Get saved player state (Queue + Active Track)
   * @returns {Promise<{queue: Array, activeTrack: Object, activeIndex: number}|null>}
   */
  async getPlayerStateAsync() {
    return null;
  }

  /**
   * Save player state
   * @param {Array} queue
   * @param {Object} activeTrack
   * @param {number} activeIndex
   */
  setPlayerState(_queue, _activeTrack, _activeIndex) {
    // No-op: Disable player state persistence as requested by user
    return;
  }

  /**
   * Clear player state (remove current playing song from cache)
   * @returns {Promise<void>}
   */
  async clearPlayerState() {
    try {
      await AsyncStorage.removeItem('cache_player_state');
    } catch (e) {
      console.warn('[CacheManager] Failed to clear player state', e);
    }
  }

  /**
   * Emergency cleanup when disk is full
   * @private
   */
  async _emergencyCleanup() {
    try {
      const keys = await AsyncStorage.getAllKeys();
      // Remove all cache_ and stream_ prefixed items (except player state)
      const cacheKeys = keys.filter(
        (k) =>
          (k.startsWith('cache_') || k.startsWith('stream_')) &&
          k !== 'cache_player_state'
      );
      if (cacheKeys.length > 0) {
        await AsyncStorage.multiRemove(cacheKeys);
      }
      // Also clear RAM caches
      this.cache.clear();
      this.streamCache.clear();
      this.accessOrder = [];
    } catch (e) {
      console.error('[CacheManager] Emergency cleanup failed:', e);
    }
  }

  // ============================================
  // INTERNAL HELPER METHODS
  // ============================================

  /**
   * Update LRU access order
   * @private
   */
  _updateAccessOrder(key) {
    this._removeFromAccessOrder(key);
    this.accessOrder.push(key);
  }

  /**
   * Remove key from access order
   * @private
   */
  _removeFromAccessOrder(key) {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  /**
   * Enforce main cache size limit using LRU eviction
   * @private
   */
  _enforceLimit() {
    while (
      this.cache.size >= CACHE_LIMITS.MAX_ENTRIES &&
      this.accessOrder.length > 0
    ) {
      const oldestKey = this.accessOrder.shift();
      this.cache.delete(oldestKey);
      // Note: We don't strictly enforce clearing disk cache on LRU to keep more history on disk than RAM
      // But if we wanted to sync them 1:1, we would remove from AsyncStorage here too.
      // For now, let's keep disk cache slightly larger than RAM is fine, or rely on expiry.
    }
  }

  /**
   * Enforce stream cache size limit
   * @private
   */
  _enforceStreamLimit() {
    if (this.streamCache.size >= CACHE_LIMITS.MAX_STREAM_ENTRIES) {
      // Remove oldest entries (first inserted)
      const keysToRemove = Array.from(this.streamCache.keys()).slice(0, 10);
      keysToRemove.forEach((key) => {
        this.streamCache.delete(key);
        // Also clear from disk if enforcing strict limit
        AsyncStorage.removeItem(`stream_${key}`).catch(() => {});
      });
    }
  }

  // ============================================
  // DEBUG / MONITORING METHODS
  // ============================================

  /**
   * Get cache statistics
   * @returns {object} - Cache stats
   */
  getStats() {
    return {
      mainCacheSize: this.cache.size,
      streamCacheSize: this.streamCache.size,
      scrollCacheSize: this.scrollCache.size,
      hasSearchState: this.searchState !== null,
      accessOrderLength: this.accessOrder.length,
    };
  }

  /**
   * Log cache status for debugging
   */
  logStatus() {
    // const stats = this.getStats();
  }
}

// Export singleton instance
export const CacheManager = new NavigationCacheManager();

// Also export class for testing purposes
export default NavigationCacheManager;
