import { useCallback, useEffect, useRef, useState } from 'react';
import { ToastAndroid } from 'react-native';
import { UnifiedDownloadService } from '../Utils/UnifiedDownloadService';
import { StorageManager } from '../Utils/StorageManager';
import { resolveSongSource } from '../Utils/PlaybackUtils';
import { requestStoragePermission } from '../Utils/PermissionManager';
import EventRegister from '../Utils/EventRegister';
import FormatArtist from '../Utils/FormatArtists';
import {
  enhanceYTMusicArtwork,
  getPrimaryArtworkUrl,
  getFallbackArtworkUrl,
} from '../Utils/ArtworkEnhancer';

/**
 * Single source of truth for downloading a song.
 *
 * Every screen used to build its own payload before calling
 * UnifiedDownloadService, and most of them defaulted to `source: 'saavn'`.
 * That silently sent YouTube Music / DAB / Spotify tracks down the Saavn
 * download path, which is why downloads worked from the full screen player
 * (the only caller that resolved the real source) and were unreliable
 * everywhere else.
 *
 * `normalizeSongForDownload` is exported separately so imperative callers -
 * batch loops, menu handlers - share the exact same normalisation as the hook.
 */

/** Album can arrive as a Saavn object; the service stringifies it blindly. */
const resolveAlbumName = (album) => {
  if (!album) {
    return undefined;
  }
  if (typeof album === 'string') {
    return album;
  }
  return album.name || album.title || undefined;
};

/**
 * Artist can be a string, an array, or Saavn's `{ primary: [...] }`.
 * FormatArtist handles the array shapes; the service handles the rest.
 */
const pickArtist = (song) => {
  if (typeof song.artist === 'string' && song.artist.length > 0) {
    return song.artist;
  }
  if (Array.isArray(song.artists)) {
    return FormatArtist(song.artists);
  }
  if (Array.isArray(song.artists?.primary)) {
    return FormatArtist(song.artists.primary);
  }
  if (Array.isArray(song.primary_artists)) {
    return FormatArtist(song.primary_artists);
  }
  return (
    song.artist ||
    song.primaryArtists ||
    song.primary_artists ||
    song.uploaderName ||
    'Unknown Artist'
  );
};

/** Pull a URL out of one entry of an image/thumbnail array. */
const urlFromImageEntry = (entry) => {
  if (typeof entry === 'string') {
    return entry;
  }
  if (entry && typeof entry === 'object') {
    return entry.url || entry.link || entry.uri || undefined;
  }
  return undefined;
};

/**
 * Upgrade an artwork URL to the largest variant the CDN offers.
 *
 * This is the whole reason downloads from the full screen player looked sharp
 * while downloads from a song menu looked terrible: the player track already
 * carries an enhanced 500x500 / maxresdefault URL (applied when playback
 * starts), whereas a list row carries the small thumbnail the API returned -
 * a Saavn 150x150 or a Google CDN =w60-h60. The download service stores
 * whatever URL it is handed, so the artwork was low-res at the source.
 *
 * Returns { url, fallback } - YouTube's maxresdefault does not exist for every
 * video, so the caller needs a second URL to try.
 */
export const upgradeArtworkUrl = (rawUrl) => {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { url: rawUrl, fallback: null };
  }

  // JioSaavn encodes the size in the path and ArtworkEnhancer leaves it alone.
  if (rawUrl.includes('saavncdn.com')) {
    return {
      url: rawUrl.replace(/\d+x\d+(?=\.[a-zA-Z]+(?:\?|$))/, '500x500'),
      fallback: rawUrl,
    };
  }

  // Google CDN and i.ytimg are handled by the shared enhancer. 'playing' is
  // its highest-quality context, which is what the full screen player uses.
  const enhanced = enhanceYTMusicArtwork(rawUrl, 'playing');
  return {
    url: getPrimaryArtworkUrl(enhanced) || rawUrl,
    fallback: getFallbackArtworkUrl(enhanced) || rawUrl,
  };
};

/**
 * Artwork arrives as a string, an object, or a quality-ordered array
 * (Saavn `image`, Spotify/YTMusic `images`) where the last entry is largest.
 */
const pickArtwork = (song) => {
  for (const candidate of [song.artwork, song.image]) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
    if (
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate)
    ) {
      // ArtworkEnhancer hands back { primary, fallback } for YouTube
      // thumbnails; plain sources use { uri } or { url }.
      const direct =
        getPrimaryArtworkUrl(candidate) || candidate.uri || candidate.url;
      if (direct) {
        return direct;
      }
    }
  }

  for (const list of [song.image, song.images, song.thumbnails]) {
    if (Array.isArray(list) && list.length > 0) {
      const best = urlFromImageEntry(list[list.length - 1]);
      if (best) {
        return best;
      }
    }
  }

  return undefined;
};

/**
 * Build the payload UnifiedDownloadService expects, with the source detected
 * from the song data rather than assumed.
 *
 * @param {object} song - Raw song object from any screen
 * @param {object} extra - Overrides merged last (e.g. `{ album }`)
 */
export const normalizeSongForDownload = (song, extra = {}) => {
  if (!song) {
    return null;
  }

  const id = song.id || song.songId || song.videoId;
  if (!id) {
    return null;
  }

  const source = resolveSongSource(song);
  const { url: artwork, fallback: artworkFallback } = upgradeArtworkUrl(
    pickArtwork(song)
  );
  const albumName = resolveAlbumName(extra.album || song.album);

  return {
    ...song,
    ...extra,
    id,
    title: song.title || song.name || song.song || 'Unknown',
    artist: pickArtist(song),
    album: albumName,
    artwork,
    image: artwork,
    // Second URL for the download service to try if the upgraded one 404s
    // (maxresdefault is not available for every video).
    artworkFallback,
    duration: song.duration || 0,
    language: song.language || '',
    artistID: song.artistID || '',
    year: song.year || song.releaseDate?.substring(0, 4) || '',
    // Saavn needs the full quality array; keep whichever key it arrived under.
    downloadUrl: song.downloadUrl || song.download_url,
    // Detected last so an `extra` override can never undo source detection.
    source,
    isDabTrack: source === 'dab',
  };
};

/**
 * Imperative download used by batch loops and one-off handlers.
 * Same normalisation, permission check and events as the hook.
 *
 * @returns {Promise<boolean>} whether the download succeeded
 */
export const downloadSongNow = async (song, onProgress = null, extra = {}) => {
  const payload = normalizeSongForDownload(song, extra);

  if (!payload) {
    ToastAndroid.show('Invalid song data', ToastAndroid.SHORT);
    return false;
  }

  const hasPermission = await requestStoragePermission();
  if (!hasPermission) {
    ToastAndroid.show(
      'Storage permission is required to download songs',
      ToastAndroid.LONG
    );
    return false;
  }

  return UnifiedDownloadService.downloadSong(payload, (progress) => {
    // Broadcast so any other view showing this song can follow along.
    EventRegister.emit('download-progress', { songId: payload.id, progress });
    if (onProgress) {
      onProgress(progress);
    }
  });
};

/**
 * Download state + actions for a single song.
 *
 * @param {object} song
 * @param {object} options
 * @param {boolean|null} options.isDownloaded - Known status, skips the lookup
 * @param {boolean} options.isOffline - Offline playback implies downloaded
 * @param {Function} options.onDelete - Custom delete handler (id, title)
 * @param {Function} options.closeMenu - Called before starting an action
 * @param {string|object} options.album - Album name to embed in metadata
 */
export const useDownloadSong = (song, options = {}) => {
  const {
    isDownloaded: propIsDownloaded = null,
    isOffline = false,
    onDelete = null,
    closeMenu = null,
    album = null,
  } = options;

  const [isDownloaded, setIsDownloaded] = useState(propIsDownloaded || false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState(null);

  const songId = song?.id || song?.songId || song?.videoId;
  // Guards a second tap while the first download is still starting up, without
  // waiting for the state update to land.
  const inFlightRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    if (!songId) {
      setIsDownloaded(false);
      return false;
    }
    try {
      const downloaded = await StorageManager.isSongDownloaded(songId);
      setIsDownloaded(downloaded);
      return downloaded;
    } catch (error) {
      console.error('Error checking download status:', error);
      return false;
    }
  }, [songId]);

  useEffect(() => {
    if (propIsDownloaded !== null && propIsDownloaded !== undefined) {
      setIsDownloaded(propIsDownloaded);
      return;
    }
    if (isOffline && (song?.isLocal || song?.isLocalMusic)) {
      setIsDownloaded(true);
      return;
    }
    if (songId) {
      refreshStatus();
    }
  }, [
    songId,
    propIsDownloaded,
    isOffline,
    song?.isLocal,
    song?.isLocalMusic,
    refreshStatus,
  ]);

  // Follow downloads started elsewhere for the same song.
  useEffect(() => {
    if (!songId) {
      return undefined;
    }

    const onComplete = (completedId) => {
      if (completedId !== songId) {
        return;
      }
      setIsDownloaded(true);
      setIsDownloading(false);
      setDownloadProgress(100);
      setDownloadError(null);
      inFlightRef.current = false;
    };

    const onRemoved = (removedId) => {
      if (removedId !== songId) {
        return;
      }
      setIsDownloaded(false);
      setIsDownloading(false);
      setDownloadProgress(0);
      inFlightRef.current = false;
    };

    const onProgressEvent = (payload) => {
      if (payload?.songId === songId) {
        setDownloadProgress(payload.progress);
      }
    };

    EventRegister.addEventListener('download-complete', onComplete);
    EventRegister.addEventListener('download-removed', onRemoved);
    EventRegister.addEventListener('download-progress', onProgressEvent);

    return () => {
      EventRegister.removeEventListener('download-complete', onComplete);
      EventRegister.removeEventListener('download-removed', onRemoved);
      EventRegister.removeEventListener('download-progress', onProgressEvent);
    };
  }, [songId]);

  const downloadSong = useCallback(async () => {
    if (closeMenu) {
      closeMenu();
    }

    if (!songId) {
      ToastAndroid.show('Invalid song data', ToastAndroid.SHORT);
      return false;
    }

    if (isDownloaded) {
      ToastAndroid.show('Song already downloaded', ToastAndroid.SHORT);
      return true;
    }

    if (inFlightRef.current || isDownloading) {
      ToastAndroid.show(
        `Download in progress: ${downloadProgress}%`,
        ToastAndroid.SHORT
      );
      return false;
    }

    inFlightRef.current = true;
    setIsDownloading(true);
    setDownloadProgress(0);
    setDownloadError(null);

    try {
      // UnifiedDownloadService already reports success/failure via toast, so
      // this path stays quiet to avoid the double toasts the old call sites had.
      const success = await downloadSongNow(
        song,
        (progress) => setDownloadProgress(progress),
        album ? { album } : {}
      );

      if (success) {
        setIsDownloaded(true);
        setDownloadProgress(100);
      }
      return success;
    } catch (error) {
      console.error('Download failed:', error);
      setDownloadError(error);
      ToastAndroid.show(`Download failed: ${error.message}`, ToastAndroid.LONG);
      return false;
    } finally {
      inFlightRef.current = false;
      setIsDownloading(false);
    }
  }, [
    song,
    songId,
    album,
    isDownloaded,
    isDownloading,
    downloadProgress,
    closeMenu,
  ]);

  const deleteSong = useCallback(async () => {
    if (closeMenu) {
      closeMenu();
    }

    if (!songId) {
      ToastAndroid.show('Invalid song data', ToastAndroid.SHORT);
      return false;
    }

    if (!isDownloaded) {
      ToastAndroid.show('Song is not downloaded', ToastAndroid.SHORT);
      return false;
    }

    try {
      if (onDelete) {
        await onDelete(songId, song?.title || song?.name);
        setIsDownloaded(false);
        return true;
      }

      const success = await UnifiedDownloadService.removeSong(songId);
      if (success) {
        setIsDownloaded(false);
        setDownloadProgress(0);
        ToastAndroid.show('Song deleted', ToastAndroid.SHORT);
      }
      return success;
    } catch (error) {
      console.error('Delete failed:', error);
      setDownloadError(error);
      ToastAndroid.show(`Delete failed: ${error.message}`, ToastAndroid.LONG);
      return false;
    }
  }, [songId, song, isDownloaded, onDelete, closeMenu]);

  return {
    isDownloaded,
    isDownloading,
    downloadProgress,
    downloadError,
    downloadSong,
    deleteSong,
    refreshStatus,
    // Aliases so existing call sites keep reading naturally.
    startDownload: downloadSong,
    removeDownload: deleteSong,
    canDownload: !isOffline && !isDownloading && !isDownloaded && !!songId,
    showProgress: isDownloading && downloadProgress > 0,
  };
};

export default useDownloadSong;
