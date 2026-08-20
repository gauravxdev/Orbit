import TrackPlayer from 'react-native-track-player';

import { GetPlaybackQuality } from './LocalStorage/AppSettings';
import NetInfo from '@react-native-community/netinfo';
import {
  ToastAndroid,
  DeviceEventEmitter,
  InteractionManager,
} from 'react-native';
import historyManager from './Utils/HistoryManager';

import dabMusicService from './Utils/DabMusicService';
import youtubeStreamingService from './Utils/YouTubeStreamingService';
import queueManager from './Utils/QueueManager';
import {
  enhanceYTMusicArtwork,
  getPrimaryArtworkUrl,
} from './Utils/ArtworkEnhancer';
import autoRecommendations from './Utils/AutoRecommendations';
import skipOperationManager from './Utils/SkipOperationManager';
import streamFetchManager from './Utils/StreamFetchManager';
import smartPrefetchManager from './Utils/SmartPrefetchManager';
import FormatArtist from './Utils/FormatArtists';
import dabRecommendationService from './Utils/DABRecommendationService';
import lastFMService from './Utils/LastFMService';
import progressiveQueueLoader from './Utils/ProgressiveQueueLoader';
import {
  getQueueLength,
  invalidateQueueSnapshot,
} from './Utils/QueueSnapshot';

let isPlayerInitialized = false;

// PERFORMANCE: Cache quality index to avoid repeated AsyncStorage calls
let cachedQualityIndex = null;
let qualityCacheTimestamp = 0;
const QUALITY_CACHE_TTL = 60000; // 1 minute cache TTL

// Helper to extract artwork URL from various formats
const extractArtwork = (song) => {
  let artworkUrl = '';

  // Direct artwork/image string
  if (
    song.artwork &&
    typeof song.artwork === 'string' &&
    song.artwork.length > 0
  ) {
    artworkUrl = song.artwork;
  } else if (
    song.image &&
    typeof song.image === 'string' &&
    song.image.length > 0
  ) {
    artworkUrl = song.image;
  }
  // Object format with url/uri
  else if (song.artwork && typeof song.artwork === 'object') {
    artworkUrl = song.artwork.url || song.artwork.uri || '';
  }
  // Array format (Saavn/OuterTune)
  else if (song.image && Array.isArray(song.image)) {
    const bestImage =
      song.image[2] ||
      song.image[song.image.length - 1] ||
      song.image[0];
    artworkUrl =
      bestImage?.url ||
      bestImage?.link ||
      bestImage?.uri ||
      (typeof bestImage === 'string' ? bestImage : '');
  }
  // Single Image Object format
  else if (song.image && typeof song.image === 'object') {
    artworkUrl = song.image.url || song.image.link || song.image.uri || '';
  }
  // Thumbnail format (YTMusic)
  else if (song.thumbnail) {
    artworkUrl =
      typeof song.thumbnail === 'string'
        ? song.thumbnail
        : song.thumbnail.url || '';
  } else if (song.thumbnails && Array.isArray(song.thumbnails)) {
    const bestThumb =
      song.thumbnails[song.thumbnails.length - 1] || song.thumbnails[0];
    artworkUrl = bestThumb?.url || '';
  }

  // Final enhancement pass
  if (artworkUrl && typeof artworkUrl === 'string') {
    const enhanced = enhanceYTMusicArtwork(artworkUrl, 'card');
    return getPrimaryArtworkUrl(enhanced) || artworkUrl;
  }

  return artworkUrl || song.artwork?.uri || song.image?.uri || '';
};

export const setupPlayer = async () => {
  try {
    if (!isPlayerInitialized) {
      try {
await TrackPlayer.setupPlayer({
            android: {
                appKilledPlaybackBehavior: 'ContinuePlayback',
                alwaysPauseOnInterruption: false,
            },
            autoUpdateMetadata: true,
        });
        // NOTE: Remote control listeners (play, pause, next, previous) are registered in service.js
        // to avoid duplicate event listeners. DO NOT add them here.

        await TrackPlayer.updateOptions({
          android: {
            appKilledPlaybackBehavior: 'ContinuePlayback',
            alwaysPauseOnInterruption: false,
          },
          capabilities: [
            'play',
            'pause',
            'stop',
            'seekTo',
            'skip',
            'skipToNext',
            'skipToPrevious',
          ],
          compactCapabilities: [
            'play',
            'pause',
            'stop',
            'seekTo',
            'skip',
            'skipToNext',
            'skipToPrevious',
          ],
          notificationCapabilities: [
            'play',
            'pause',
            'stop',
            'seekTo',
            'skip',
            'skipToNext',
            'skipToPrevious',
          ],
        });

        isPlayerInitialized = true;

        // Initialize SmartPrefetchManager for background prefetching
        smartPrefetchManager.initialize();
      } catch (setupError) {
        // Check if the error is about player already being initialized
        if (
          setupError.message &&
          setupError.message.includes('player has already been initialized')
        ) {
          isPlayerInitialized = true;
          smartPrefetchManager.initialize();
        } else {
          console.error(
            'Error setting up player in MusicPlayerFunctions:',
            setupError
          );
          throw setupError;
        }
      }
    } else {
    }
  } catch (error) {
    console.error('Error in setupPlayer function:', error);
  }
};

async function PlayOneSong(song) {
  try {
    // Validate song object
    if (!song) {
      console.error('PlayOneSong: No song provided');
      return;
    }

    // Ensure player is initialized
    if (!isPlayerInitialized) {
      await setupPlayer();
    }

    // Get the appropriate URL based on playback quality setting
    let playbackUrl = song.url;
    let updatedSong = { ...song };

    // Check if this is a podcast episode - skip all stream processing
    const isPodcast = song.isPodcast || song.type === 'podcast';

    // Check if this is a YouTube song (has videoId/id that looks like YouTube video ID)
    // Podcasts should NOT be treated as YouTube songs even if ID length matches
    const isYouTubeSong =
      !isPodcast &&
      song.id &&
      typeof song.id === 'string' &&
      song.id.length === 11 &&
      !song.isLocalMusic;

    if (isYouTubeSong) {
      try {
        // OPTIMISTIC UI: Emit early metadata event so mini player shows immediately
        // This provides instant feedback while the 2-3 second stream fetch happens
        const earlyArtwork =
          extractArtwork(song) || song.artwork || song.image || '';
        DeviceEventEmitter.emit('song-loading-started', {
          id: song.id,
          title: song.title || song.name || 'Loading...',
          artist: song.artist || 'Loading...',
          artwork: earlyArtwork,
          image: earlyArtwork,
          duration: song.duration,
          isLoading: true,
        });
        // Use StreamFetchManager for deduplication and abort support
        const streamData = await streamFetchManager.fetchStream(
          song.id,
          async (videoId, signal) =>
            youtubeStreamingService.getStreamUrl(videoId, false, signal)
        );

        if (streamData && streamData.url) {
          // Verbose logging removed for cleaner console
          playbackUrl = streamData.url;
          // Update song with stream data and headers
          // IMPORTANT: Preserve artist from original song data
          // Determine quality label from actual bitrate and mimeType
          // Estimate bitrate based on codec if not available
          const isOpus = streamData.mimeType?.includes('webm');
          const estimatedBitrate =
            streamData.bitrate || (isOpus ? 148000 : 256000);
          const bitrateKbps = Math.round(estimatedBitrate / 1000);
          const codec = isOpus ? 'Opus' : 'AAC';
          const ytQuality = `${codec} ${bitrateKbps}kbps`;

          updatedSong = {
            ...updatedSong,
            url: streamData.url,
            headers: streamData.headers,
            userAgent: streamData.headers?.['User-Agent'],
            artwork: streamData.thumbnail || updatedSong.artwork,
            duration: streamData.duration || updatedSong.duration,
            currentPlayingQuality: ytQuality, // Store actual stream quality
            title: updatedSong.title || streamData.title,
            artist: updatedSong.artist || 'Unknown Artist',
          };
          // Reset error counter on successful fetch
          skipOperationManager.resetErrorCounter();
        } else {
          console.error('Failed to get YouTube stream URL');
          ToastAndroid.show(
            'Failed to load YouTube stream',
            ToastAndroid.SHORT
          );
          return;
        }
      } catch (error) {
        console.error('Error fetching YouTube stream:', error);

        // Don't show toast if operation was cancelled
        if (error.name !== 'AbortError') {
          ToastAndroid.show('Error loading YouTube stream', ToastAndroid.SHORT);
        }
        return;
      }
    }
    // Check if this is a SPOTIFY track - needs to be mapped to YTMusic
    else if (song.source === 'spotify' || song.spotifyId) {
      try {
        // OPTIMISTIC UI: Emit early metadata so mini player shows immediately
        // Uses Spotify artwork while we search for YTMusic match
        const earlyArtwork =
          extractArtwork(song) || song.artwork || song.image || '';
        DeviceEventEmitter.emit('song-loading-started', {
          id: song.id,
          title: song.title || song.name || 'Loading...',
          artist: song.artist || 'Finding on YTMusic...',
          artwork: earlyArtwork,
          image: earlyArtwork,
          duration: song.duration,
          isLoading: true,
          isSpotifyMapping: true, // Flag for UI to show mapping indicator
        });
        // Use YouTubeMusicService.searchAndStream to find and get stream URL
        const YouTubeMusicService =
          require('./Utils/YouTubeMusicService').default;
        const searchQuery = `${song.title || song.name} ${
          song.artist || ''
        }`.trim();

        const ytMusicResult = await YouTubeMusicService.searchAndStream(
          song.title || song.name,
          song.artist || ''
        );

        if (ytMusicResult && ytMusicResult.url && !ytMusicResult.error) {
          playbackUrl = ytMusicResult.url;

          // Update song with YTMusic stream data while strictly PRESERVING Spotify metadata
          // Determine quality label from actual bitrate and mimeType
          // Estimate bitrate based on codec if not available
          const isOpus = ytMusicResult.mimeType?.includes('webm');
          const estimatedBitrate =
            ytMusicResult.bitrate || (isOpus ? 148000 : 256000);
          const bitrateKbps = Math.round(estimatedBitrate / 1000);
          const codec = isOpus ? 'Opus' : 'AAC';
          const ytQuality = `${codec} ${bitrateKbps}kbps`;

          updatedSong = {
            ...updatedSong,
            url: ytMusicResult.url,
            headers: ytMusicResult.headers,
            userAgent: ytMusicResult.headers?.['User-Agent'],
            // Add technical YTMusic data but keep Spotify metadata for UI
            ytMusicVideoId: ytMusicResult.videoId,
            mappedFromSpotify: true,
            currentPlayingQuality: ytQuality,
          };

          skipOperationManager.resetErrorCounter();
        } else {
          console.error('❌ Failed to find YTMusic match for Spotify track');
          ToastAndroid.show(
            'Could not find song on YTMusic',
            ToastAndroid.SHORT
          );
          return;
        }
      } catch (error) {
        console.error('❌ Error mapping Spotify to YTMusic:', error);
        ToastAndroid.show('Error finding song on YTMusic', ToastAndroid.SHORT);
        return;
      }
    }
    // Check if this is a DAB Music track
    else if (
      song.isDabTrack ||
      song.source === 'dab' ||
      (!isNaN(song.url) && String(song.url).length > 5)
    ) {
      try {
        // OPTIMISTIC UI: Emit early metadata so mini player shows immediately
        const earlyArtwork =
          extractArtwork(song) || song.artwork || song.image || '';
        DeviceEventEmitter.emit('song-loading-started', {
          id: song.id,
          title: song.title || song.name || 'Loading...',
          artist: song.artist || 'Loading...',
          artwork: earlyArtwork,
          image: earlyArtwork,
          duration: song.duration,
          isLoading: true,
          isDabTrack: true, // Flag for UI to show DAB indicator
        });
        await dabMusicService.initialize();
        const streamUrl = await dabMusicService.getStreamUrl(song.id);

        if (streamUrl) {
          playbackUrl = streamUrl;

          // Parse format from URL to determine quality
          const fmtMatch = streamUrl.match(/[?&]fmt=(\d+)/);
          const fmt = fmtMatch ? fmtMatch[1] : null;
          const formatMap = {
            5: 'MP3 320kbps',
            6: 'FLAC 16-bit/44.1kHz',
            7: 'FLAC 24-bit/96kHz',
            27: 'FLAC 24-bit/192kHz',
          };
          const dabQuality = formatMap[fmt] || 'FLAC';

          updatedSong = {
            ...updatedSong,
            url: streamUrl,
            source: 'dab',
            isDabTrack: true,
            currentPlayingQuality: dabQuality, // Set actual FLAC quality
          };
        } else {
          console.error('Failed to get DAB stream URL');
          ToastAndroid.show('Failed to load DAB stream', ToastAndroid.SHORT);
          return;
        }
      } catch (error) {
        console.error('❌ Error fetching DAB stream:', error);
        ToastAndroid.show('Error loading DAB stream', ToastAndroid.SHORT);
        return;
      }
    } else {
      // If song has multiple quality URLs, select based on setting
      const resolveTrackUrl = (entries) => {
        if (!Array.isArray(entries)) {
          return '';
        }
        const preferred =
          entries[qualityIndex] || entries[entries.length - 1] || entries[0];
        if (!preferred || typeof preferred !== 'object') {
          return '';
        }
        return preferred.url || preferred.link || preferred.uri || '';
      };

      if (song.downloadUrl && Array.isArray(song.downloadUrl)) {
        const qualityIndex = await getIndexQuality();
        playbackUrl = resolveTrackUrl(song.downloadUrl);
      } else if (song.download_url && Array.isArray(song.download_url)) {
        // Alternative format
        const qualityIndex = await getIndexQuality();
        playbackUrl = resolveTrackUrl(song.download_url);
      }
    }

    // Validate song URL
    if (!playbackUrl || typeof playbackUrl !== 'string') {
      console.error('PlayOneSong: Invalid or missing song URL', song);
      ToastAndroid.show('Cannot play song - invalid URL', ToastAndroid.SHORT);
      return;
    }

    // Check if the song is a local file (has a path or isLocalMusic property)
    const isLocalFile =
      song.isLocalMusic || song.path || playbackUrl.startsWith('file://');

    // If it's a local file, make sure the URL starts with file://
    if (isLocalFile && !playbackUrl.startsWith('file://') && song.path) {
      playbackUrl = `file://${song.path}`;
    }

    // Check network availability for non-local files - NON-BLOCKING
    // Instead of blocking here, we let playback fail gracefully if offline
    if (!isLocalFile) {
      NetInfo.fetch()
        .then((netInfo) => {
          if (!netInfo.isConnected) {
          }
        })
        .catch(() => {
          /* ignore */
        });
    }

    // NOTE: History tracking moved to AFTER TrackPlayer.play() to avoid blocking playback
    // See below after TrackPlayer.play() call

    // Create a copy of the song with the selected playback URL and quality info
    // PERFORMANCE: Use cached quality index if available
    let qualityIndex = cachedQualityIndex;
    if (
      qualityIndex === null ||
      Date.now() - qualityCacheTimestamp > QUALITY_CACHE_TTL
    ) {
      qualityIndex = await getIndexQuality();
      cachedQualityIndex = qualityIndex;
      qualityCacheTimestamp = Date.now();
    }
    const qualityNames = ['12kbps', '48kbps', '96kbps', '160kbps', '320kbps'];
    const currentQuality = qualityNames[qualityIndex] || 'Unknown';

    // Enhance artwork to highest quality for playing song (w500)
    const enhancedArtwork = enhanceYTMusicArtwork(
      updatedSong.artwork || updatedSong.image,
      'playing'
    );
    const playingArtwork =
      getPrimaryArtworkUrl(enhancedArtwork) ||
      updatedSong.artwork ||
      updatedSong.image;

    // NORMALIZE METADATA (Critical for Saavn/Standard tracks)
    // 1. Ensure Title
    if (!updatedSong.title && updatedSong.name) {
      updatedSong.title = String(updatedSong.name)
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#039;/g, "'");
    }
    if (!updatedSong.title) {
      updatedSong.title = 'Unknown Title';
    }

    // 2. Ensure Artist
    if (!updatedSong.artist) {
      if (updatedSong.artists && updatedSong.artists.primary) {
        updatedSong.artist = FormatArtist(updatedSong.artists.primary);
      } else if (song.artists && song.artists.primary) {
        updatedSong.artist = FormatArtist(song.artists.primary);
      } else {
        updatedSong.artist = 'Unknown Artist';
      }
    }

    const songForPlayback = {
      ...updatedSong,
      url: playbackUrl,
      // CRITICAL: Preserve existing quality for YTMusic/Spotify/DAB tracks
      // Only use Saavn quality setting if no quality was already set by stream handler
      currentPlayingQuality:
        updatedSong.currentPlayingQuality || currentQuality,
      artwork: playingArtwork, // Use enhanced w500 quality
      // Store original full name for lyrics search (not truncated for display)
      originalTitle:
        song.name || song.title || updatedSong.name || updatedSong.title,
    };

    await TrackPlayer.reset();
    await TrackPlayer.add([songForPlayback]);
    invalidateQueueSnapshot();
    await TrackPlayer.play();

    // NON-BLOCKING: Start history tracking AFTER playback begins
    // Uses InteractionManager to run after all UI interactions complete,
    // preventing any lag, hangs, or unresponsive UI from file I/O operations
    InteractionManager.runAfterInteractions(() => {
      historyManager
        .startTracking(song)
        .catch((err) =>
          console.error('HistoryManager: Background tracking error:', err)
        );
    });

    // Signal that this is a single song playback (enable auto-recommendations)
    DeviceEventEmitter.emit('playback-mode-changed', { isPlaylist: false });

    // CORRECT FLOW: Load initial recommendations immediately after playback starts
    // 1. Song plays -> 2. Recommendations API called -> 3. Songs added to queue
    // 4. Monitor set up for refill when 5 songs left
    // NON-BLOCKING: Use InteractionManager for proper deferral (better than setTimeout)
    // This waits for animations to complete before starting background work
    InteractionManager.runAfterInteractions(async () => {
      try {
        // Determine source based on song type
        // SPOTIFY SUPPORT: If this is a Spotify song mapped to YTMusic, use the YTMusic videoId
        const isSpotifyMapped =
          updatedSong.mappedFromSpotify && updatedSong.ytMusicVideoId;
        const isYTId =
          song.id &&
          typeof song.id === 'string' &&
          song.id.length === 11 &&
          !song.isLocalMusic;
        const isDABSong =
          updatedSong.isDabTrack || updatedSong.source === 'dab';

        // For DAB songs, use Last.fm-powered recommendations
        if (isDABSong && lastFMService.isAuthenticated()) {
          // Register the song as a seed for vibe tracking
          dabRecommendationService.registerSongPlayed({
            title: song.title || song.name,
            artist: song.artist,
            id: song.id,
          });

          // Fetch recommendations from Last.fm via DABRecommendationService
          const dabRecommendations =
            await dabRecommendationService.getRecommendations(20);

          if (dabRecommendations && dabRecommendations.length > 0) {
            // Filter out the currently playing song
            const filteredRecs = dabRecommendations.filter(
              (rec) => rec.id !== song.id
            );

            if (filteredRecs.length > 0) {
              await AddSongsToQueue(filteredRecs);
              // Trigger prefetch for N+1
              setImmediate(() => {
                const smartPrefetchManager =
                  require('./Utils/SmartPrefetchManager').default;
                smartPrefetchManager._prefetchTrackAtIndex(1).catch((err) => {
                  if (!err.message?.includes("doesn't exist")) {
                  }
                });
              });
            }
          } else {
            // Fall back to YTMusic recommendations using song title/artist search
          }

          // Start the continuous monitor for DAB to enable infinite playback
          queueManager.startContinuousQueueMonitor(song.id);
          return;
        }

        // For Spotify-mapped songs, use YTMusic recommendations via the mapped videoId
        const source = isSpotifyMapped || isYTId ? 'ytmusic' : 'saavn';
        const recommendationSongId = isSpotifyMapped
          ? updatedSong.ytMusicVideoId
          : song.id;

        // Load initial recommendations
        const recommendations =
          await queueManager.buildQueueFromRecommendations(
            recommendationSongId,
            source,
            20
          );

        if (recommendations && recommendations.length > 0) {
          // SAFETY: Filter out the currently playing song to prevent duplicates
          // For Spotify-mapped songs, also check against the YTMusic videoId
          const filteredRecs = recommendations.filter(
            (rec) => rec.id !== song.id && rec.id !== recommendationSongId
          );

          if (filteredRecs.length > 0) {
            await AddSongsToQueue(filteredRecs);
            // 🎵 PREMIUM UX: Trigger initial prefetch for N+1 immediately after queue loads
            // This ensures the next song is ready even faster
            setImmediate(() => {
              const smartPrefetchManager =
                require('./Utils/SmartPrefetchManager').default;
              smartPrefetchManager._prefetchTrackAtIndex(1).catch((err) => {
                // Silence expected errors when queue isn't ready
                if (!err.message?.includes("doesn't exist")) {
                }
              });
            });
          }
        }

        // Now start the monitor (it will only trigger refill when 5 songs remain)
        queueManager.startContinuousQueueMonitor(recommendationSongId);
      } catch (err) {
        console.error('Error loading initial recommendations:', err);
        // Still start monitor even if initial load fails
        // Use ytMusicVideoId for Spotify-mapped songs
        const fallbackSongId =
          updatedSong.mappedFromSpotify && updatedSong.ytMusicVideoId
            ? updatedSong.ytMusicVideoId
            : song.id;
        queueManager.startContinuousQueueMonitor(fallbackSongId);
      }
    });
  } catch (error) {
    console.error('Error playing song:', error);
  }
}

async function AddPlaylist(songs, startSongId = null) {
  try {
    // Validate songs array
    if (!Array.isArray(songs) || songs.length === 0) {
      console.error('Invalid songs array provided to AddPlaylist');
      return;
    }

    // Filter/Slice if startSongId is provided
    let tracksToAdd = [...songs];
    if (startSongId) {
      const startIndex = songs.findIndex(
        (s) => s.id === startSongId || s.videoId === startSongId
      );
      if (startIndex !== -1) {
        tracksToAdd = songs.slice(startIndex);
      } else {
        console.warn(
          `⚠️ Start song ID ${startSongId} not found in playlist, playing all`
        );
      }
    }

    // OPTIMISTIC UI: Emit early metadata for first song so mini player shows immediately
    // This provides instant feedback while stream URL is being fetched
    const firstSong = tracksToAdd[0];
    if (firstSong) {
      const earlyArtwork =
        extractArtwork(firstSong) || firstSong.artwork || firstSong.image || '';
      // Format artist properly - handle various data structures
      let artistDisplay = firstSong.artist || 'Loading...';
      if (!artistDisplay || artistDisplay === 'Loading...') {
        if (
          firstSong.artists?.primary &&
          Array.isArray(firstSong.artists.primary)
        ) {
          artistDisplay = FormatArtist(firstSong.artists.primary);
        } else if (typeof firstSong.artists === 'string') {
          artistDisplay = firstSong.artists;
        } else if (firstSong.primaryArtists) {
          artistDisplay = firstSong.primaryArtists;
        }
      }

      DeviceEventEmitter.emit('song-loading-started', {
        id: firstSong.id || firstSong.videoId,
        title:
          firstSong.title || firstSong.name || firstSong.song || 'Loading...',
        artist: artistDisplay,
        artwork: earlyArtwork,
        image: earlyArtwork,
        duration: firstSong.duration,
        isLoading: true,
        isPlaylist: true, // Flag to indicate playlist/album playback
      });
    }

    // Get quality setting ONCE
    const qualityIndex = await getIndexQuality();
    const qualityNames = ['12kbps', '48kbps', '96kbps', '160kbps', '320kbps'];
    const currentQuality = qualityNames[qualityIndex] || 'Unknown';
    const albumId = tracksToAdd[0]?.albumId;

    // Helper function to process single song (extracted to avoid code duplication)
    const processSingleSong = async (song, index, isFirstSong = false) => {
      let playbackUrl = song.url;
      let updatedSong = { ...song, albumId: albumId || song.albumId };

      // Check if this is a podcast episode - skip all stream processing
      const isPodcast = song.isPodcast || song.type === 'podcast';
      const isYouTubeSong =
        !isPodcast &&
        song.id &&
        typeof song.id === 'string' &&
        song.id.length === 11 &&
        !song.isLocalMusic;

      if (isYouTubeSong) {
        if (isFirstSong) {
          try {
            const streamData = await youtubeStreamingService.getStreamUrl(
              song.id
            );
            if (streamData && streamData.url) {
              playbackUrl = streamData.url;
              updatedSong = {
                ...updatedSong,
                url: streamData.url,
                headers: streamData.headers,
                userAgent: streamData.headers?.['User-Agent'],
                artwork: streamData.thumbnail || updatedSong.artwork,
                duration: streamData.duration || updatedSong.duration,
                title: streamData.title || updatedSong.title,
                currentPlayingQuality: currentQuality,
              };
            }
          } catch (error) {
            console.error('Error fetching YouTube stream:', error.message);
          }
        } else {
          // LAZY LOAD: Set placeholder URL
          playbackUrl = `ytmusic://${song.id || song.videoId}`;
          updatedSong._needsStream = true;
          updatedSong.isYTMusic = true;
          updatedSong.source = 'ytmusic';
          updatedSong.sourceType = 'online';
          updatedSong.url = playbackUrl;
          updatedSong.currentPlayingQuality = currentQuality;
        }
      }
      // Spotify tracks
      else if (song.source === 'spotify' || song.spotifyId) {
        if (isFirstSong) {
          try {
            const earlyArtwork =
              extractArtwork(song) || song.artwork || song.image || '';
            DeviceEventEmitter.emit('song-loading-started', {
              id: song.id,
              title: song.title || song.name || 'Loading...',
              artist: song.artist || 'Finding on YTMusic...',
              artwork: earlyArtwork,
              image: earlyArtwork,
              duration: song.duration,
              isLoading: true,
              isSpotifyMapping: true,
            });

            const YouTubeMusicService =
              require('./Utils/YouTubeMusicService').default;
            const ytMusicResult = await YouTubeMusicService.searchAndStream(
              song.title || song.name,
              song.artist || ''
            );

            if (ytMusicResult && ytMusicResult.url && !ytMusicResult.error) {
              playbackUrl = ytMusicResult.url;
              const isOpus = ytMusicResult.mimeType?.includes('webm');
              const estimatedBitrate =
                ytMusicResult.bitrate || (isOpus ? 148000 : 256000);
              const bitrateKbps = Math.round(estimatedBitrate / 1000);
              const codec = isOpus ? 'Opus' : 'AAC';

              updatedSong = {
                ...updatedSong,
                url: ytMusicResult.url,
                headers: ytMusicResult.headers,
                userAgent: ytMusicResult.headers?.['User-Agent'],
                ytMusicVideoId: ytMusicResult.videoId,
                mappedFromSpotify: true,
                currentPlayingQuality: `${codec} ${bitrateKbps}kbps`,
              };
            } else {
              console.error('❌ Failed to map first Spotify song to YTMusic');
            }
          } catch (error) {
            console.error(
              'Error mapping first Spotify playlist song:',
              error.message
            );
          }
        } else {
          // LAZY LOAD: Set placeholder
          playbackUrl = `spotify://${song.id || song.spotifyId}`;
          updatedSong._needsStream = true;
          updatedSong._needsSpotifyMapping = true;
          updatedSong.source = 'spotify';
          updatedSong.spotifyId = song.id || song.spotifyId;
          updatedSong.sourceType = 'online';
          updatedSong.url = playbackUrl;
          updatedSong.currentPlayingQuality = currentQuality;
        }
      }
      // DAB tracks
      else if (
        song.isDabTrack ||
        song.source === 'dab' ||
        (!isNaN(song.url) && String(song.url).length > 5)
      ) {
        if (isFirstSong) {
          try {
            await dabMusicService.initialize();
            const streamUrl = await dabMusicService.getStreamUrl(song.id);

            if (streamUrl) {
              playbackUrl = streamUrl;
              const fmtMatch = streamUrl.match(/[?&]fmt=(\d+)/);
              const fmt = fmtMatch ? fmtMatch[1] : null;
              const formatMap = {
                5: 'MP3 320kbps',
                6: 'FLAC 16-bit/44.1kHz',
                7: 'FLAC 24-bit/96kHz',
                27: 'FLAC 24-bit/192kHz',
              };
              updatedSong = {
                ...updatedSong,
                url: streamUrl,
                source: 'dab',
                isDabTrack: true,
                currentPlayingQuality: formatMap[fmt] || 'FLAC',
              };
            }
          } catch (error) {
            console.error(
              'Error fetching DAB stream for first song:',
              error.message
            );
          }
        } else {
          playbackUrl = `dab://${song.id}`;
          updatedSong._needsStream = true;
          updatedSong._needsDabStream = true;
          updatedSong.source = 'dab';
          updatedSong.isDabTrack = true;
          updatedSong.sourceType = 'online';
          updatedSong.url = playbackUrl;
          updatedSong.currentPlayingQuality = currentQuality;
        }
      } else {
        // Standard file/download URL logic (Saavn, etc.)
        if (song.downloadUrl && Array.isArray(song.downloadUrl)) {
          const entry =
            song.downloadUrl[qualityIndex] ||
            song.downloadUrl[song.downloadUrl.length - 1] ||
            song.downloadUrl[0];
          updatedSong.url = entry?.url || entry?.link || song.url;
        } else if (song.download_url && Array.isArray(song.download_url)) {
          const entry =
            song.download_url[qualityIndex] ||
            song.download_url[song.download_url.length - 1] ||
            song.download_url[0];
          updatedSong.url = entry?.url || entry?.link || song.url;
        }
        playbackUrl = updatedSong.url;
      }

      const artworkUrl = extractArtwork(song) || extractArtwork(updatedSong);
      let extractedArtist =
        updatedSong.artist ||
        song.artist ||
        (typeof song.artists === 'string' ? song.artists : null) ||
        song.primaryArtists ||
        (song.artists?.primary ? FormatArtist(song.artists.primary) : null) ||
        'Unknown Artist';

      const normalizedSong = {
        ...updatedSong,
        url: playbackUrl || updatedSong.url,
        title: updatedSong.title || updatedSong.name || song.name || 'Unknown',
        artist: extractedArtist,
        artwork: artworkUrl,
        image: artworkUrl,
        currentPlayingQuality:
          updatedSong.currentPlayingQuality || currentQuality,
        // Store original full name for lyrics search (not truncated for display)
        originalTitle:
          song.name || song.title || updatedSong.name || updatedSong.title,
      };

      // SAFETY: Ensure URL exists
      if (!normalizedSong.url) {
        if (
          song.source === 'spotify' ||
          song.spotifyId ||
          updatedSong._needsSpotifyMapping
        ) {
          normalizedSong.url = `spotify://${
            song.id || song.spotifyId || 'unknown'
          }`;
          normalizedSong._needsStream = true;
          normalizedSong._needsSpotifyMapping = true;
          normalizedSong.source = 'spotify';
        } else if (
          song.source === 'dab' ||
          song.isDabTrack ||
          updatedSong._needsDabStream
        ) {
          normalizedSong.url = `dab://${song.id || 'unknown'}`;
          normalizedSong._needsStream = true;
          normalizedSong._needsDabStream = true;
          normalizedSong.source = 'dab';
        } else if (isYouTubeSong) {
          normalizedSong.url = `ytmusic://${
            song.id || song.videoId || 'unknown'
          }`;
          normalizedSong._needsStream = true;
        } else {
          return null; // Skip songs with no URL
        }
      }

      return normalizedSong;
    };

    // ============================================================
    // PHASE 1: Process only INITIAL BATCH for instant playback
    // This prevents UI blocking by NOT processing all 89+ songs upfront
    // ============================================================
    const INITIAL_BATCH_SIZE = 20;
    const initialTracks = tracksToAdd.slice(0, INITIAL_BATCH_SIZE);
    const remainingTracks = tracksToAdd.slice(INITIAL_BATCH_SIZE);

    // Process initial batch - only first song gets stream fetch
    const initialProcessed = await Promise.all(
      initialTracks.map((song, index) =>
        processSingleSong(song, index, index === 0)
      )
    );
    const validInitialSongs = initialProcessed.filter((song) => song !== null);

    // Cleanup any previous progressive loading session
    progressiveQueueLoader.cleanup();

    // Start playback IMMEDIATELY with initial batch
    await TrackPlayer.reset();
    await TrackPlayer.add(validInitialSongs);
    invalidateQueueSnapshot();
    await TrackPlayer.play();

    // CRITICAL: Emit queue-updated immediately so Context.Queue syncs
    // This ensures queue panel shows songs even before progressive loading completes
    DeviceEventEmitter.emit('queue-updated', {
      count: validInitialSongs.length,
    });

    DeviceEventEmitter.emit('playback-mode-changed', { isPlaylist: true });
    // ============================================================
    // PROGRESSIVE LOADING: Use ProgressiveQueueLoader for remaining songs
    // This uses threshold-based loading - adds batches when user approaches
    // end of loaded songs, keeping UI responsive throughout playback
    // ============================================================
    if (remainingTracks.length > 0) {
      // Initialize progressive loader with remaining tracks
      // The loader will monitor track position and add batches as needed
      progressiveQueueLoader
        .initialize(
          remainingTracks,
          processSingleSong,
          0 // Start from beginning of remainingTracks
        )
        .then((result) => {
          if (result.success && result.initialBatch.length > 0) {
            // Add the first batch from progressive loader immediately in background
            InteractionManager.runAfterInteractions(async () => {
              try {
                await TrackPlayer.add(result.initialBatch);
                DeviceEventEmitter.emit('queue-updated', {
                  count: validInitialSongs.length + result.initialBatch.length,
                  isProgressiveBatch: true,
                });
              } catch (err) {
                console.error(
                  '❌ Error adding progressive batch:',
                  err.message
                );
              }
            });
          }
        })
        .catch((err) => {
          console.error('❌ ProgressiveQueueLoader init error:', err.message);
          // Fallback: Load all remaining in old way if progressive loader fails
          InteractionManager.runAfterInteractions(async () => {
            try {
              const BATCH_SIZE = 25;
              for (let i = 0; i < remainingTracks.length; i += BATCH_SIZE) {
                const batch = remainingTracks.slice(i, i + BATCH_SIZE);
                await new Promise((resolve) => setTimeout(resolve, 32));
                const processedBatch = await Promise.all(
                  batch.map((song, batchIndex) =>
                    processSingleSong(
                      song,
                      INITIAL_BATCH_SIZE + i + batchIndex,
                      false
                    )
                  )
                );
                const validBatch = processedBatch.filter(
                  (song) => song !== null
                );
                if (validBatch.length > 0) {
                  await TrackPlayer.add(validBatch);
                }
              }
              DeviceEventEmitter.emit('queue-updated', {
                count: tracksToAdd.length,
              });
            } catch (batchError) {
              console.error(
                '❌ Error in fallback batch loading:',
                batchError.message
              );
            }
          });
        });
    }

    // Prefetch next song check (deferred)
    setTimeout(() => {
      queueManager
        .prefetchNextTrack()
        .catch((err) =>
          console.error('Error prefetching next track:', err.message)
        );
    }, 1000);
  } catch (error) {
    console.error('Error in AddPlaylist:', error);
  }
}

async function AddSongsToQueue(songs) {
  const qualityIndex = await getIndexQuality();
  const qualityNames = ['12kbps', '48kbps', '96kbps', '160kbps', '320kbps'];
  const currentQuality = qualityNames[qualityIndex] || 'Unknown';

  const processedSongs = [];

  for (const song of songs) {
    const hasValidYouTubeId =
      song.id && typeof song.id === 'string' && song.id.length === 11;
    const isYTMusicSource =
      song.source === 'ytmusic' || song.isYTMusic === true;
    const isDabSong = song.isDabTrack || song.source === 'dab';

    let processedSong = { ...song };

    // Explicitly check for Saavn markers BEFORE ID length check
    // to avoid misidentifying 11-char Saavn IDs as YouTube
    const hasSaavnMarkers =
      song.source === 'saavn' ||
      (song.downloadUrl && Array.isArray(song.downloadUrl)) ||
      (song.download_url && Array.isArray(song.download_url));

    if (
      ((hasValidYouTubeId && !song.isLocalMusic) || isYTMusicSource) &&
      !hasSaavnMarkers
    ) {
      // LAZY LOAD: Do NOT fetch stream here. Just set placeholder.
      const videoId = song.id || song.videoId;
      processedSong = {
        ...processedSong,
        url: `ytmusic://${videoId}`,
        _needsStream: true,
        isYTMusic: true,
        source: 'ytmusic',
        sourceType: 'online', // CRITICAL: Set sourceType for queue filtering
        currentPlayingQuality: currentQuality,
        // Ensure artwork is set correctly using helper
        artwork: extractArtwork(song),
        image: extractArtwork(song),
        duration: song.duration,
      };
    } else if (isDabSong) {
      // DAB songs logic - fetch stream URL with rate limiting protection
      processedSong = { ...processedSong, isDab: true, sourceType: 'online' };
      try {
        await dabMusicService.initialize();
        const streamUrl = await dabMusicService.getStreamUrl(song.id);
        if (streamUrl) {
          processedSong.url = streamUrl;
          // Add delay between DAB API calls to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 300));
        } else {
          // If no stream URL, mark for Saavn fallback
          processedSong.url = null;
        }
      } catch (e) {
        // Handle rate limiting (429) gracefully
        if (e.message?.includes('429') || e.response?.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          try {
            const retryUrl = await dabMusicService.getStreamUrl(song.id);
            if (retryUrl) {
              processedSong.url = retryUrl;
            }
          } catch (retryErr) {}
        }
      }
    } else {
      // Standard logic for downloads/local
      const getQueueUrl = (entries) => {
        if (!Array.isArray(entries)) {
          return '';
        }
        const preferred =
          entries[qualityIndex] ||
          entries.find((d) => d?.url || d?.link || d?.uri) ||
          entries[0];
        return preferred?.url || preferred?.link || preferred?.uri || '';
      };

      if (song.downloadUrl && Array.isArray(song.downloadUrl)) {
        processedSong.url = getQueueUrl(song.downloadUrl) || song.url;
      } else if (song.download_url && Array.isArray(song.download_url)) {
        processedSong.url = getQueueUrl(song.download_url) || song.url;
      }
      processedSong.source = 'saavn';
      processedSong.currentPlayingQuality = currentQuality;
    }

    // CRITICAL: Check if valid URL for standard tracks
    if (
      processedSong.url &&
      (processedSong.url.includes('jiosaavn.com/song/') ||
        processedSong.url.includes('jiosaavn.com/album/'))
    ) {
      console.warn(
        `⚠️ AddSongsToQueue: URL looks like a web page for ${
          song.name || song.title
        }`,
        processedSong.url
      );
    }

    // NORMALIZE METADATA (Critical for Saavn/Standard tracks)
    // 1. Ensure Title
    if (!processedSong.title && processedSong.name) {
      processedSong.title = String(processedSong.name)
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#039;/g, "'");
    }
    if (!processedSong.title) {
      processedSong.title = 'Unknown Title';
    }

    // 2. Ensure Artist
    if (!processedSong.artist) {
      if (processedSong.primaryArtists) {
        processedSong.artist = processedSong.primaryArtists;
      } else if (processedSong.artists && processedSong.artists.primary) {
        processedSong.artist = FormatArtist(processedSong.artists.primary);
      } else {
        processedSong.artist = 'Unknown Artist';
      }
    }

    // 3. Ensure Artwork is a string URL
    if (!processedSong.artwork || typeof processedSong.artwork !== 'string') {
      const extracted = extractArtwork(processedSong);
      if (extracted) {
        processedSong.artwork = extracted;
        // Also set image for compatibility
        processedSong.image = extracted;
      }
    }

    // 4. Store original full name for lyrics search
    processedSong.originalTitle =
      song.name || song.title || processedSong.name || processedSong.title;

    processedSongs.push(processedSong);
  }

  // Filter out songs that failed to get URLs (avoid "URL cannot be empty" errors)
  const validSongs = processedSongs.filter(
    (song) => song.url && song.url.length > 0 && !song.url.includes('undefined')
  );

  if (validSongs.length !== processedSongs.length) {
  }

  if (validSongs.length > 0) {
    try {
      // BATCHED ADDITION STRATEGY
      // 1. Add first small batch immediately for instant UI response
      const INITIAL_BATCH_SIZE = 20;
      const initialBatch = validSongs.slice(0, INITIAL_BATCH_SIZE);

      await TrackPlayer.add(initialBatch);
      // Emit event to update UI immediately
      DeviceEventEmitter.emit('queue-updated', { count: initialBatch.length });

      // 2. Add remaining songs in background batches
      const remainingSongs = validSongs.slice(INITIAL_BATCH_SIZE);

      if (remainingSongs.length > 0) {
        InteractionManager.runAfterInteractions(async () => {
          try {
            const BATCH_SIZE = 50;
            for (let i = 0; i < remainingSongs.length; i += BATCH_SIZE) {
              const batch = remainingSongs.slice(i, i + BATCH_SIZE);

              // Small delay to allow UI frame updates between batches
              if (i > 0) {
                await new Promise((resolve) => setTimeout(resolve, 50));
              }

              await TrackPlayer.add(batch);
            }

            // Final event to ensuring everything is synced
            DeviceEventEmitter.emit('queue-updated', {
              count: validSongs.length,
            });
          } catch (batchError) {
            console.error('❌ Error adding background batch:', batchError);
          }
        });
      }
    } catch (error) {
      console.error('❌ Failed to add songs to queue:', error.message);
    }
  }
}
async function PlaySong() {
  await TrackPlayer.play();
}
async function PauseSong() {
  await TrackPlayer.pause();
}

async function SetProgressSong(value) {
  try {
    // Ensure value is a valid number and within bounds
    const seekValue = Math.max(0, parseFloat(value) || 0);
    await TrackPlayer.seekTo(seekValue);
  } catch (error) {
    console.error('Error seeking to position:', error);
  }
}

// Max time a manual skip will wait for an un-prefetched stream before giving
// up and letting the player's error recovery take over. Keeps a cache miss
// feeling like a short load instead of a dead-air error cycle.
const SKIP_STREAM_TIMEOUT_MS = 1500;

/**
 * Resolve the stream for a track we are about to skip to.
 *
 * Returns true when the queue entry is playable. Historically this fired the
 * fetch and skipped onto the `ytmusic://` placeholder anyway, which made
 * ExoPlayer raise a PlaybackError and forced a fetch + queue rebuild + player
 * restart - about a second of frozen timeline. Resolving first costs one
 * network round-trip and keeps playback in a valid state throughout.
 */
async function resolveTrackForSkip(track, index, signal) {
  if (!smartPrefetchManager.needsStream(track)) {
    return true;
  }

  // Fast path: already prefetched.
  const cachedStream = smartPrefetchManager.getPrefetchedStream(track.id);
  if (cachedStream) {
    await smartPrefetchManager.replaceTrackAndWait(index, track, cachedStream);
    return true;
  }

  // Slow path: resolve on demand, but never block the skip indefinitely.
  try {
    const streamData = await Promise.race([
      smartPrefetchManager.fetchOnDemand(track.id, signal),
      new Promise((resolve) =>
        setTimeout(() => resolve(null), SKIP_STREAM_TIMEOUT_MS)
      ),
    ]);

    if (signal?.aborted) {
      throw new Error('AbortError');
    }

    if (streamData && streamData.url) {
      await smartPrefetchManager.replaceTrackAndWait(index, track, streamData);
      return true;
    }
  } catch (error) {
    if (error.message === 'AbortError') {
      throw error;
    }
  }

  // Fall through: skip anyway and let the recovery handler deal with it.
  return false;
}

// Rapid presses inside this window collapse into a single jump. Previously
// each button had its own lock that silently swallowed presses during a skip,
// which is what made the controls feel dead.
const SKIP_COALESCE_MS = 120;

let pendingSkipTarget = null;
let skipCoalesceTimer = null;
let skipWaiters = [];
// Target of the skip currently executing. Presses that land while a skip is
// still resolving must accumulate from here, not from the active index, which
// hasn't moved yet.
let activeSkipTarget = null;

/** Clamp a target index to something that actually exists in the queue. */
async function clampToExistingIndex(target) {
  const candidate = Math.max(0, target);

  // getTrack() resolves null for an out-of-range index (no throw), so this is
  // a cheap single-track existence check.
  const direct = await TrackPlayer.getTrack(candidate);
  if (direct) {
    return candidate;
  }

  // Overshot the end of the queue - clamp to the last track. Uses the shared
  // snapshot so this doesn't become another full queue serialization.
  const length = await getQueueLength(0);
  if (!length) {
    return -1;
  }
  return Math.min(candidate, length - 1);
}

/** Push a track's metadata to the optimistic-UI listeners. */
function emitTrackLoading(track, isLoading = true) {
  if (!track) {
    return;
  }
  DeviceEventEmitter.emit('song-loading-started', {
    id: track.id,
    title: track.title || 'Loading...',
    artist: track.artist || 'Loading...',
    artwork: track.artwork || track.image || '',
    image: track.artwork || track.image || '',
    duration: track.duration,
    isLoading,
  });
}

/**
 * Re-publish the track that is actually playing.
 * The mini player clears its optimistic "loading" state only when the active
 * track id matches what it was shown, so a burst that cancels itself out
 * (next then previous) would otherwise leave it stuck on a song we never
 * skipped to.
 */
async function resetLoadingToActiveTrack() {
  try {
    const activeTrack = await TrackPlayer.getActiveTrack();
    emitTrackLoading(activeTrack, false);
  } catch (e) {}
}

function resolveSkipWaiters() {
  const waiters = skipWaiters;
  skipWaiters = [];
  waiters.forEach((resolve) => resolve());
}

/** Run the coalesced skip to whatever target the burst settled on. */
async function flushPendingSkip() {
  skipCoalesceTimer = null;

  const requestedTarget = pendingSkipTarget;
  pendingSkipTarget = null;

  if (requestedTarget === null || requestedTarget === undefined) {
    resolveSkipWaiters();
    return;
  }

  activeSkipTarget = requestedTarget;

  // Cancel in-flight prefetches so they don't rewrite the queue mid-skip.
  smartPrefetchManager.cancelAllPrefetches();

  try {
    await skipOperationManager.executeSkip(async (signal) => {
      try {
        if (!isPlayerInitialized) {
          await setupPlayer();
        }

        if (signal.aborted) {
          throw new Error('AbortError');
        }

        const targetIndex = await clampToExistingIndex(requestedTarget);
        if (targetIndex === -1) {
          await resetLoadingToActiveTrack();
          return;
        }

        const currentIndex = await TrackPlayer.getActiveTrackIndex();
        if (targetIndex === currentIndex) {
          // Burst cancelled itself out (next then previous) - nothing to do.
          await resetLoadingToActiveTrack();
          return;
        }

        const targetTrack = await TrackPlayer.getTrack(targetIndex);
        if (!targetTrack) {
          await resetLoadingToActiveTrack();
          return;
        }

        // OPTIMISTIC UI: show the destination track's metadata right away.
        emitTrackLoading(targetTrack);

        // NON-BLOCKING: stop tracking now that we know we really are moving
        // (bailing out above would otherwise end the current song's history
        // entry without starting a new one).
        historyManager.stopTracking().catch(() => {});

        await resolveTrackForSkip(targetTrack, targetIndex, signal);

        if (signal.aborted) {
          throw new Error('AbortError');
        }

        // Skip by absolute index: a stream replacement may have shifted the
        // queue, and skipToNext/skipToPrevious would race with that.
        await TrackPlayer.skip(targetIndex);
        await TrackPlayer.play();

        // NON-BLOCKING: background bookkeeping
        setImmediate(async () => {
          try {
            const newTrack = await TrackPlayer.getActiveTrack();
            if (newTrack) {
              historyManager.startTracking(newTrack).catch(() => {});
              skipOperationManager.resetErrorCounter();
            }
          } catch (e) {}
        });
      } catch (error) {
        if (error.message === 'AbortError') {
          return;
        }
        console.error('Error performing skip:', error);
      }
    }, true);
  } finally {
    // Only clear if a newer burst hasn't already claimed the slot.
    if (activeSkipTarget === requestedTarget) {
      activeSkipTarget = null;
    }
    resolveSkipWaiters();
  }
}

/**
 * Queue a manual skip. Presses accumulate into a single target index, so
 * tapping next three times jumps three tracks with one stream resolution
 * instead of three sequential round-trips (or two dropped presses).
 *
 * @param {'next'|'previous'} direction
 */
async function performSkip(direction) {
  const delta = direction === 'next' ? 1 : -1;

  let base = pendingSkipTarget;
  if (base === null || base === undefined) {
    base = activeSkipTarget;
  }
  if (base === null || base === undefined) {
    const activeIndex = await TrackPlayer.getActiveTrackIndex();
    if (activeIndex === undefined || activeIndex === null) {
      return;
    }
    base = activeIndex;
  }

  pendingSkipTarget = Math.max(0, base + delta);

  // Instant feedback for the current best guess (single-track bridge call).
  try {
    emitTrackLoading(await TrackPlayer.getTrack(pendingSkipTarget));
  } catch (e) {}

  return new Promise((resolve) => {
    skipWaiters.push(resolve);

    if (skipCoalesceTimer) {
      clearTimeout(skipCoalesceTimer);
    }
    skipCoalesceTimer = setTimeout(() => {
      flushPendingSkip().catch(() => resolveSkipWaiters());
    }, SKIP_COALESCE_MS);
  });
}

async function PlayNextSong() {
  await performSkip('next');
}

async function PlayPreviousSong() {
  await performSkip('previous');
}

async function SkipToTrack(trackIndex) {
  try {
    // NON-BLOCKING: stop tracking in the background
    historyManager.stopTracking().catch(() => {});

    // Ensure trackIndex is a valid number
    const validIndex = Number(trackIndex);
    if (isNaN(validIndex) || validIndex < 0) {
      console.error('Invalid trackIndex provided to SkipToTrack:', trackIndex);
      return;
    }

    // PERFORMANCE: getTrack() validates bounds without serializing the whole
    // queue across the bridge.
    const targetTrack = await TrackPlayer.getTrack(validIndex);
    if (!targetTrack) {
      console.error('Track index out of bounds:', validIndex);
      return;
    }

    // OPTIMISTIC UI: show the destination metadata immediately
    emitTrackLoading(targetTrack);

    if (smartPrefetchManager.needsStream(targetTrack)) {
      const cachedStream = smartPrefetchManager.getPrefetchedStream(
        targetTrack.id
      );

      const streamData =
        cachedStream ||
        (await smartPrefetchManager.fetchOnDemand(targetTrack.id));

      if (streamData && streamData.url) {
        await smartPrefetchManager.replaceTrackAndWait(
          validIndex,
          targetTrack,
          streamData
        );
      } else {
        console.error('Failed to get stream for selected track');
        // Don't leave the mini player stuck on a song we never played
        await resetLoadingToActiveTrack();
        return;
      }
    }

    await TrackPlayer.skip(validIndex);

    // Get the new track and start tracking it
    const newTrack = await TrackPlayer.getActiveTrack();
    if (newTrack) {
      // Non-blocking: Don't await, let it run in background
      historyManager
        .startTracking(newTrack)
        .catch((err) => console.error('History tracking error:', err));
    }

    await PlaySong();
  } catch (error) {
    console.error('Error in SkipToTrack:', error);
  }
}
async function SetRepeatMode(mode) {
  await TrackPlayer.setRepeatMode(mode);
}

async function getIndexQuality() {
  const PlaybackQuality = [
    { value: '12kbps' },
    { value: '48kbps' },
    { value: '96kbps' },
    { value: '160kbps' },
    { value: '320kbps' },
  ];
  const data = await GetPlaybackQuality();
  let index = 4;
  PlaybackQuality.map((e, i) => {
    if (e.value === data) {
      index = i;
    }
  });
  return index;
}

async function AddOneSongToPlaylist(song) {
  try {
    // Import the bottom sheet playlist selector manager for better UX
    const {
      PlaylistSelectorBottomSheetManager,
    } = require('./Utils/PlaylistSelectorBottomSheetManager');

    // Validate song object
    if (!song || !song.id) {
      console.error(
        '❌ Invalid song object provided to AddOneSongToPlaylist:',
        song
      );
      ToastAndroid.show('Invalid song data', ToastAndroid.SHORT);
      return false;
    }
    // Safe image URL extraction
    const getImageUrl = (imageData) => {
      if (!imageData) {
        return null;
      }
      if (typeof imageData === 'string') {
        return imageData;
      }
      if (Array.isArray(imageData)) {
        for (const img of imageData) {
          if (typeof img === 'string' && img.trim() !== '') {
            return img;
          }
          if (img && typeof img === 'object' && img.url) {
            return img.url;
          }
        }
      }
      if (imageData && typeof imageData === 'object' && imageData.url) {
        return imageData.url;
      }
      return null;
    };

    // Format song object for playlist compatibility if needed
    const formattedSong = {
      id: song.id,
      title: song.title || 'Unknown Title',
      artist: song.artist || 'Unknown Artist',
      artwork: getImageUrl(song.artwork) || getImageUrl(song.image) || null,
      url: song.url || '',
      duration: song.duration || 0,
      language: song.language || '',
      artistID: song.artistID || song.primary_artists_id || '',
    };

    // Use the PlaylistSelectorBottomSheetManager to show the bottom drawer
    const result = PlaylistSelectorBottomSheetManager.show(formattedSong);
    return result;
  } catch (error) {
    console.error('❌ Error showing playlist selector bottom sheet:', error);
    ToastAndroid.show('Error opening playlist selector', ToastAndroid.SHORT);
    return false;
  }
}

export {
  PlayOneSong,
  PlaySong,
  PauseSong,
  SetProgressSong,
  PlayNextSong,
  AddPlaylist,
  PlayPreviousSong,
  AddSongsToQueue,
  SkipToTrack,
  SetRepeatMode,
  getIndexQuality,
  AddOneSongToPlaylist,
};
