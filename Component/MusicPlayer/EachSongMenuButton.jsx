import {
  Pressable,
  findNodeHandle,
  UIManager,
  View,
  Modal,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  ToastAndroid,
} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import Octicons from 'react-native-vector-icons/Octicons';
import React, { useRef, useState, useContext } from 'react';
import { useTheme } from '@react-navigation/native';
import Context from '../../Context/Context';
import { AddOneSongToPlaylist } from '../../MusicPlayerFunctions';
import PlaylistSelectorWrapper from '../Playlist/PlaylistSelectorWrapper';
import { GlassBox } from '../Global/GlassBox';
import { BlurView } from '@react-native-community/blur';
import { useSongPlayback } from './hooks/useSongPlayback';
import { useDownloadSong } from '../../hooks/useDownloadSong';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

export const EachSongMenuButton = ({
  song,
  marginRight = 10,
  isFromAlbum = false,
  isFromPlaylist = false,
  isDownloaded: propIsDownloaded = null,
  onDelete,
}) => {
  const { dark, colors } = useTheme();
  const buttonRef = useRef(null);
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 20 });
  const { updateTrack } = useContext(Context);
  const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);

  const closeMenu = () => {
    setMenuVisible(false);
  };

  const { addToQueue, playNext } = useSongPlayback(song, updateTrack, closeMenu);

  const {
    isDownloaded,
    downloadSong,
    deleteSong
  } = useDownloadSong(song, {
    isDownloaded: propIsDownloaded,
    onDelete,
    closeMenu,
  });

  const getMarginRight = () => {
    if (isFromAlbum) {
      return 0;
    }
    if (isFromPlaylist) {
      return 5;
    }
    return marginRight;
  };

  const handlePress = () => {
    if (buttonRef.current) {
      const handle = findNodeHandle(buttonRef.current);
      UIManager.measure(handle, (x, y, width, height, pageX, pageY) => {
        const menuHeight = 180;
        const spaceBelow = SCREEN_HEIGHT - pageY - height;

        if (spaceBelow < menuHeight) {
          setMenuPosition({
            top: Math.max(pageY - menuHeight, 50),
            right: 20,
          });
        } else {
          setMenuPosition({
            top: pageY + height * 1.5,
            right: 20,
          });
        }

        setMenuVisible(true);
      });
    }
  };



  const addToPlaylist = async () => {
    closeMenu();
    if (!song?.id) {
      ToastAndroid.show('Song information not available', ToastAndroid.SHORT);
      return;
    }

    try {
      // Call the function to add song to playlist
      const result = await AddOneSongToPlaylist(song);
      if (!result) {
        ToastAndroid.show(
          'Failed to open playlist selector',
          ToastAndroid.SHORT
        );
      }
    } catch (error) {
      console.error('Error adding to playlist:', error);
      ToastAndroid.show('Failed to add to playlist', ToastAndroid.SHORT);
    }
  };

  const renderMenu = () => (
    <Modal
      transparent
      visible={menuVisible}
      onRequestClose={closeMenu}
      animationType="fade"
    >
      <Pressable style={styles.modalOverlay} onPress={closeMenu}>
        <GlassBox
          id={`dropdown-menu-container-${song?.id || Math.random()}`}
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
              { offset: '0%', opacity: 0.0 },
              { offset: '40%', opacity: 0.6 },
              { offset: '60%', opacity: 0.6 },
              { offset: '100%', opacity: 0.0 },
            ],
          }}
        >
          <BlurView
            style={StyleSheet.absoluteFill}
            blurType={dark ? 'dark' : 'light'}
            blurAmount={8}
            reducedTransparencyFallbackColor={colors.card}
          />
          <TouchableOpacity style={styles.menuItem} onPress={addToQueue}>
            <MaterialCommunityIcons
              name="playlist-plus"
              size={24}
              color={colors.text}
            />
            <Text style={[styles.menuText, { color: colors.text }]}>
              Add to queue
            </Text>
          </TouchableOpacity>
          <View style={{ height: 1, backgroundColor: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)', marginHorizontal: 8 }} />

          <TouchableOpacity style={styles.menuItem} onPress={playNext}>
            <MaterialCommunityIcons
              name="play-speed"
              size={24}
              color={colors.text}
            />
            <Text style={[styles.menuText, { color: colors.text }]}>
              Play next
            </Text>
          </TouchableOpacity>
          <View style={{ height: 1, backgroundColor: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)', marginHorizontal: 8 }} />

          <TouchableOpacity style={styles.menuItem} onPress={addToPlaylist}>
            <MaterialCommunityIcons
              name="playlist-music"
              size={24}
              color={colors.text}
            />
            <Text style={[styles.menuText, { color: colors.text }]}>
              Add to playlist
            </Text>
          </TouchableOpacity>
          <View style={{ height: 1, backgroundColor: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)', marginHorizontal: 8 }} />

          {!isDownloaded && (
            <TouchableOpacity style={styles.menuItem} onPress={downloadSong}>
              <Octicons name="download" size={24} color={colors.text} />
              <Text style={[styles.menuText, { color: colors.text }]}>
                Download
              </Text>
            </TouchableOpacity>
          )}

          {isDownloaded && (
            <TouchableOpacity style={styles.menuItem} onPress={deleteSong}>
              <MaterialCommunityIcons
                name="delete-outline"
                size={24}
                color={colors.text}
              />
              <Text style={[styles.menuText, { color: colors.text }]}>
                Delete
              </Text>
            </TouchableOpacity>
          )}
        </GlassBox>
      </Pressable>
    </Modal>
  );

  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {/* Three dots menu button */}
        <Pressable
          ref={buttonRef}
          onPress={handlePress}
          style={{
            marginRight: getMarginRight(),
          }}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <GlassBox
            id={`menu-${song?.id || 'unknown'}`}
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              justifyContent: 'center',
              alignItems: 'center',
            }}
            gradientConfig={{
              x1: '0%', y1: '0%', x2: '100%', y2: '100%',
              stops: [
                { offset: '0%', opacity: 0.0 },
                { offset: '40%', opacity: 0.5 },
                { offset: '60%', opacity: 0.5 },
                { offset: '100%', opacity: 0.0 },
              ],
            }}
          >
            <MaterialCommunityIcons
              name="dots-vertical"
              size={20}
              color={colors.text}
            />
          </GlassBox>
        </Pressable>
      </View>

      {/* Show playlist selector if needed */}
      {showPlaylistSelector && (
        <PlaylistSelectorWrapper
          songToAdd={song}
          onClose={() => setShowPlaylistSelector(false)}
        />
      )}

      {renderMenu()}
    </>
  );
};

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  menuContainer: {
    position: 'absolute',
    right: 20,
    borderRadius: 8,
    padding: 8,
    minWidth: 180,
    elevation: 5,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
  },
  menuText: {
    marginLeft: 10,
    fontSize: 14,
  },
});
