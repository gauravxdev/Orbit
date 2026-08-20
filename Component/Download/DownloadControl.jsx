import React from 'react';
import { View, TouchableOpacity } from 'react-native';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import { useThemeContext } from '../../Context/ThemeContext';
import { DownloadProgressIndicator } from './DownloadProgressIndicator';
import { IconButton } from 'react-native-paper';

/**
 * DownloadControl - Renders the appropriate download button state
 * Handles different states: download, progress, completed, offline
 */
export const DownloadControl = ({
  isDownloaded = false,
  isDownloading = false,
  downloadProgress = 0,
  onDownloadPress = null,
  isOffline = false,
  disabled = false,
  size = 28,
  style = {},
  iconColor,
}) => {
  const { theme, themeMode } = useThemeContext();

  const pressedBackgroundColor =
    themeMode === 'light' ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.1)';
  const resolvedDownloadColor =
    iconColor ??
    (themeMode === 'light'
      ? isOffline
        ? '#888888'
        : theme.colors.text
      : isOffline
      ? '#888888'
      : '#ffffff');

  const controlIconStyle = {
    padding: 0,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    ...style,
  };

  // Always show checkmark in offline mode or if downloaded
  if (isOffline || isDownloaded) {
    return (
      <View
        style={[
          controlIconStyle,
          {
            width: size + 16,
            height: size + 16,
            justifyContent: 'center',
            alignItems: 'center',
          },
        ]}
      >
        <MaterialIcons
          name="check-circle"
          size={size}
          color="#4CAF50"
          style={{
            width: size,
            height: size,
            textAlign: 'center',
            lineHeight: size,
            includeFontPadding: false,
            textAlignVertical: 'center',
          }}
        />
      </View>
    );
  }

  // Show progress indicator while downloading
  if (isDownloading && downloadProgress > 0) {
    return (
      <View style={controlIconStyle}>
        <DownloadProgressIndicator
          progress={downloadProgress}
          size={size + 4}
          thickness={3}
          showPercentage={size >= 24}
        />
      </View>
    );
  }

  // Regular download button
  return (
    <IconButton
      icon={() => (
        <MaterialIcons
          name="file-download"
          size={size}
          color={resolvedDownloadColor}
        />
      )}
      size={32}
      onPress={onDownloadPress}
      disabled={disabled || isOffline || isDownloading}
      style={{ margin: 0, padding: 0 }}
      rippleColor="rgba(255, 255, 255, 0.2)"
    />
  );
};

/**
 * CompactDownloadControl - A smaller version for use in lists
 */
export const CompactDownloadControl = ({
  isDownloaded = false,
  isDownloading = false,
  downloadProgress = 0,
  onDownloadPress = null,
  isOffline = false,
  disabled = false,
}) => {
  return (
    <DownloadControl
      isDownloaded={isDownloaded}
      isDownloading={isDownloading}
      downloadProgress={downloadProgress}
      onDownloadPress={onDownloadPress}
      isOffline={isOffline}
      disabled={disabled}
      size={20}
      style={{ padding: 4 }}
    />
  );
};

/**
 * LargeDownloadControl - A larger version for prominent placement
 */
export const LargeDownloadControl = ({
  isDownloaded = false,
  isDownloading = false,
  downloadProgress = 0,
  onDownloadPress = null,
  isOffline = false,
  disabled = false,
}) => {
  return (
    <DownloadControl
      isDownloaded={isDownloaded}
      isDownloading={isDownloading}
      downloadProgress={downloadProgress}
      onDownloadPress={onDownloadPress}
      isOffline={isOffline}
      disabled={disabled}
      size={32}
      style={{ padding: 12 }}
    />
  );
};

// Import hook here to avoid circular dependencies if possible, or just require it
import { useDownloadSong } from '../../hooks/useDownloadSong';

/**
 * SmartDownloadControl - Wrapper that handles logic internally
 */
export const SmartDownloadControl = ({
  songData,
  isOffline = false,
  size = 28,
  iconColor,
}) => {
  const {
    isDownloaded,
    isDownloading,
    downloadProgress,
    startDownload,
    canDownload,
  } = useDownloadSong(songData, { isOffline });

  return (
    <DownloadControl
      isDownloaded={isDownloaded}
      isDownloading={isDownloading}
      downloadProgress={downloadProgress}
      onDownloadPress={startDownload}
      isOffline={isOffline}
      disabled={!canDownload}
      size={size}
      iconColor={iconColor}
    />
  );
};
