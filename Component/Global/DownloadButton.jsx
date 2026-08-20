import { View, TouchableOpacity, ToastAndroid, StyleSheet, Alert } from 'react-native';
import AntDesign from 'react-native-vector-icons/AntDesign';
import { useState, useEffect } from 'react';
import { useTheme } from '@react-navigation/native';
import { SmallText } from './SmallText';
import { PermissionsAndroid, Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import { StorageManager } from '../../Utils/StorageManager';
import { downloadSongNow } from '../../hooks/useDownloadSong';

// Circular progress component for download indicator
const CircularProgress = ({
  progress,
  size = 20,
  thickness = 2,
  color = '#1DB954',
}) => {
  return (
    <View
      style={{
        width: size,
        height: size,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      {/* Background circle */}
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: 'rgba(0,0,0,0.5)',
          justifyContent: 'center',
          alignItems: 'center',
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.2)',
        }}
      >
        {/* Filled portion based on progress */}
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: `${progress}%`,
            backgroundColor: color,
          }}
        />

        {/* Percentage text */}
        <SmallText
          text={`${Math.round(progress)}%`}
          style={{
            fontSize: size <= 30 ? 8 : 12,
            color: 'white',
            fontWeight: 'bold',
            textShadowColor: 'rgba(0,0,0,0.75)',
            textShadowOffset: { width: 0, height: 1 },
            textShadowRadius: 2,
          }}
        />
      </View>
    </View>
  );
};

export const DownloadButton = ({
  songs = [],
  albumName = '',
  size = 'normal',
  individual = false,
  songId = null,
}) => {
  const { colors } = useTheme();
  const [downloadStatus, setDownloadStatus] = useState({});
  const [isDownloading, setIsDownloading] = useState(false);
  const [overallProgress, setOverallProgress] = useState(0);

  // Determine button size based on prop
  const buttonSize = size === 'large' ? 48 : size === 'small' ? 36 : 44;
  const iconSize = size === 'large' ? 26 : size === 'small' ? 18 : 22;
  const progressSize = size === 'large' ? 34 : size === 'small' ? 26 : 30;

  // Check download status on mount
  useEffect(() => {
    const checkDownloadedItems = async () => {
      if (individual && songId) {
        // For individual song
        const isDownloaded = await StorageManager.isSongDownloaded(songId);
        setDownloadStatus({
          [songId]: {
            isDownloaded,
            progress: isDownloaded ? 100 : 0,
            isDownloading: false,
          },
        });
        setOverallProgress(isDownloaded ? 100 : 0);
      } else if (songs && songs.length > 0) {
        // For album/playlist
        const songStatuses = {};
        let downloadedCount = 0;

        // Check each song's download status
        for (const song of songs) {
          if (!song || !song.id) {
            continue;
          }

          const isDownloaded = await StorageManager.isSongDownloaded(song.id);
          songStatuses[song.id] = {
            isDownloaded,
            progress: isDownloaded ? 100 : 0,
            isDownloading: false,
          };

          if (isDownloaded) {
            downloadedCount++;
          }
        }

        setDownloadStatus(songStatuses);

        // If all songs are downloaded, set overall progress to 100%
        if (downloadedCount === songs.length) {
          setOverallProgress(100);
        } else {
          setOverallProgress(
            Math.floor((downloadedCount / songs.length) * 100)
          );
        }
      }
    };

    checkDownloadedItems();
  }, [songs, individual, songId]);

  // Get storage permissions (for Android)
  const getPermission = async () => {
    try {
      if (Platform.OS === 'ios') {
        handleDownload();
        return;
      }

      const deviceVersion = DeviceInfo.getSystemVersion();

      if (parseInt(deviceVersion) >= 13) {
        handleDownload();
      } else {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
          {
            title: 'Storage Permission',
            message:
              'Orbit needs storage access to save music for offline playback',
            buttonPositive: 'Allow',
            buttonNegative: 'Cancel',
          }
        );

        if (granted === PermissionsAndroid.RESULTS.GRANTED) {
          handleDownload();
        } else {
          Alert.alert(
            'Permission Denied',
            'Storage permission is required to download songs. Please enable it in app settings.'
          );
        }
      }
    } catch (error) {
      console.error('Error requesting permissions:', error);
      Alert.alert('Error', 'Could not request storage permissions');
    }
  };

  // Handle download logic
  const handleDownload = async () => {
    if (isDownloading) {
      ToastAndroid.show('Download already in progress', ToastAndroid.SHORT);
      return;
    }

    try {
      // For individual songs
      if (individual && songId) {
        const song = songs.find((s) => s.id === songId);
        if (!song) {
          ToastAndroid.show('Invalid song data', ToastAndroid.SHORT);
          return;
        }

        // Check if already downloaded
        const isDownloaded = await StorageManager.isSongDownloaded(songId);
        if (isDownloaded) {
          ToastAndroid.show('Song already downloaded', ToastAndroid.SHORT);
          return;
        }

        setIsDownloading(true);
        const success = await downloadSongNow(song, null, {
          album: albumName,
        });

        if (success) {
          setDownloadStatus((prev) => ({
            ...prev,
            [songId]: {
              isDownloaded: true,
              progress: 100,
              isDownloading: false,
            },
          }));
          ToastAndroid.show('Download completed', ToastAndroid.SHORT);
        }
        setIsDownloading(false);
        return;
      }

      // For albums/playlists
      // Check if all songs are already downloaded
      const allDownloaded = Object.values(downloadStatus).every(
        (status) => status.isDownloaded
      );
      if (allDownloaded) {
        ToastAndroid.show('All songs already downloaded', ToastAndroid.SHORT);
        return;
      }

      setIsDownloading(true);
      const songsToDownload = songs.filter(
        (song) => !downloadStatus[song.id]?.isDownloaded
      );

      if (songsToDownload.length === 0) {
        ToastAndroid.show('All songs already downloaded', ToastAndroid.SHORT);
        setIsDownloading(false);
        return;
      }

      ToastAndroid.show(
        `Downloading ${songsToDownload.length} songs`,
        ToastAndroid.SHORT
      );

      let successCount = 0;
      for (let i = 0; i < songsToDownload.length; i++) {
        const song = songsToDownload[i];
        setOverallProgress(Math.floor((i / songsToDownload.length) * 100));

        try {
          const success = await downloadSongNow(song, null, {
            album: albumName,
          });

          if (success) {
            successCount++;
            setDownloadStatus((prev) => ({
              ...prev,
              [song.id]: {
                isDownloaded: true,
                progress: 100,
                isDownloading: false,
              },
            }));
          }
        } catch (error) {
          console.error(`Error downloading ${song.title || song.name}:`, error);
        }
      }

      if (successCount > 0) {
        ToastAndroid.show(
          `Downloaded ${successCount} song${successCount > 1 ? 's' : ''}`,
          ToastAndroid.SHORT
        );
      }
    } catch (error) {
      console.error('Download error:', error);
      ToastAndroid.show('Download failed', ToastAndroid.SHORT);
    } finally {
      setIsDownloading(false);
      setOverallProgress(100);
    }
  };

  // Render the appropriate button based on state
  const renderButton = () => {
    if (isDownloading) {
      return (
        <View
          style={{
            width: buttonSize,
            height: buttonSize,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <CircularProgress
            progress={overallProgress}
            size={progressSize}
            thickness={2}
          />
        </View>
      );
    }

    // If individual song
    if (individual && songId) {
      const isDownloaded = downloadStatus[songId]?.isDownloaded;

      if (isDownloaded) {
        return <AntDesign name="checkcircle" size={iconSize} color="#4CAF50" />;
      }

      return <AntDesign name="download" size={iconSize} color="#FFFFFF" />;
    }

    // For albums/playlists
    const allDownloaded =
      songs.length > 0 &&
      Object.keys(downloadStatus).length > 0 &&
      Object.values(downloadStatus).every((status) => status.isDownloaded);

    if (allDownloaded) {
      return <AntDesign name="checkcircle" size={iconSize} color="#4CAF50" />;
    }

    return <AntDesign name="download" size={iconSize} color="#FFFFFF" />;
  };

  return (
    <TouchableOpacity
      style={[
        styles.container,
        { width: buttonSize, height: buttonSize },
        size === 'small' ? styles.smallContainer : null,
      ]}
      onPress={!isDownloading ? getPermission : undefined}
      disabled={isDownloading}
      activeOpacity={0.7}
    >
      {renderButton()}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 50,
    alignItems: 'center',
    justifyContent: 'center',
    margin: 3,
  },
  smallContainer: {
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
});
