import React, { useState, useRef, useContext, memo } from 'react';
import {
  View,
  Pressable,
  StyleSheet,
  Dimensions,
  Modal,
  TouchableOpacity,
  Text,
  UIManager,
  findNodeHandle,
  ToastAndroid,
} from 'react-native';
import FastImage from 'react-native-fast-image';
import { PlainText } from '../Global/PlainText';
import { SmallText } from '../Global/SmallText';
import { useActiveTrack, usePlaybackState } from 'react-native-track-player';
import { useTheme } from '@react-navigation/native';
import TrackPlayer from 'react-native-track-player';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import Context from '../../Context/Context';
import { PlayOneSong } from '../../MusicPlayerFunctions';
import { StorageManager } from '../../Utils/StorageManager';
import { downloadSongNow } from '../../hooks/useDownloadSong';
import { AddOneSongToPlaylist } from '../../MusicPlayerFunctions';
import historyManager from '../../Utils/HistoryManager';
import { GlassBox } from '../Global/GlassBox';
import { BlurView } from '@react-native-community/blur';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export const HistoryCard = memo(function HistoryCard({
  historyItem,
  onRefresh,
}) {
  const { colors, dark } = useTheme();
  const styles = getThemedStyles(colors, dark);
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 20 });
  const [isDownloaded, setIsDownloaded] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const buttonRef = useRef(null);
  const { setIndex } = useContext(Context);

  // Get current track info
  const currentTrack = useActiveTrack();
  const playerState = usePlaybackState();
  const isCurrentlyPlaying = currentTrack?.id === historyItem.id;
  const isPlaying = isCurrentlyPlaying && playerState.state === 'playing';
  const isPaused = isCurrentlyPlaying && playerState.state !== 'playing';

  // Format text helper
  const formatText = (text) => {
    if (!text) {
      return 'Unknown';
    }
    return text.length > 30 ? text.substring(0, 30) + '...' : text;
  };

  // Format play count
  const formatPlayCount = (count) => {
    if (count === 1) {
      return '1 play';
    }
    return `${count} plays`;
  };

  // Format listen duration
  const formatListenDuration = (duration) => {
    return historyManager.formatDuration(duration);
  };

  // Get artwork URI
  const getArtworkUri = () => {
    if (historyItem.artwork) {
      return historyItem.artwork;
    }
    return 'https://htmlcolorcodes.com/assets/images/colors/gray-color-solid-background-1920x1080.png';
  };

  // Play song
  const playSong = async () => {
    try {
      // Check if this is a legacy history entry (empty URL and no videoId)
      // For these, we need to search YouTube Music by title/artist
      const isLegacyEntry =
        !historyItem.url &&
        !historyItem.videoId &&
        historyItem.sourceType === 'online';

      let songData;

      if (isLegacyEntry) {
        // Legacy entry without videoId - search YouTube Music first
        console.log(
          '🔍 History: Legacy entry, searching YTMusic for:',
          historyItem.title
        );
        try {
          const YouTubeMusicService =
            require('../../Utils/YouTubeMusicService').default;
          const ytResult = await YouTubeMusicService.searchAndStream(
            historyItem.title,
            historyItem.artist || ''
          );

          if (ytResult && ytResult.url && !ytResult.error) {
            // Successfully found on YouTube Music
            songData = {
              id: ytResult.videoId,
              title: historyItem.title,
              artist: historyItem.artist,
              artwork: historyItem.artwork,
              url: ytResult.url,
              headers: ytResult.headers,
              duration: historyItem.duration,
              sourceType: 'online',
              isLocal: false,
              source: 'ytmusic',
              videoId: ytResult.videoId,
              _prefetched: true,
            };
            console.log('✅ History: Found on YTMusic:', ytResult.videoId);
          } else {
            throw new Error('Could not find song on YouTube Music');
          }
        } catch (searchError) {
          console.error(
            '❌ History: YTMusic search failed:',
            searchError.message
          );
          ToastAndroid.show('Could not find song', ToastAndroid.SHORT);
          return;
        }
      } else {
        // Standard case - has URL or videoId
        const needsStreamFetch =
          !historyItem.url &&
          (historyItem.videoId ||
            historyItem.source === 'ytmusic' ||
            historyItem.source === 'spotify' ||
            historyItem.source === 'dab');

        songData = {
          // Use videoId as ID if available (for YTMusic playback), otherwise use original ID
          id: historyItem.videoId || historyItem.id,
          title: historyItem.title,
          artist: historyItem.artist,
          artwork: historyItem.artwork,
          url: historyItem.url || '', // Empty URL will trigger stream fetch
          duration: historyItem.duration,
          sourceType: historyItem.sourceType,
          isLocal: historyItem.isLocal,
          path: historyItem.path,
          // Include source info for proper stream fetching
          source: historyItem.videoId ? 'ytmusic' : historyItem.source,
          videoId: historyItem.videoId,
          spotifyId: historyItem.spotifyId,
          // Flag to trigger stream fetch if URL is empty
          _needsStream: needsStreamFetch,
          // Mark if this was mapped from Spotify
          mappedFromSpotify: !!historyItem.spotifyId,
        };
      }

      await PlayOneSong(songData);
      setIndex(1); // Open full screen player
    } catch (error) {
      console.error('Error playing song from history:', error);
      ToastAndroid.show('Error playing song', ToastAndroid.SHORT);
    }
  };

  // Show menu
  const showMenu = () => {
    if (buttonRef.current) {
      const handle = findNodeHandle(buttonRef.current);
      if (handle) {
        UIManager.measure(handle, (x, y, width, height, pageX, pageY) => {
          setMenuPosition({
            top: pageY + height,
            right: SCREEN_WIDTH - pageX - width,
          });
          setMenuVisible(true);
        });
      }
    }
  };

  // Play next
  const playNext = async () => {
    try {
      const songData = {
        id: historyItem.id,
        title: historyItem.title,
        artist: historyItem.artist,
        artwork: historyItem.artwork,
        url: historyItem.url,
        duration: historyItem.duration,
      };

      const queue = await TrackPlayer.getQueue();
      const currentIndex = await TrackPlayer.getCurrentTrack();

      if (currentIndex === null || queue.length === 0) {
        await TrackPlayer.reset();
        await TrackPlayer.add([songData]);
        await TrackPlayer.play();
      } else {
        await TrackPlayer.add(songData, currentIndex + 1);
      }

      setMenuVisible(false);
      ToastAndroid.show('Added to play next', ToastAndroid.SHORT);
    } catch (error) {
      console.error('Error adding to play next:', error);
      ToastAndroid.show('Error adding to queue', ToastAndroid.SHORT);
    }
  };

  // Add to playlist
  const addToPlaylist = () => {
    try {
      const songData = {
        id: historyItem.id,
        title: historyItem.title,
        artist: historyItem.artist,
        artwork: historyItem.artwork,
        url: historyItem.url,
        duration: historyItem.duration,
      };

      AddOneSongToPlaylist(songData);
      setMenuVisible(false);
    } catch (error) {
      console.error('Error adding to playlist:', error);
      ToastAndroid.show('Error adding to playlist', ToastAndroid.SHORT);
    }
  };

  // Download song (only for online songs)
  const downloadSong = async () => {
    if (!historyItem?.id) {
      ToastAndroid.show('Invalid song data', ToastAndroid.SHORT);
      return;
    }

    try {
      // Check if already downloaded or downloading
      if (isDownloaded) {
        ToastAndroid.show('Song already downloaded', ToastAndroid.SHORT);
        return;
      }

      if (isDownloading) {
        ToastAndroid.show(
          `Download in progress: ${downloadProgress}%`,
          ToastAndroid.SHORT
        );
        return;
      }

      setIsDownloading(true);
      setDownloadProgress(0);
      setMenuVisible(false);

      // Shared helper detects the real source instead of assuming Saavn, and
      // reports its own success/failure toast.
      const success = await downloadSongNow(historyItem, (progress) => {
        setDownloadProgress(progress);
      });

      if (success) {
        setIsDownloaded(true);
        setDownloadProgress(100);
      }
    } catch (error) {
      console.error('Download failed:', error);
      ToastAndroid.show(`Download failed: ${error.message}`, ToastAndroid.LONG);
    } finally {
      setIsDownloading(false);
    }
  };

  // Check if song is downloaded
  React.useEffect(() => {
    const checkDownloadStatus = async () => {
      if (historyItem.sourceType === 'online') {
        const downloaded = await StorageManager.isSongDownloaded(
          historyItem.id
        );
        setIsDownloaded(downloaded);
      }
    };
    checkDownloadStatus();
  }, [historyItem.id, historyItem.sourceType]);

  return (
    <Pressable
      onPress={playSong}
      android_ripple={{
        color: dark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.05)',
        borderless: false,
      }}
      style={styles.container}
    >
      <View style={styles.pressableContent}>
        <FastImage
          source={
            isPlaying
              ? require('../../Images/playing.gif')
              : isPaused
              ? require('../../Images/songPaused.gif')
              : { uri: getArtworkUri() }
          }
          style={styles.artwork}
          resizeMode={FastImage.resizeMode.cover}
        />

        <View style={styles.textContainer}>
          <PlainText
            text={formatText(historyItem.title)}
            style={{
              color: isCurrentlyPlaying ? '#1ED760' : colors.text,
              fontSize: 15,
              fontWeight: isCurrentlyPlaying ? '600' : '500',
              marginBottom: 2,
            }}
          />
          <SmallText
            text={formatText(historyItem.artist)}
            style={[styles.artist, { color: colors.textSecondary }]}
          />
        </View>
      </View>

      <Pressable
        ref={buttonRef}
        onPress={(e) => {
          e.stopPropagation();
          showMenu();
        }}
      >
        <GlassBox
          id={`history-menu-${historyItem.id || Math.random()}`}
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            justifyContent: 'center',
            alignItems: 'center',
            marginLeft: 4,
          }}
          gradientConfig={{
            x1: '0%', y1: '0%', x2: '100%', y2: '100%',
            stops: [
              { offset: '0%', opacity: 0.3 },
              { offset: '50%', opacity: 0.0 },
              { offset: '100%', opacity: 0.3 },
            ],
          }}
        >
          <MaterialCommunityIcons
            name="dots-vertical"
            size={22}
            color={colors.text}
          />
        </GlassBox>
      </Pressable>

      {/* Menu Modal */}
      <Modal
        visible={menuVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setMenuVisible(false)}
        >
          <GlassBox
            id={`history-menu-popup-${historyItem.id || 'default'}`}
            style={[
              styles.menuContainer,
              {
                top: menuPosition.top,
                right: menuPosition.right,
                backgroundColor: 'transparent',
                borderWidth: 0,
              },
            ]}
            gradientConfig={{
              x1: '0%', y1: '0%', x2: '100%', y2: '100%',
              stops: [
                { offset: '0%', opacity: 0.6 },
                { offset: '40%', opacity: 0.0 },
                { offset: '60%', opacity: 0.0 },
                { offset: '100%', opacity: 0.6 },
              ],
            }}
          >
            <BlurView
              style={StyleSheet.absoluteFill}
              blurType={dark ? 'dark' : 'light'}
              blurAmount={8}
              reducedTransparencyFallbackColor={colors.card}
            />
            
            <TouchableOpacity style={styles.menuItem} onPress={playNext}>
              <MaterialIcons name="queue-music" size={20} color={colors.text} />
              <Text style={[styles.menuText, { color: colors.text }]}>
                Play Next
              </Text>
            </TouchableOpacity>

            <View style={{ height: 1, backgroundColor: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)', marginHorizontal: 8 }} />

            <TouchableOpacity style={styles.menuItem} onPress={addToPlaylist}>
              <MaterialIcons
                name="playlist-add"
                size={20}
                color={colors.text}
              />
              <Text style={[styles.menuText, { color: colors.text }]}>
                Add to Playlist
              </Text>
            </TouchableOpacity>

            {historyItem.sourceType === 'online' && !isDownloaded && (
              <>
                <View style={{ height: 1, backgroundColor: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)', marginHorizontal: 8 }} />
                <TouchableOpacity style={styles.menuItem} onPress={downloadSong}>
                  <MaterialIcons name="download" size={20} color={colors.text} />
                  <Text style={[styles.menuText, { color: colors.text }]}>
                    {isDownloading
                      ? `Downloading ${downloadProgress}%`
                      : 'Download'}
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </GlassBox>
        </TouchableOpacity>
      </Modal>
    </Pressable>
  );
});

const getThemedStyles = (colors, dark) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 6,
      paddingHorizontal: 10,
      marginHorizontal: 10,
      marginVertical: 2,
      borderRadius: 8,
      backgroundColor: colors.background,
    },
    pressableContent: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 6,
      paddingLeft: 4,
    },
    artwork: {
      width: 50,
      height: 50,
      borderRadius: 8,
      marginRight: 12,
    },
    textContainer: {
      flex: 1,
      justifyContent: 'center',
    },
    artist: {
      fontSize: 13,
      marginBottom: 4,
    },
    statsContainer: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    stats: {
      fontSize: 11,
    },
    menuButton: {
      padding: 8,
      borderRadius: 16,
      marginLeft: 4,
    },
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
    },
    menuContainer: {
      position: 'absolute',
      borderRadius: 8,
      borderWidth: 1,
      elevation: 8,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.25,
      shadowRadius: 4,
      minWidth: 150,
    },
    menuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    menuText: {
      marginLeft: 12,
      fontSize: 14,
      fontWeight: '500',
    },
  });
