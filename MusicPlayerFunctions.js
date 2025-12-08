import TrackPlayer from "react-native-track-player";
import { setRepeatMode } from "react-native-track-player/lib/trackPlayer";
import { GetPlaybackQuality } from "./LocalStorage/AppSettings";
import NetInfo from "@react-native-community/netinfo";
import { ToastAndroid, DeviceEventEmitter } from "react-native";
import historyManager from "./Utils/HistoryManager";

import dabMusicService from "./Utils/DabMusicService";
import youtubeStreamingService from "./Utils/YouTubeStreamingService";
import queueManager from "./Utils/QueueManager";
import autoRecommendations from "./Utils/AutoRecommendations";
import skipOperationManager from "./Utils/SkipOperationManager";
import streamFetchManager from "./Utils/StreamFetchManager";
import smartPrefetchManager from "./Utils/SmartPrefetchManager";

let isPlayerInitialized = false;

// Helper to extract artwork URL from various formats
const extractArtwork = (song) => {
  // Direct artwork/image string
  if (song.artwork && typeof song.artwork === 'string' && song.artwork.length > 0) {
    return song.artwork;
  }
  if (song.image && typeof song.image === 'string' && song.image.length > 0) {
    return song.image;
  }

  // Object format with url/uri
  if (song.artwork && typeof song.artwork === 'object') {
    if (song.artwork.url) return song.artwork.url;
    if (song.artwork.uri) return song.artwork.uri;
  }

  // Array format (Saavn/OuterTune)
  if (song.image && Array.isArray(song.image)) {
    const bestImage = song.image[2] || song.image[song.image.length - 1] || song.image[0];
    if (bestImage?.url) return bestImage.url;
    if (bestImage?.link) return bestImage.link;
    if (typeof bestImage === 'string') return bestImage;
  }

  // Single Image Object format
  if (song.image && typeof song.image === 'object') {
    if (song.image.url) return song.image.url;
    if (song.image.uri) return song.image.uri;
  }

  // Thumbnail format (YTMusic)
  if (song.thumbnail) {
    if (typeof song.thumbnail === 'string') return song.thumbnail;
    if (typeof song.thumbnail === 'object' && song.thumbnail.url) return song.thumbnail.url;
  }

  if (song.thumbnails && Array.isArray(song.thumbnails)) {
    const bestThumb = song.thumbnails[song.thumbnails.length - 1] || song.thumbnails[0];
    if (bestThumb?.url) return bestThumb.url;
  }

  // Try to find any property that looks like a URL
  if (song.artwork?.uri) return song.artwork.uri;
  if (song.image?.uri) return song.image.uri;

  return '';
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
          autoHandleInterruptions: true,
          autoUpdateMetadata: true,
        });
        console.log('Player initialized successfully in MusicPlayerFunctions');

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
          ]
        });

        isPlayerInitialized = true;

        // Initialize SmartPrefetchManager for background prefetching
        smartPrefetchManager.initialize();

      } catch (setupError) {
        // Check if the error is about player already being initialized
        if (setupError.message && setupError.message.includes('player has already been initialized')) {
          console.log('Player already initialized in MusicPlayerFunctions');
          isPlayerInitialized = true;
          smartPrefetchManager.initialize();
        } else {
          console.error('Error setting up player in MusicPlayerFunctions:', setupError);
          throw setupError;
        }
      }
    } else {
      console.log('Player already initialized, skipping setup in MusicPlayerFunctions');
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
      console.log('Player not initialized, setting up...');
      await setupPlayer();
    }

    // Get the appropriate URL based on playback quality setting
    let playbackUrl = song.url;
    let updatedSong = { ...song };

    // Check if this is a YouTube song (has videoId/id that looks like YouTube video ID)
    const isYouTubeSong = song.id && typeof song.id === 'string' && song.id.length === 11 && !song.isLocalMusic;

    if (isYouTubeSong) {
      try {
        console.log('Fetching YouTube stream for video ID:', song.id);

        // Use StreamFetchManager for deduplication and abort support
        const streamData = await streamFetchManager.fetchStream(
          song.id,
          async (videoId, signal) => {
            return await youtubeStreamingService.getStreamUrl(videoId, signal);
          }
        );

        if (streamData && streamData.url) {
          playbackUrl = streamData.url;
          // Update song with stream data and headers
          // IMPORTANT: Preserve artist from original song data
          updatedSong = {
            ...updatedSong,
            url: streamData.url,
            headers: streamData.headers,  // CRITICAL: Pass headers to TrackPlayer
            userAgent: streamData.headers?.['User-Agent'],  // Explicit for ExoPlayer
            artwork: streamData.thumbnail || updatedSong.artwork,
            duration: streamData.duration || updatedSong.duration,
            // Only use stream title if we don't have a good title already
            title: updatedSong.title || streamData.title,
            // Preserve artist from original song data (don't use stream artist)
            artist: updatedSong.artist || 'Unknown Artist',
          };
          console.log('YouTube stream URL fetched successfully');

          // Reset error counter on successful fetch
          skipOperationManager.resetErrorCounter();
        } else {
          console.error('Failed to get YouTube stream URL');
          ToastAndroid.show('Failed to load YouTube stream', ToastAndroid.SHORT);
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
    // Check if this is a DAB Music track
    else if (song.isDabTrack || song.source === 'dab' || (!isNaN(song.url) && String(song.url).length > 5)) {
      try {
        console.log('🎵 DAB Track detected! Fetching stream URL for ID:', song.id);
        await dabMusicService.initialize();
        const streamUrl = await dabMusicService.getStreamUrl(song.id);

        if (streamUrl) {
          playbackUrl = streamUrl;

          // Parse format from URL to determine quality
          const fmtMatch = streamUrl.match(/[?&]fmt=(\d+)/);
          const fmt = fmtMatch ? fmtMatch[1] : null;
          const formatMap = {
            '5': 'MP3 320kbps',
            '6': 'FLAC 16-bit/44.1kHz',
            '7': 'FLAC 24-bit/96kHz',
            '27': 'FLAC 24-bit/192kHz'
          };
          const dabQuality = formatMap[fmt] || 'FLAC';

          updatedSong = {
            ...updatedSong,
            url: streamUrl,
            currentPlayingQuality: dabQuality  // Set actual FLAC quality
          };
          console.log('✅ DAB stream URL fetched successfully');
          console.log('🎵 Quality:', dabQuality);
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
      if (song.downloadUrl && Array.isArray(song.downloadUrl)) {
        const qualityIndex = await getIndexQuality();
        if (song.downloadUrl[qualityIndex]?.url) {
          playbackUrl = song.downloadUrl[qualityIndex].url;
        } else {
          // Fallback to any available URL
          for (let i = song.downloadUrl.length - 1; i >= 0; i--) {
            if (song.downloadUrl[i]?.url) {
              playbackUrl = song.downloadUrl[i].url;
              break;
            }
          }
        }
      } else if (song.download_url && Array.isArray(song.download_url)) {
        // Alternative format
        const qualityIndex = await getIndexQuality();
        if (song.download_url[qualityIndex]?.url) {
          playbackUrl = song.download_url[qualityIndex].url;
        } else {
          // Fallback to any available URL
          for (let i = song.download_url.length - 1; i >= 0; i--) {
            if (song.download_url[i]?.url) {
              playbackUrl = song.download_url[i].url;
              break;
            }
          }
        }
      }
    }

    // Validate song URL
    if (!playbackUrl || typeof playbackUrl !== 'string') {
      console.error('PlayOneSong: Invalid or missing song URL', song);
      ToastAndroid.show('Cannot play song - invalid URL', ToastAndroid.SHORT);
      return;
    }

    // Check if the song is a local file (has a path or isLocalMusic property)
    const isLocalFile = song.isLocalMusic || song.path || playbackUrl.startsWith('file://');

    // If it's a local file, make sure the URL starts with file://
    if (isLocalFile && !playbackUrl.startsWith('file://') && song.path) {
      playbackUrl = `file://${song.path}`;
    }

    // Check network availability for non-local files
    if (!isLocalFile) {
      const netInfo = await NetInfo.fetch();
      if (!netInfo.isConnected) {
        console.log('Cannot play online song while offline');
        // Return early or try to play a cached version
        return;
      }
    }

    // Start tracking this song in history
    await historyManager.startTracking(song);

    // Create a copy of the song with the selected playback URL and quality info
    const qualityIndex = await getIndexQuality();
    const qualityNames = ['12kbps', '48kbps', '96kbps', '160kbps', '320kbps'];
    const currentQuality = qualityNames[qualityIndex] || 'Unknown';

    const songForPlayback = {
      ...updatedSong,
      url: playbackUrl,
      currentPlayingQuality: currentQuality
    };

    await TrackPlayer.reset();
    await TrackPlayer.add([songForPlayback]);
    await TrackPlayer.play();

    // NOTE: Auto-recommendations disabled here per user request
    // User will manually trigger recommendations where needed (not for playlists)
    // Original code for individual YTMusic song plays:
    /*
    if (isYouTubeSong) {
      setTimeout(async () => {
        try {
          console.log('🎵 Building queue from YTMusic recommendations for:', song.id);
          const recommendations = await queueManager.buildQueueFromRecommendations(song.id, 'ytmusic', 30);

          if (recommendations && recommendations.length > 0) {
            // Filter out the current song from recommendations
            const filteredRecs = recommendations.filter(rec => rec.id !== song.id);

            if (filteredRecs.length > 0) {
              // Use AddSongsToQueue which handles stream fetching for YTMusic
              await AddSongsToQueue(filteredRecs);
              console.log(`✅ Added ${filteredRecs.length} recommended songs to queue`);
            }
          }
        } catch (error) {
          console.error('Error building queue from recommendations:', error);
          // Non-fatal - continue playing the current song
        }
      }, 1500); // Wait 1.5 seconds after playback starts
    }
    */

    // Trigger prefetch for next song in queue (if any)
    setTimeout(() => {
      queueManager.prefetchNextTrack().catch(err =>
        console.error('Error prefetching next track:', err)
      );
    }, 3000); // Wait 3 seconds (after recommendations load)

    // Set up continuous queue monitoring - fetch more when near end
    queueManager.startContinuousQueueMonitor(song.id);
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
      const startIndex = songs.findIndex(s => s.id === startSongId || s.videoId === startSongId);
      if (startIndex !== -1) {
        console.log(`🎵 Playing from index ${startIndex} (Song ID: ${startSongId}), skipping previous ${startIndex} songs`);
        tracksToAdd = songs.slice(startIndex);
      } else {
        console.warn(`⚠️ Start song ID ${startSongId} not found in playlist, playing all`);
      }
    }

    // Ensure all songs have albumId if it exists on the first song
    const albumId = tracksToAdd[0]?.albumId;
    if (albumId) {
      tracksToAdd = tracksToAdd.map(song => ({
        ...song,
        albumId: albumId
      }));
    }

    // Apply playback quality setting to all songs
    const qualityIndex = await getIndexQuality();
    const qualityNames = ['12kbps', '48kbps', '96kbps', '160kbps', '320kbps'];
    const currentQuality = qualityNames[qualityIndex] || 'Unknown';

    const processedSongs = await Promise.all(tracksToAdd.map(async (song, index) => {
      let playbackUrl = song.url;
      let updatedSong = { ...song };

      // Check if this is a YouTube song
      const isYouTubeSong = song.id && typeof song.id === 'string' && song.id.length === 11 && !song.isLocalMusic;

      if (isYouTubeSong) {
        // Only fetch stream for the FIRST song immediately
        // All others get a placeholder and will be fetched on demand
        const isFirstSong = index === 0;

        if (isFirstSong) {
          try {
            console.log('Fetching YouTube stream for first playlist song:', song.id);
            const streamData = await youtubeStreamingService.getStreamUrl(song.id);

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
                currentPlayingQuality: currentQuality
              };
            }
          } catch (error) {
            console.error('Error fetching YouTube stream for first playlist song:', error);
          }
        } else {
          // LAZY LOAD: Set placeholder URL and flag
          playbackUrl = `ytmusic://${song.id || song.videoId}`;
          updatedSong._needsStream = true;
          updatedSong.isYTMusic = true;
          updatedSong.url = playbackUrl;
          updatedSong.currentPlayingQuality = currentQuality;
        }
      }
      // Check if this is a DAB Music track
      else if (song.isDabTrack || song.source === 'dab' || (!isNaN(song.url) && String(song.url).length > 5)) {
        try {
          // For DAB tracks, we might also want to lazy load if there are many?
          // For now, keeping existing logic but logging
          // console.log('🎵 DAB Track detected in playlist:', song.id);
          await dabMusicService.initialize();
          const streamUrl = await dabMusicService.getStreamUrl(song.id);

          if (streamUrl) {
            playbackUrl = streamUrl;
            // Parse format from URL to determine quality
            const fmtMatch = streamUrl.match(/[?&]fmt=(\d+)/);
            const fmt = fmtMatch ? fmtMatch[1] : null;
            const formatMap = {
              '5': 'MP3 320kbps',
              '6': 'FLAC 16-bit/44.1kHz',
              '7': 'FLAC 24-bit/96kHz',
              '27': 'FLAC 24-bit/192kHz'
            };
            const dabQuality = formatMap[fmt] || 'FLAC';

            updatedSong = {
              ...updatedSong,
              url: streamUrl,
              currentPlayingQuality: dabQuality
            };
          }
        } catch (error) {
          // console.error('❌ Error fetching DAB stream (soft fail):', error.message);
        }
      } else {
        // Standard file/download URL logic
        if (song.downloadUrl && Array.isArray(song.downloadUrl)) {
          updatedSong.url = song.downloadUrl[qualityIndex]?.url || song.downloadUrl.find(d => d?.url)?.url || song.url;
        } else if (song.download_url && Array.isArray(song.download_url)) {
          updatedSong.url = song.download_url[qualityIndex]?.url || song.download_url.find(d => d?.url)?.url || song.url;
        }
      }

      const artworkUrl = extractArtwork(song) || extractArtwork(updatedSong);

      return {
        ...updatedSong,
        url: playbackUrl || updatedSong.url,
        artwork: artworkUrl,
        image: artworkUrl,
        currentPlayingQuality: currentQuality
      };
    }));

    await TrackPlayer.reset();
    await TrackPlayer.add(processedSongs);
    await TrackPlayer.play();

    // Prefetch next song check
    setTimeout(() => {
      queueManager.prefetchNextTrack().catch(err =>
        console.error('Error prefetching next track:', err)
      );
    }, 1000);
  } catch (error) {
    console.error('Error in AddPlaylist:', error);
  }
}

async function AddSongsToQueue(songs) {
  console.log(`🎵 AddSongsToQueue: Lazy loading ${songs.length} songs...`);

  const qualityIndex = await getIndexQuality();
  const qualityNames = ['12kbps', '48kbps', '96kbps', '160kbps', '320kbps'];
  const currentQuality = qualityNames[qualityIndex] || 'Unknown';

  const processedSongs = [];

  for (const song of songs) {
    const hasValidYouTubeId = song.id && typeof song.id === 'string' && song.id.length === 11;
    const isYTMusicSource = song.source === 'ytmusic' || song.isYTMusic === true;
    const isDabSong = song.isDabTrack || song.source === 'dab';

    let processedSong = { ...song };

    if ((hasValidYouTubeId && !song.isLocalMusic) || isYTMusicSource) {
      // LAZY LOAD: Do NOT fetch stream here. Just set placeholder.
      const videoId = song.id || song.videoId;
      processedSong = {
        ...processedSong,
        url: `ytmusic://${videoId}`,
        _needsStream: true,
        isYTMusic: true,
        source: 'ytmusic',
        currentPlayingQuality: currentQuality,
        // Ensure artwork is set correctly using helper
        artwork: extractArtwork(song),
        image: extractArtwork(song),
        duration: song.duration
      };

    } else if (isDabSong) {
      // DAB songs logic - ideally lazy load too, but keeping minimal changes for now
      processedSong = { ...processedSong, isDab: true };
      try {
        await dabMusicService.initialize();
        const streamUrl = await dabMusicService.getStreamUrl(song.id);
        if (streamUrl) processedSong.url = streamUrl;
      } catch (e) { }

    } else {
      // Standard logic for downloads/local
      if (song.downloadUrl && Array.isArray(song.downloadUrl)) {
        processedSong.url = song.downloadUrl[qualityIndex]?.url || song.downloadUrl.find(d => d?.url)?.url || song.url;
      } else if (song.download_url && Array.isArray(song.download_url)) {
        processedSong.url = song.download_url[qualityIndex]?.url || song.download_url.find(d => d?.url)?.url || song.url;
      }
      processedSong.currentPlayingQuality = currentQuality;
    }

    processedSongs.push(processedSong);
  }

  if (processedSongs.length > 0) {
    try {
      // Add ALL songs at once - no batches!
      await TrackPlayer.add(processedSongs);
      console.log(`✅ Queue: Added ${processedSongs.length} songs instantly (Lazy Mode)`);

      // Emit event to refresh UI
      DeviceEventEmitter.emit('queue-updated', { count: processedSongs.length });
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

async function PlayNextSong() {
  // Use SkipOperationManager to debounce and lock skip operations
  const executed = await skipOperationManager.executeSkip(async (signal) => {
    try {
      // Ensure player is initialized
      if (!isPlayerInitialized) {
        console.log('Player not initialized, setting up...');
        await setupPlayer();
      }

      // Stop tracking current song before switching
      await historyManager.stopTracking();

      // Get current track and queue info
      const currentTrack = await TrackPlayer.getCurrentTrack();
      const queue = await TrackPlayer.getQueue();

      console.log('⏭️ PlayNextSong - Current:', currentTrack, 'Queue:', queue.length);

      // If there's no next track, just return
      if (currentTrack >= queue.length - 1) {
        console.log('No next track available');
        return;
      }

      const nextTrackIndex = currentTrack + 1;

      // Re-fetch queue to get the latest state (track may have been replaced by prefetch)
      const freshQueue = await TrackPlayer.getQueue();
      const nextTrack = freshQueue[nextTrackIndex];

      if (!nextTrack) {
        console.log('No next track available');
        return;
      }

      // Check if next track needs stream (wasn't prefetched or still has placeholder URL)
      const needsStream = nextTrack._needsStream ||
        nextTrack.url?.startsWith('ytmusic://') ||
        nextTrack.url?.includes('music.youtube.com');

      if (needsStream && !nextTrack._prefetched) {
        // FIRST: Check if SmartPrefetchManager has cached stream
        const smartPrefetchManager = require('./Utils/SmartPrefetchManager').default;
        const cachedStream = smartPrefetchManager.getPrefetchedStream(nextTrack.id);

        let streamData = cachedStream;

        if (cachedStream) {
          console.log('✅ Using cached prefetched stream for skip');
        } else {
          console.log('🔄 Track not in cache, fetching on-demand...');
          // Use SmartPrefetchManager for on-demand fetch (with retry)
          streamData = await smartPrefetchManager.fetchOnDemand(nextTrack.id);
        }

        if (streamData && streamData.url) {
          // Replace track in queue with valid URL
          const updatedTrack = {
            ...nextTrack,
            url: streamData.url,
            headers: streamData.headers,
            _needsStream: false,
            _prefetched: true
          };

          await TrackPlayer.remove(nextTrackIndex);
          await TrackPlayer.add(updatedTrack, nextTrackIndex);
          console.log('✅ Track replaced with valid URL');
        } else {
          // Failed to get stream - skip this track entirely
          console.error('❌ Failed to get stream, removing track');
          await TrackPlayer.remove(nextTrackIndex);
          // Try to play the next one instead
          await TrackPlayer.skipToNext();
          return;
        }
      }

      // Skip to next track - should now have valid URL
      await TrackPlayer.skipToNext();

      // Get the new track and start tracking it
      const newTrack = await TrackPlayer.getActiveTrack();
      if (newTrack) {
        await historyManager.startTracking(newTrack);
        skipOperationManager.resetErrorCounter();
      }

      // Ensure playback starts
      const stateAfterSkip = await TrackPlayer.getState();
      if (stateAfterSkip !== TrackPlayer.STATE_PLAYING) {
        await TrackPlayer.play();
      }

    } catch (error) {
      if (error.message === 'AbortError') {
        console.log('⏭️ Skip cancelled');
      } else {
        console.error('❌ Error in PlayNextSong:', error);
      }
      throw error;
    }
  });

  if (!executed) {
    console.log('⏭️ Skip blocked - operation in progress');
  }
}

async function PlayPreviousSong() {
  // Use SkipOperationManager to debounce and lock skip operations
  const executed = await skipOperationManager.executeSkip(async (signal) => {
    try {
      // Ensure player is initialized
      if (!isPlayerInitialized) {
        console.log('Player not initialized, setting up...');
        await setupPlayer();
      }

      // Stop tracking current song before switching
      await historyManager.stopTracking();

      // Check if operation was cancelled
      if (signal.aborted) {
        throw new Error('AbortError');
      }

      await TrackPlayer.skipToPrevious();

      // Get the new track and start tracking it
      const newTrack = await TrackPlayer.getActiveTrack();
      if (newTrack) {
        await historyManager.startTracking(newTrack);
        // Reset error counter on successful track change
        skipOperationManager.resetErrorCounter();
      }

      PlaySong();
    } catch (error) {
      if (error.message === 'AbortError') {
        console.log('⏮️ Skip cancelled');
      } else {
        console.error('❌ Error in PlayPreviousSong:', error);
      }
      throw error;
    }
  });

  if (!executed) {
    console.log('⏮️ Skip blocked - operation already in progress');
  }
}
async function SkipToTrack(trackIndex) {
  try {
    // Stop tracking current song before switching
    await historyManager.stopTracking();

    // Ensure trackIndex is a valid number
    const validIndex = Number(trackIndex);
    if (isNaN(validIndex)) {
      console.error('Invalid trackIndex provided to SkipToTrack:', trackIndex);
      return;
    }

    // Get the queue to verify index is within bounds
    const queue = await TrackPlayer.getQueue();
    if (validIndex < 0 || validIndex >= queue.length) {
      console.error('Track index out of bounds:', validIndex, 'Queue length:', queue.length);
      return;
    }

    const targetTrack = queue[validIndex];

    // Check if track needs stream (random song selection)
    const needsStream = targetTrack._needsStream ||
      targetTrack.url?.startsWith('ytmusic://') ||
      targetTrack.url?.includes('music.youtube.com');

    if (needsStream && !targetTrack._prefetched) {
      console.log('🎯 Random track selection - checking cache...');

      // FIRST: Check if SmartPrefetchManager has cached stream
      const cachedStream = smartPrefetchManager.getPrefetchedStream(targetTrack.id);

      let streamData = cachedStream;

      if (cachedStream) {
        console.log('✅ Using cached prefetched stream for random selection');
      } else {
        console.log('🔄 Track not in cache, fetching on-demand...');
        // Use SmartPrefetchManager for on-demand fetch (with retry)
        streamData = await smartPrefetchManager.fetchOnDemand(targetTrack.id);
      }

      if (streamData && streamData.url) {
        // Replace track in queue with valid URL
        const updatedTrack = {
          ...targetTrack,
          url: streamData.url,
          headers: streamData.headers,
          _needsStream: false,
          _prefetched: true
        };

        await TrackPlayer.remove(validIndex);
        await TrackPlayer.add(updatedTrack, validIndex);
        console.log('✅ Track replaced for random selection');
      } else {
        console.error('❌ Failed to get stream for random track');
        return;
      }
    }

    await TrackPlayer.skip(validIndex);

    // Get the new track and start tracking it
    const newTrack = await TrackPlayer.getActiveTrack();
    if (newTrack) {
      await historyManager.startTracking(newTrack);
    }

    await PlaySong();
  } catch (error) {
    console.error('Error in SkipToTrack:', error);
  }
}
async function SetRepeatMode(mode) {
  await setRepeatMode(mode)
}

async function getIndexQuality() {
  const PlaybackQuality = [
    { value: '12kbps' },
    { value: '48kbps' },
    { value: '96kbps' },
    { value: '160kbps' },
    { value: '320kbps' },
  ];
  const data = await GetPlaybackQuality()
  let index = 4
  PlaybackQuality.map((e, i) => {
    if (e.value === data) {
      index = i
    }
  })
  return index
}

async function AddOneSongToPlaylist(song) {
  try {
    console.log('🎵 AddOneSongToPlaylist called with song:', song?.title || 'Unknown');

    // Import the bottom sheet playlist selector manager for better UX
    const { PlaylistSelectorBottomSheetManager } = require('./Utils/PlaylistSelectorBottomSheetManager');

    // Validate song object
    if (!song || !song.id) {
      console.error('❌ Invalid song object provided to AddOneSongToPlaylist:', song);
      ToastAndroid.show('Invalid song data', ToastAndroid.SHORT);
      return false;
    }

    console.log('✅ Song validation passed, song ID:', song.id);

    console.log('AddOneSongToPlaylist called with song (bottom sheet):', song.title);

    // Safe image URL extraction
    const getImageUrl = (imageData) => {
      if (!imageData) return null;
      if (typeof imageData === 'string') return imageData;
      if (Array.isArray(imageData)) {
        for (const img of imageData) {
          if (typeof img === 'string' && img.trim() !== '') return img;
          if (img && typeof img === 'object' && img.url) return img.url;
        }
      }
      if (imageData && typeof imageData === 'object' && imageData.url) return imageData.url;
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
    console.log('📱 Attempting to show PlaylistSelectorBottomSheet...');
    const result = PlaylistSelectorBottomSheetManager.show(formattedSong);
    console.log('📱 PlaylistSelectorBottomSheetManager.show result:', result);
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
  AddOneSongToPlaylist
}
