import { Dimensions, View, StyleSheet, TouchableOpacity } from 'react-native';
import { Heading } from '../Global/Heading';
import { SmallText } from '../Global/SmallText';
import { Spacer } from '../Global/Spacer';
import { PlayButton } from './PlayButton';
import LinearGradient from 'react-native-linear-gradient';
import { useThemeContext } from '../../Context/ThemeContext';
import { AddPlaylist,  getIndexQuality,
  PlayOneSong,
} from '../../MusicPlayerFunctions';
import { useContext, useState, useEffect } from 'react';
import Context from '../../Context/Context';
import { LikedPlaylist } from './LikedPlaylist';
import Ionicons from 'react-native-vector-icons/Ionicons';
import FormatArtist from '../../Utils/FormatArtists';
import FormatTitleAndArtist from '../../Utils/FormatTitleAndArtist';
import { CacheManager } from '../../Utils/CacheManager';
import TrackPlayer, { useActiveTrack } from 'react-native-track-player';
import { DownloadButton } from '../Global/DownloadButton';
import { requestWithFallback } from '../../Api/apiUtils';

// Reduce truncate limit further to avoid layout issues
const truncateText = (text, limit = 20) => {
  if (!text) {
    return '';
  }
  return text.length > limit ? text.substring(0, limit) + '...' : text;
};

// Helper to format artist data properly, avoiding [object Object] display
const formatArtistData = (artistData) => {
  // If it's already a string, return it
  if (typeof artistData === 'string') {
    return artistData;
  }

  // If it's an array, use the FormatArtist function
  if (Array.isArray(artistData)) {
    return FormatArtist(artistData);
  }

  // If it's an object with a primary property that's an array
  if (artistData && artistData.primary && Array.isArray(artistData.primary)) {
    return FormatArtist(artistData.primary);
  }

  // If it's an object with a name property
  if (artistData && artistData.name) {
    return artistData.name;
  }

  // Default fallback
  return 'Unknown Artist';
};

// Helper to safely get song URL
const getSongUrl = (song, quality) => {
  // Check if downloadUrl exists in proper format
  if (
    song.downloadUrl &&
    Array.isArray(song.downloadUrl) &&
    song.downloadUrl.length > quality &&
    song.downloadUrl[quality]?.url
  ) {
    return song.downloadUrl[quality].url;
  }
  if (
    song.downloadUrl &&
    Array.isArray(song.downloadUrl) &&
    song.downloadUrl.length > quality &&
    song.downloadUrl[quality]?.link
  ) {
    return song.downloadUrl[quality].link;
  }
  // Check if download_url exists (alternate format)
  else if (
    song.download_url &&
    Array.isArray(song.download_url) &&
    song.download_url.length > quality &&
    song.download_url[quality]?.url
  ) {
    return song.download_url[quality].url;
  } else if (
    song.download_url &&
    Array.isArray(song.download_url) &&
    song.download_url.length > quality &&
    song.download_url[quality]?.link
  ) {
    return song.download_url[quality].link;
  }
  // Fallback to any available URL in the array
  else if (song.downloadUrl && Array.isArray(song.downloadUrl)) {
    for (let i = 0; i < song.downloadUrl.length; i++) {
      if (song.downloadUrl[i]?.url) {
        return song.downloadUrl[i].url;
      }
      if (song.downloadUrl[i]?.link) {
        return song.downloadUrl[i].link;
      }
    }
  }
  // Final fallback for download_url
  else if (song.download_url && Array.isArray(song.download_url)) {
    for (let i = 0; i < song.download_url.length; i++) {
      if (song.download_url[i]?.url) {
        return song.download_url[i].url;
      }
      if (song.download_url[i]?.link) {
        return song.download_url[i].link;
      }
    }
  }

  return '';
};

export const PlaylistDetails = ({
  name = '',
  listener = '',
  notReleased = false,
  Data = {},
  Loading = true,
  id = '',
  image = '',
  follower = '',
  playlistId = '',
}) => {
  const { updateTrack } = useContext(Context);
  const currentPlaying = useActiveTrack();
  const [isPlaying, setIsPlaying] = useState(false);
  const [loading, setLoading] = useState(Loading);
  const { theme } = useThemeContext();
  const width = Dimensions.get('window').width;
  const [playlistData, setPlaylistData] = useState(Data);

  // Reset isPlaying when Loading changes to false
  useEffect(() => {
    if (!Loading) {
      checkPlaybackState();
    }
  }, [Loading]);

  // Check if this playlist is currently playing
  const checkPlaybackState = async () => {
    try {
      // Get the current player state - check if playing or paused
      const playerState = await TrackPlayer.getState();
      const isPlayerPlaying = playerState === TrackPlayer.STATE_PLAYING;
      const currentTrackIndex = await TrackPlayer.getCurrentTrack();

      // If no track is playing, definitely not playing
      if (currentTrackIndex === null) {
        setIsPlaying(false);
        return;
      }

      // Get current track and queue
      const currentTrack = await TrackPlayer.getTrack(currentTrackIndex);
      const queue = await TrackPlayer.getQueue();
      const playlistSongs = Data?.data?.songs || [];

      // Direct match by playlist ID - most reliable approach
      if (
        currentTrack &&
        currentTrack.playlistId &&
        (currentTrack.playlistId === id ||
          currentTrack.playlistId === playlistId)
      ) {
        setIsPlaying(isPlayerPlaying);
        return;
      }

      // If current track doesn't have playlistId, check if any song in the queue has a matching ID
      // Create a set of playlist song IDs for faster lookup
      const playlistSongIds = new Set();
      playlistSongs.forEach((song) => {
        if (song && song.id) {
          playlistSongIds.add(song.id);
        }
      });

      // Check if current track's ID is in our playlist
      if (
        currentTrack &&
        currentTrack.id &&
        playlistSongIds.has(currentTrack.id)
      ) {
        setIsPlaying(isPlayerPlaying);
        return;
      }

      // Last resort: check if any song in the queue is from this playlist
      const isPlaylistInQueue = queue.some((track) => {
        return (
          track.playlistId === id ||
          track.playlistId === playlistId ||
          playlistSongIds.has(track.id)
        );
      });

      // Only playing if the player is playing AND a playlist song is in the queue
      setIsPlaying(isPlayerPlaying && isPlaylistInQueue);
    } catch (error) {
      console.error('Error checking playback state:', error);
      setIsPlaying(false);
    }
  };

  // Setup listeners for track changes and playback state
  useEffect(() => {
    // Initial check
    checkPlaybackState();

    // Create a single function to handle all state updates
    const updatePlaybackState = () => {
      setTimeout(() => {
        checkPlaybackState();
      }, 50); // Small delay to ensure TrackPlayer state is updated
    };

    // Set up listeners for various TrackPlayer events
    const stateListener = TrackPlayer.addEventListener(
      'playback-state',
      updatePlaybackState
    );

    const trackChangeListener = TrackPlayer.addEventListener(
      'playback-track-changed',
      updatePlaybackState
    );

    const queueListener = TrackPlayer.addEventListener(
      'playback-queue-ended',
      updatePlaybackState
    );

    // Also set up an interval to periodically check state
    // This helps catch any edge cases where events might be missed
    const intervalCheck = setInterval(updatePlaybackState, 3000);

    return () => {
      stateListener.remove();
      trackChangeListener.remove();
      queueListener.remove();
      clearInterval(intervalCheck);
    };
  }, [Data, id, playlistId]);

  useEffect(() => {
    const loadPlaylistData = async () => {
      try {
        setLoading(true);

        // Try to get data from cache first
        const cachedData = await CacheManager.getFromCache(
          playlistId,
          'playlist'
        );
        if (cachedData) {
          setPlaylistData(cachedData);
          setLoading(false);
          // Fetch fresh data in background
          fetchPlaylistData();
          return;
        }

        // If no cache, fetch fresh data
        await fetchPlaylistData();
      } catch (error) {
        console.error('Error loading playlist:', error);
        setLoading(false);
      }
    };

    const fetchPlaylistData = async () => {
      try {
        const data = await requestWithFallback(
          `https://jiosaavn-api-privatecvc2.vercel.app/playlists/${playlistId}`,
          `https://jio-saavan-api.vercel.app/playlists/${playlistId}`
        );

        setPlaylistData(data);
        // Cache the fresh data
        await CacheManager.saveToCache(playlistId, data, 'playlist');
      } catch (error) {
        console.error('Error fetching playlist:', error);
      } finally {
        setLoading(false);
      }
    };

    if (playlistId) {
      loadPlaylistData();
    }
  }, [playlistId]);

  async function AddToPlayer() {
    if (!Data?.data?.songs || Data.data.songs.length === 0) {
      return;
    }

    try {
      // If already playing, pause playback
      if (isPlaying) {
        await TrackPlayer.pause();
        setIsPlaying(false);
        return;
      }

      // Check if current track is from this playlist but paused
      const currentTrackIndex = await TrackPlayer.getCurrentTrack();
      const queue = await TrackPlayer.getQueue();
      const playlistSongs = Data?.data?.songs || [];

      // Create a set of playlist song IDs for faster lookup
      const playlistSongIds = new Set();
      playlistSongs.forEach((song) => {
        if (song && song.id) {
          playlistSongIds.add(song.id);
        }
      });

      // First check if the currently loaded track is from this playlist
      let isPlaylistTrackCurrent = false;

      if (currentTrackIndex !== null) {
        const currentTrack = await TrackPlayer.getTrack(currentTrackIndex);
        if (currentTrack) {
          if (
            currentTrack.playlistId === id ||
            currentTrack.playlistId === playlistId
          ) {
            isPlaylistTrackCurrent = true;
          } else if (playlistSongIds.has(currentTrack.id)) {
            isPlaylistTrackCurrent = true;
          }
        }
      }

      // Check if any queue item is from this playlist
      const isPlaylistInQueue = queue.some(
        (track) =>
          track.playlistId === id ||
          track.playlistId === playlistId ||
          playlistSongIds.has(track.id)
      );

      if (isPlaylistTrackCurrent || isPlaylistInQueue) {
        // Resume playback if playlist is already in queue but paused
        await TrackPlayer.play();
        setIsPlaying(true);
        return;
      }

      // Start loading indicator
      setLoading(true);

      const quality = await getIndexQuality();

      const ForMusicPlayer = [];

      // Process each song in the playlist
      for (let i = 0; i < Data.data.songs.length; i++) {
        const e = Data.data.songs[i];
        if (!e) {
          continue;
        }

        // Process artist data to avoid [object Object] display
        const artistData = e?.artists || e?.primary_artists;
        const formattedArtist = formatArtistData(artistData);

        // Get song URL using helper function
        const songUrl = getSongUrl(e, quality);

        if (!songUrl) {
          continue;
        }

        ForMusicPlayer.push({
          url: songUrl,
          title: FormatTitleAndArtist(e?.name || e?.song || ''),
          artist: FormatTitleAndArtist(e?.primaryArtists || formattedArtist),
          artwork:
            e?.image?.[2]?.link ||
            e?.image?.[2]?.url ||
            e?.image?.[2]?.uri ||
            (Array.isArray(e?.image) ? e.image[e.image.length - 1]?.url || e.image[e.image.length - 1]?.link : '') ||
            '',
          image:
            e?.image?.[2]?.link ||
            e?.image?.[2]?.url ||
            e?.image?.[2]?.uri ||
            (Array.isArray(e?.image) ? e.image[e.image.length - 1]?.url || e.image[e.image.length - 1]?.link : '') ||
            '',
          duration: e?.duration || 0,
          id: e?.id || `unknown-${i}`,
          language: e?.language || '',
          artistID:
            e?.primaryArtistsId || e?.primary_artists_id || e?.artist_id || '',
          // Include playlist ID for tracking which playlist a song belongs to
          playlistId: id || playlistId || '',
          // Include basic info for debugging
          downloadUrl: e?.downloadUrl || e?.download_url || [],
          // Preserve additional metadata for song info display
          year: e?.year,
          playCount: e?.playCount,
          label: e?.label,
          copyright: e?.copyright,
          hasLyrics: e?.hasLyrics,
          album: e?.album,
          artists: e?.artists,
          releaseDate: e?.releaseDate,
          explicitContent: e?.explicitContent,
        });
      }
      if (ForMusicPlayer.length === 0) {
        setLoading(false);
        return;
      }

      // Use AddPlaylist function to play the songs
      await AddPlaylist(ForMusicPlayer);

      // Set isPlaying to true immediately after starting playback
      setIsPlaying(true);

      updateTrack();
    } catch (error) {
      console.error('Error adding songs to player:', error);
    } finally {
      setLoading(false);
    }
  }

  // If not released, don't render anything
  if (notReleased) {
    return null;
  }

  // Make sure to truncate the name properly for display
  const displayName = truncateText(name, 24); // Increased character limit for better display

  return (
    <View style={styles.outerContainer}>
      {/* Like button removed as it's now in the PlaylistTopHeader component */}

      <View style={styles.container}>
        <LinearGradient
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          colors={[
            'rgba(44,44,44,0)',
            theme.colors.card,
            theme.colors.background,
          ]}
          style={styles.gradientContainer}
        >
          {/* Playlist info on the left */}
          <View style={styles.infoContainer}>
            <Heading
              text={displayName}
              style={styles.heading}
              numberOfLines={1}
            />
          </View>

          {/* Controls on the right - Download icon and Play button */}
          <View style={styles.controlsContainer}>
            {/* Download button in middle */}
            <DownloadButton
              songs={Data?.data?.songs || []}
              albumName={name}
              size="normal"
            />

            {/* Play button on right */}
            <PlayButton
              onPress={AddToPlayer}
              Loading={loading}
              isPlaying={isPlaying}
              size="normal"
              playlistId={id || playlistId}
            />
          </View>
        </LinearGradient>
      </View>
    </View>
  );
};

// Move styles to StyleSheet for better performance
const styles = StyleSheet.create({
  outerContainer: {
    position: 'relative',
    width: '100%',
  },
  container: {
    width: '100%',
  },
  gradientContainer: {
    padding: 16,
    paddingVertical: 18,
    paddingTop: 24,
    alignItems: 'center',
    justifyContent: 'space-between',
    flexDirection: 'row',
  },
  infoContainer: {
    flex: 1,
    paddingLeft: 4,
    paddingRight: 12, // Increased padding for better spacing
  },
  heading: {
    fontSize: 22,
    marginBottom: 4,
    flex: 1, // Allow text to flex and truncate properly
  },
  followerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 2,
  },
  controlsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16, // Increased gap for better spacing between buttons
  },
});
