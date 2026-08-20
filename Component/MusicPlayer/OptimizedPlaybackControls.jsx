/**
 * OptimizedPlaybackControls.jsx
 *
 * Isolated, optimized playback controls that don't trigger parent re-renders.
 * Uses useCallback and memo aggressively to prevent unnecessary updates.
 */

import React, { memo, useCallback, useRef } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  InteractionManager,
} from 'react-native';
import { usePlaybackState, useProgress } from 'react-native-track-player';
import TrackPlayer, { State } from 'react-native-track-player';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {
  PlayNextSong,
  PlayPreviousSong,
  PlaySong,
  PauseSong,
} from '../../MusicPlayerFunctions';

// Memoized individual button component
const ControlButton = memo(
  ({
    iconName,
    size = 32,
    color = '#fff',
    onPress,
    disabled = false,
    style,
  }) => {
    const handlePress = useCallback(() => {
      if (!disabled && onPress) {
        // Execute immediately without waiting
        onPress();
      }
    }, [disabled, onPress]);

    return (
      <TouchableOpacity
        onPress={handlePress}
        disabled={disabled}
        activeOpacity={0.6}
        style={[styles.button, style]}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <MaterialCommunityIcons
          name={iconName}
          size={size}
          color={disabled ? `${color}55` : color}
        />
      </TouchableOpacity>
    );
  }
);

// Play/Pause button - isolated to prevent re-renders of other buttons
const PlayPauseButton = memo(({ size = 64, color = '#fff' }) => {
  const playbackState = usePlaybackState();
  const isProcessing = useRef(false);

  const isPlaying = playbackState.state === State.Playing;
  const isBuffering =
    playbackState.state === State.Buffering ||
    playbackState.state === State.Loading;

  const handlePlayPause = useCallback(async () => {
    // Prevent double-taps
    if (isProcessing.current) {
      return;
    }
    isProcessing.current = true;

    try {
      if (isPlaying) {
        // INSTANT pause - highest priority
        await TrackPlayer.pause();
      } else {
        await TrackPlayer.play();
      }
    } catch (error) {
      console.error('PlayPause error:', error);
    } finally {
      // Reset after short delay
      setTimeout(() => {
        isProcessing.current = false;
      }, 100);
    }
  }, [isPlaying]);

  const iconName = isBuffering
    ? 'loading'
    : isPlaying
    ? 'pause-circle'
    : 'play-circle';

  return (
    <TouchableOpacity
      onPress={handlePlayPause}
      activeOpacity={0.7}
      style={styles.playButton}
      hitSlop={{ top: 5, bottom: 5, left: 5, right: 5 }}
    >
      <MaterialCommunityIcons name={iconName} size={size} color={color} />
    </TouchableOpacity>
  );
});

// Skip buttons - completely isolated
const SkipButton = memo(({ direction = 'next', size = 36, color = '#fff' }) => {

  const handleSkip = useCallback(async () => {
    // Rapid presses are coalesced by the skip scheduler, so they are no longer
    // dropped here.

    try {
      if (direction === 'next') {
        await PlayNextSong();
      } else {
        await PlayPreviousSong();
      }
    } catch (error) {
      console.error(`Skip ${direction} error:`, error);
    }
  }, [direction]);

  return (
    <ControlButton
      iconName={
        direction === 'next' ? 'skip-next-circle' : 'skip-previous-circle'
      }
      size={size}
      color={color}
      onPress={handleSkip}
    />
  );
});

// Main optimized controls component
const OptimizedPlaybackControls = memo(
  ({
    iconColor = '#fff',
    playButtonSize = 64,
    skipButtonSize = 36,
    showShuffleRepeat = true,
  }) => {
    return (
      <View style={styles.container}>
        {/* Previous */}
        <SkipButton
          direction="previous"
          size={skipButtonSize}
          color={iconColor}
        />

        {/* Play/Pause */}
        <PlayPauseButton size={playButtonSize} color={iconColor} />

        {/* Next */}
        <SkipButton direction="next" size={skipButtonSize} color={iconColor} />
      </View>
    );
  }
);

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    gap: 24,
  },
  button: {
    padding: 8,
  },
  playButton: {
    padding: 4,
  },
});

export default OptimizedPlaybackControls;
export { ControlButton, PlayPauseButton, SkipButton };
