import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Entypo from 'react-native-vector-icons/Entypo';
import { useTheme } from '@react-navigation/native';
import { useContext, useEffect, useState } from 'react';
import TrackPlayer, { State, useActiveTrack } from 'react-native-track-player';
import Context from '../../Context/Context';

export const PlayButton = ({
  onPress,
  Loading,
  size = 'normal',
  isPlaying: externalIsPlaying = null,
  albumId = null,
  playlistId = null,
}) => {
  const theme = useTheme();
  const [isPlaying, setIsPlaying] = useState(false);
  const currentPlaying = useActiveTrack();
  const [isPressed, setIsPressed] = useState(false);

  // Effect to check if currently playing
  useEffect(() => {
    // If external isPlaying prop is provided, use that
    if (externalIsPlaying !== null) {
      setIsPlaying(externalIsPlaying);
      return;
    }

    // Check if this album/playlist's songs are playing
    const checkPlaybackState = async () => {
      try {
        // First check if anything is playing
        const state = await TrackPlayer.getState();
        const isPlayerPlaying = state === State.Playing;
        const currentTrackIndex = await TrackPlayer.getCurrentTrack();

        // If no track is playing, definitely not playing
        if (currentTrackIndex === null) {
          setIsPlaying(false);
          return;
        }

        // Get the current track
        const currentTrack = await TrackPlayer.getTrack(currentTrackIndex);

        // If we have an albumId, check if the currently playing song is from this album
        if (albumId && currentTrack) {
          // Album-specific logic: only show pause if the current track is from this album
          const isFromThisAlbum = currentTrack.albumId === albumId;
          setIsPlaying(isPlayerPlaying && isFromThisAlbum);
        }
        // If we have a playlistId, similar check for playlists
        else if (playlistId && currentTrack) {
          // Check if current track has playlistId matching this playlist
          if (currentTrack.playlistId === playlistId) {
            setIsPlaying(isPlayerPlaying);
            return;
          }

          // For playlists without direct ID match, check if any songs in queue match
          try {
            const queue = await TrackPlayer.getQueue();
            // Look for any track with this playlistId
            const isFromThisPlaylist = queue.some(
              (track) => track.playlistId === playlistId
            );
            setIsPlaying(isPlayerPlaying && isFromThisPlaylist);
          } catch (error) {
            console.error('Error checking queue for playlist tracks:', error);
          }
        } else {
          // Legacy behavior for non-album/playlist contexts
          setIsPlaying(isPlayerPlaying);
        }
      } catch (err) {
        console.error('Error checking playback state:', err);
        setIsPlaying(false);
      }
    };

    checkPlaybackState();

    // Set up event listener for track player state changes
    const playerStateListener = TrackPlayer.addEventListener(
      'playback-state',
      () => {
        // When state changes, recheck playback state
        checkPlaybackState();
      }
    );

    // Set up listener for track changes
    const trackChangeListener = TrackPlayer.addEventListener(
      'playback-track-changed',
      () => {
        // When track changes, recheck the playback state
        checkPlaybackState();
      }
    );

    return () => {
      playerStateListener.remove();
      trackChangeListener.remove();
    };
  }, [externalIsPlaying, currentPlaying, albumId, playlistId]);

  // Determine size based on prop - reduce large size to be less dominant
  const buttonSize = size === 'large' ? 62 : size === 'small' ? 44 : 54;
  const iconSize = size === 'large' ? 36 : size === 'small' ? 24 : 30;
  const buttonPadding = size === 'large' ? 14 : size === 'small' ? 12 : 14;

  // Handle press with visual feedback
  const handlePress = () => {
    setIsPressed(true);
    onPress && onPress();
    // Reset pressed state after a short delay for visual feedback
    setTimeout(() => setIsPressed(false), 150);
  };

  return (
    <View
      style={[
        styles.buttonWrapper,
        {
          width: buttonSize,
          height: buttonSize,
          marginRight: 0,
          marginLeft: 0,
          // Enhanced glow effect when large
          elevation: size === 'large' ? 10 : 6,
          shadowRadius: size === 'large' ? 5 : 3,
        },
      ]}
    >
      <Pressable
        onPress={handlePress}
        style={({ pressed }) => [
          styles.button,
          {
            backgroundColor: '#4CAF50', // Bright green color like in the screenshot
            width: buttonSize,
            height: buttonSize,
            opacity: pressed || isPressed ? 0.8 : 1, // Feedback when pressed
            transform: [pressed || isPressed ? { scale: 0.95 } : { scale: 1 }], // Scale down when pressed
          },
        ]}
        android_ripple={{ color: 'rgba(255,255,255,0.3)', borderless: true }}
      >
        {!Loading && (
          <Entypo
            name={isPlaying ? 'controller-paus' : 'controller-play'}
            color="#000000" // Black icon for better contrast on green
            size={iconSize}
            style={[
              styles.icon,
              isPlaying ? {} : { marginLeft: 4 }, // Only adjust position for play icon
            ]}
          />
        )}
        {Loading && (
          <ActivityIndicator
            color="#000000"
            size={size === 'large' ? 'large' : 'small'}
          />
        )}
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  buttonWrapper: {
    // Add a wrapper to handle shadows and effects
    borderRadius: 1000,
    elevation: 8,
    shadowColor: '#4CAF50', // Match button color for glow effect
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 4,
  },
  button: {
    borderRadius: 1000, // Very high value for perfect circle
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  icon: {
    // Removed default marginLeft - we'll handle it conditionally
  },
});
