import React, { useCallback } from 'react';
import { Animated, Pressable } from 'react-native';
import { useTheme } from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { PlayPreviousSong } from '../../MusicPlayerFunctions';

export const PreviousSongButton = ({ size = 28, color, style }) => {
  const theme = useTheme();
  const scaleAnim = React.useRef(new Animated.Value(1)).current;

  const handlePress = useCallback(() => {
    // No local lock: rapid presses are coalesced into a single jump by the
    // skip scheduler in MusicPlayerFunctions. The old isProcessingRef guard
    // silently swallowed every press made during a slow skip, which is what
    // made the controls feel frozen.
    Animated.sequence([
      Animated.timing(scaleAnim, {
        toValue: 0.85,
        duration: 50,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        friction: 4,
        useNativeDriver: true,
      }),
    ]).start();

    PlayPreviousSong().catch(() => {});
  }, [scaleAnim]);

  const buttonSize = 44; // Fixed size for the button container
  const iconSize = size || 24;

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => ({
        width: buttonSize,
        height: buttonSize,
        borderRadius: buttonSize / 2,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: pressed ? 'rgba(200, 200, 200, 0.3)' : 'transparent',
      })}
    >
      <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
        <Icon
          name="skip-previous"
          size={iconSize}
          color={color || theme.colors.onSurface}
        />
      </Animated.View>
    </Pressable>
  );
};
