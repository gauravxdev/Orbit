import { useState, useEffect, useMemo } from 'react';
import RNFS from 'react-native-fs';
import { safePath, safeExists } from '../Utils/FileUtils';

/**
 * Custom hook for managing dynamic artwork (GIF/image) for music player
 * @returns {object} - Artwork functions and state
 */
const useDynamicArtwork = () => {
  const [artworkCache, setArtworkCache] = useState({});
  const [fileCheckCache, setFileCheckCache] = useState({});

  /**
   * Check if a file exists and cache the result
   * @param {string} filePath - Path to check
   * @returns {Promise<boolean>} - Whether file exists
   */
  const checkFileExists = async (filePath) => {
    if (!filePath) return false;

    // Check cache first
    if (fileCheckCache[filePath] !== undefined) {
      return fileCheckCache[filePath];
    }

    try {
      const exists = await safeExists(filePath);
      // Cache the result
      setFileCheckCache(prev => ({ ...prev, [filePath]: exists }));
      return exists;
    } catch (error) {
      console.error('Error checking file existence:', error);
      setFileCheckCache(prev => ({ ...prev, [filePath]: false }));
      return false;
    }
  };

  /**
   * Get artwork source for a track, prioritizing local files and GIFs
   * @param {object} track - Track object
   * @returns {object} - Image source object for FastImage
   */
  const getArtworkSourceFromHook = (track) => {
    if (!track) {
      return require('../Images/Music.jpeg'); // Use Music.jpeg as default fallback
    }

    try {
      // For local music files, prioritize track's artwork property first
      const st = track?.sourceType ? String(track.sourceType).toLowerCase() : null;
      if (track.isLocal || st === 'mymusic' || st === 'download' || st === 'downloaded' || track.path) {
        // First, check if track already has artwork property (from downloaded songs)
        if (track.artwork) {
          // Handle require() result (number)
          if (typeof track.artwork === 'number') {
            return track.artwork;
          }
          // Handle object with uri property
          if (typeof track.artwork === 'object' && track.artwork.uri) {
            return track.artwork;
          }
          // Handle string URIs
          if (typeof track.artwork === 'string') {
            // For file:// paths, return directly
            if (track.artwork.startsWith('file://')) {
              return { uri: track.artwork };
            }
            // For other paths, add file:// prefix if needed
            if (track.artwork.startsWith('/')) {
              return { uri: `file://${track.artwork}` };
            }
            return { uri: track.artwork };
          }
        }

        // If no artwork property, fall back to checking local files
        const trackId = track.id || track.songId;
        if (trackId) {
          // Check cache first
          if (artworkCache[trackId]) {
            return artworkCache[trackId];
          }

          // For synchronous return, we'll use the cached file check results
          // The actual file checking will be done asynchronously
          const gifPath = safePath(`${RNFS.DocumentDirectoryPath}/orbit_music/artwork/${trackId}.gif`);
          const jpgPath = safePath(`${RNFS.DocumentDirectoryPath}/orbit_music/artwork/${trackId}.jpg`);
          const pngPath = safePath(`${RNFS.DocumentDirectoryPath}/orbit_music/artwork/${trackId}.png`);

          // Check cached results
          if (fileCheckCache[gifPath] === true) {
            const source = { uri: `file://${gifPath}` };
            setArtworkCache(prev => ({ ...prev, [trackId]: source }));
            return source;
          }
          if (fileCheckCache[jpgPath] === true) {
            const source = { uri: `file://${jpgPath}` };
            setArtworkCache(prev => ({ ...prev, [trackId]: source }));
            return source;
          }
          if (fileCheckCache[pngPath] === true) {
            const source = { uri: `file://${pngPath}` };
            setArtworkCache(prev => ({ ...prev, [trackId]: source }));
            return source;
          }

          // If no cached results, trigger async check (for next render)
          if (fileCheckCache[gifPath] === undefined) {
            checkFileExists(gifPath);
          }
          if (fileCheckCache[jpgPath] === undefined) {
            checkFileExists(jpgPath);
          }
          if (fileCheckCache[pngPath] === undefined) {
            checkFileExists(pngPath);
          }
        }

        // If no artwork found for local track, use Music.jpeg
        return require('../Images/Music.jpeg');
      }

      // For online tracks, use the provided artwork
      if (track.artwork) {
        // Enhance quality for JioSaavn CDN - upgrade to 1000x1000 for high-DPI displays
        let artworkUrl = track.artwork;
        if (artworkUrl.includes('saavncdn.com')) {
          artworkUrl = artworkUrl.replace(/50x50|150x150|500x500|1000x1000/g, '1000x1000');
        }
        return { uri: artworkUrl };
      }

      // Final fallback - use Music.jpeg for local tracks, gray background for others
      if (track.isLocal || track.sourceType === 'mymusic' || track.path) {
        return require('../Images/Music.jpeg');
      }
      return { uri: 'https://htmlcolorcodes.com/assets/images/colors/gray-color-solid-background-1920x1080.png' };
    } catch (error) {
      console.error('Error getting artwork source:', error);
      // Use Music.jpeg for error fallback when dealing with local tracks
      if (track && (track.isLocal || track.sourceType === 'mymusic' || track.path)) {
        return require('../Images/Music.jpeg');
      }
      return { uri: 'https://htmlcolorcodes.com/assets/images/colors/gray-color-solid-background-1920x1080.png' };
    }
  };

  /**
   * Preload artwork for better performance
   * @param {object} track - Track object
   */
  const preloadArtwork = async (track) => {
    if (!track) return;

    try {
      // For local tracks, preload file existence checks
      const st2 = track?.sourceType ? String(track.sourceType).toLowerCase() : null;
      if (track.isLocal || st2 === 'mymusic' || st2 === 'download' || st2 === 'downloaded' || track.path) {
        const trackId = track.id || track.songId;
        if (trackId) {
          const gifPath = safePath(`${RNFS.DocumentDirectoryPath}/orbit_music/artwork/${trackId}.gif`);
          const jpgPath = safePath(`${RNFS.DocumentDirectoryPath}/orbit_music/artwork/${trackId}.jpg`);
          const pngPath = safePath(`${RNFS.DocumentDirectoryPath}/orbit_music/artwork/${trackId}.png`);

          // Preload file existence checks
          await Promise.all([
            checkFileExists(gifPath),
            checkFileExists(jpgPath),
            checkFileExists(pngPath)
          ]);
        }
      }

      const source = getArtworkSourceFromHook(track);
      // FastImage will handle preloading automatically when source is accessed
      return source;
    } catch (error) {
      console.error('Error preloading artwork:', error);
    }
  };

  /**
   * Clear artwork cache
   */
  const clearArtworkCache = () => {
    setArtworkCache({});
    setFileCheckCache({});
  };

  /**
   * Memoized artwork source to prevent unnecessary re-renders
   */
  const getMemoizedArtworkSource = useMemo(() => {
    return (track) => {
      if (!track) return require('../Images/Music.jpeg');

      // Create a stable key for memoization
      const trackKey = `${track.id || track.songId}-${track.artwork}-${track.isLocal}-${track.sourceType}`;

      return getArtworkSourceFromHook(track);
    };
  }, [artworkCache, fileCheckCache]);

  return {
    getArtworkSourceFromHook: getMemoizedArtworkSource,
    preloadArtwork,
    clearArtworkCache,
    artworkCache,
    fileCheckCache
  };
};

export default useDynamicArtwork;
