import Modal from 'react-native-modal';
import {
  Dimensions,
  PermissionsAndroid,
  Platform,
  Pressable,
  ToastAndroid,
  View,
} from 'react-native';
import { PlainText } from './PlainText';
import React, { useContext } from 'react';
import { useTheme } from '@react-navigation/native';
import FormatTitleAndArtist from '../../Utils/FormatTitleAndArtist';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import DeviceInfo from 'react-native-device-info';
import { AddSongsToQueue, getIndexQuality } from '../../MusicPlayerFunctions';
import { downloadSongNow } from '../../hooks/useDownloadSong';
import Context from '../../Context/Context';
import TrackPlayer from 'react-native-track-player';
import {
  GetCustomPlaylists,
  AddSongToCustomPlaylist,
} from '../../LocalStorage/CustomPlaylists';
import {
  GetLocalMusicFavorites,
  AddLocalMusicToFavorites,
  RemoveLocalMusicFromFavorites,
  IsLocalMusicFavorite,
} from '../../LocalStorage/StoreLocalMusic';
import {
  enhanceYTMusicArtwork,
  getPrimaryArtworkUrl,
} from '../../Utils/ArtworkEnhancer';
import { useState } from 'react';
import { ScrollView, TextInput } from 'react-native';
import { CreateCustomPlaylist } from '../../LocalStorage/CustomPlaylists';
import FastImage from 'react-native-fast-image';

const styles = {
  emptyState: {
    alignItems: 'center',
    padding: 20,
  },
  emptyStateImage: {
    width: 100,
    height: 100,
    opacity: 0.5,
  },
  playlistItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  playlistImage: {
    width: 50,
    height: 50,
    borderRadius: 4,
  },
  playlistInfo: {
    marginLeft: 15,
    flex: 1,
  },
  playlistName: {
    fontSize: 16,
    fontWeight: '500',
  },
  songCount: {
    color: 'gray',
    fontSize: 12,
    marginTop: 4,
  },
};

// Helper function to safely get the song URL
const getSongUrl = (urlData, quality = 4) => {
  try {
    // Check if urlData is an array with at least quality+1 elements
    if (Array.isArray(urlData) && urlData.length > quality) {
      return urlData[quality].url;
    }

    // Check if urlData is an object with a downloadUrl property
    if (
      urlData &&
      urlData.downloadUrl &&
      Array.isArray(urlData.downloadUrl) &&
      urlData.downloadUrl.length > quality
    ) {
      return urlData.downloadUrl[quality].url;
    }

    // Check if urlData is a string directly
    if (typeof urlData === 'string') {
      return urlData;
    }

    // Handle local music path
    if (urlData && urlData.path) {
      return urlData.path;
    }

    return null;
  } catch (error) {
    console.error('Error getting song URL:', error);
    return null;
  }
};

// Helper function to get highest quality artwork
// Helper function to get highest quality artwork
const getHighestQualityArtwork = (imageData) => {
  let artworkUrl = '';

  if (!imageData) {
    return '';
  }

  if (typeof imageData === 'string') {
    artworkUrl = imageData;
  } else if (Array.isArray(imageData) && imageData.length > 0) {
    // If array of objects, try to find highest quality or take last
    if (typeof imageData[0] === 'object') {
      const maxRes = imageData.find(
        (img) => img.quality === 'max' || img.quality === 'hd'
      );
      if (maxRes && maxRes.url) {
        artworkUrl = maxRes.url;
      } else {
        for (let i = imageData.length - 1; i >= 0; i--) {
          const img = imageData[i];
          if (img && (img.url || img.link)) {
            artworkUrl = img.url || img.link;
            break;
          }
        }
      }
    } else if (typeof imageData[0] === 'string') {
      const lastValid = imageData
        .filter((i) => i && typeof i === 'string' && i.trim() !== '')
        .pop();
      artworkUrl = lastValid || '';
    }
  } else if (typeof imageData === 'object') {
    artworkUrl = imageData.url || imageData.link || imageData.uri || '';
  }

  // Final enhancement pass
  if (artworkUrl && typeof artworkUrl === 'string') {
    const enhanced = enhanceYTMusicArtwork(artworkUrl, 'card');
    return getPrimaryArtworkUrl(enhanced) || artworkUrl;
  }

  return artworkUrl || '';
};

export const EachSongMenuModal = ({ Visible, setVisible }) => {
  const { colors } = useTheme();
  const { updateTrack } = useContext(Context);
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [availablePlaylists, setAvailablePlaylists] = useState({});
  const [isFavorite, setIsFavorite] = useState(false);

  // Check if the song is a local music file
  const isLocalMusic = Visible?.isLocalMusic === true;

  // Check if the song is a favorite when the modal opens
  React.useEffect(() => {
    if (Visible?.visible && Visible?.id) {
      const checkFavoriteStatus = async () => {
        if (isLocalMusic) {
          const isFav = await IsLocalMusicFavorite(Visible.id);
          setIsFavorite(isFav);
        }
      };
      checkFavoriteStatus();
    }
  }, [Visible?.visible, Visible?.id, isLocalMusic]);

  async function actualDownload() {
    try {
      // Shared normalisation detects the real source (ytmusic / dab / spotify /
      // saavn) from the song data. This used to hardcode a 'saavn' fallback,
      // which sent YouTube and DAB tracks down the wrong download path.
      // downloadSongNow reports its own success/failure toast.
      await downloadSongNow({
        ...Visible,
        downloadUrl: Visible?.downloadUrl || Visible?.url,
      });

      setVisible({ visible: false });
    } catch (error) {
      console.error('Download error:', error);
      ToastAndroid.showWithGravity(
        `Download failed: ${error.message}`,
        ToastAndroid.SHORT,
        ToastAndroid.CENTER
      );
    }
  }

  async function playNext() {
    try {
      let song;

      if (isLocalMusic) {
        // Format local music for player
        song = {
          url: Visible?.path,
          title: FormatTitleAndArtist(Visible?.title),
          artist: FormatTitleAndArtist(Visible?.artist),
          artwork:
            Visible?.cover ||
            'https://htmlcolorcodes.com/assets/images/colors/gray-color-solid-background-1920x1080.png',
          duration: Visible?.duration,
          id: Visible?.id,
          isLocalMusic: true,
        };
      } else {
        // Format online music for player
        const quality = await getIndexQuality();

        // Get the song URL safely
        const songUrl = getSongUrl(Visible.url, quality);

        if (!songUrl) {
          console.error('Invalid song URL structure:', Visible.url);
          ToastAndroid.showWithGravity(
            'Cannot play: Invalid URL',
            ToastAndroid.SHORT,
            ToastAndroid.CENTER
          );
          return;
        }

        const artworkUrl = getHighestQualityArtwork(Visible.image);

        song = {
          url: songUrl,
          title: FormatTitleAndArtist(Visible?.title),
          artist: FormatTitleAndArtist(Visible?.artist),
          artwork: artworkUrl,
          duration: Visible?.duration,
          id: Visible?.id,
          language: Visible?.language,
          image: artworkUrl,
          downloadUrl: Visible?.url,
          // Preserve additional metadata
          year: Visible?.year,
          playCount: Visible?.playCount,
          label: Visible?.label,
          copyright: Visible?.copyright,
          hasLyrics: Visible?.hasLyrics,
          album: Visible?.album,
          artists: Visible?.artists,
          releaseDate: Visible?.releaseDate,
          explicitContent: Visible?.explicitContent,
        };
      }

      const queue = await TrackPlayer.getQueue();
      const currentIndex = await TrackPlayer.getCurrentTrack();

      // If no track is playing, add to beginning and play
      if (currentIndex === null || queue.length === 0) {
        await TrackPlayer.add(song);
        await TrackPlayer.play();
      } else {
        await TrackPlayer.add(song, currentIndex + 1);
      }

      updateTrack();
      setVisible({ visible: false });
      ToastAndroid.showWithGravity(
        'Song Will Play Next',
        ToastAndroid.SHORT,
        ToastAndroid.CENTER
      );
    } catch (error) {
      console.error('Play next error:', error);
      ToastAndroid.showWithGravity(
        `Unable to add song: ${error.message}`,
        ToastAndroid.SHORT,
        ToastAndroid.CENTER
      );
    }
  }

  const getPermission = async () => {
    if (Platform.OS === 'ios') {
      actualDownload();
    } else {
      try {
        let deviceVersion = DeviceInfo.getSystemVersion();
        let granted = PermissionsAndroid.RESULTS.DENIED;
        if (deviceVersion >= 13) {
          granted = PermissionsAndroid.RESULTS.GRANTED;
        } else {
          granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE
          );
        }
        if (granted === PermissionsAndroid.RESULTS.GRANTED) {
          actualDownload();
        } else {
          ToastAndroid.showWithGravity(
            'Storage permission required for download',
            ToastAndroid.SHORT,
            ToastAndroid.CENTER
          );
        }
      } catch (err) {
        console.error('Permission error:', err);
        ToastAndroid.showWithGravity(
          'Error requesting permission',
          ToastAndroid.SHORT,
          ToastAndroid.CENTER
        );
      }
    }
  };

  // Function to handle adding/removing local music from favorites
  async function toggleLocalMusicFavorite() {
    try {
      const isCurrentlyFavorite = await IsLocalMusicFavorite(Visible.id);

      if (isCurrentlyFavorite) {
        await RemoveLocalMusicFromFavorites(Visible.id);
        ToastAndroid.showWithGravity(
          'Removed from favorites',
          ToastAndroid.SHORT,
          ToastAndroid.CENTER
        );
      } else {
        const song = {
          id: Visible.id,
          title: Visible.title,
          artist: Visible.artist,
          path: Visible.path,
          duration: Visible.duration,
          cover:
            Visible.cover ||
            'https://htmlcolorcodes.com/assets/images/colors/gray-color-solid-background-1920x1080.png',
          isLocalMusic: true,
        };
        await AddLocalMusicToFavorites(song);
        ToastAndroid.showWithGravity(
          'Added to favorites',
          ToastAndroid.SHORT,
          ToastAndroid.CENTER
        );
      }

      setIsFavorite(!isCurrentlyFavorite);
      setVisible({ visible: false });
    } catch (error) {
      console.error('Error toggling favorite status:', error);
      ToastAndroid.showWithGravity(
        'Failed to update favorites',
        ToastAndroid.SHORT,
        ToastAndroid.CENTER
      );
    }
  }

  async function addSongToQueue() {
    try {
      let song;

      if (isLocalMusic) {
        // Format local music for queue
        song = {
          url: Visible?.path,
          title: FormatTitleAndArtist(Visible?.title),
          artist: FormatTitleAndArtist(Visible?.artist),
          artwork:
            Visible?.cover ||
            'https://htmlcolorcodes.com/assets/images/colors/gray-color-solid-background-1920x1080.png',
          duration: Visible?.duration,
          id: Visible?.id,
          isLocalMusic: true,
        };
      } else {
        // Format online music for queue
        const quality = await getIndexQuality();

        // Get the song URL safely
        const songUrl = getSongUrl(Visible?.url, quality);

        if (!songUrl) {
          console.error('Invalid song URL structure for queue:', Visible?.url);
          ToastAndroid.showWithGravity(
            'Cannot add to queue: Invalid URL',
            ToastAndroid.SHORT,
            ToastAndroid.CENTER
          );
          return;
        }

        song = {
          url: songUrl,
          title: FormatTitleAndArtist(Visible?.title),
          artist: FormatTitleAndArtist(Visible?.artist),
          artwork: getHighestQualityArtwork(Visible?.image),
          duration: Visible?.duration,
          id: Visible?.id,
          language: Visible?.language,
          image: getHighestQualityArtwork(Visible?.image),
          downloadUrl: Visible?.url,
        };
      }

      await AddSongsToQueue([song]);
      updateTrack();
      setVisible({ visible: false });
      ToastAndroid.showWithGravity(
        'Added to Queue',
        ToastAndroid.SHORT,
        ToastAndroid.CENTER
      );
    } catch (error) {
      console.error('Add to queue error:', error);
      ToastAndroid.showWithGravity(
        `Error adding to queue: ${error.message}`,
        ToastAndroid.SHORT,
        ToastAndroid.CENTER
      );
    }
  }
  const size = Dimensions.get('window').height;
  // Add this function alongside other functions like playNext, addSongToQueue, etc.
  async function handleAddToPlaylist() {
    const playlists = await GetCustomPlaylists();
    setAvailablePlaylists(playlists);
    setShowPlaylistModal(true);
  }
  async function addSongToSelectedPlaylist(playlistName) {
    try {
      let song;

      if (isLocalMusic) {
        // Format local music for playlist
        song = {
          url: Visible.path,
          title: FormatTitleAndArtist(Visible.title),
          artist: FormatTitleAndArtist(Visible.artist),
          artwork:
            Visible.cover ||
            'https://htmlcolorcodes.com/assets/images/colors/gray-color-solid-background-1920x1080.png',
          duration: Visible.duration,
          id: Visible.id,
          isLocalMusic: true,
        };
      } else {
        // Format online music for playlist
        const quality = await getIndexQuality();

        // Get the song URL safely
        const songUrl = getSongUrl(Visible.url, quality);

        if (!songUrl) {
          console.error(
            'Invalid song URL structure for playlist:',
            Visible.url
          );
          ToastAndroid.showWithGravity(
            'Cannot add to playlist: Invalid URL',
            ToastAndroid.SHORT,
            ToastAndroid.CENTER
          );
          return;
        }

        const artworkUrl = getHighestQualityArtwork(Visible.image);

        song = {
          url: songUrl,
          title: FormatTitleAndArtist(Visible.title),
          artist: FormatTitleAndArtist(Visible.artist),
          artwork: artworkUrl,
          duration: Visible.duration,
          id: Visible.id,
          language: Visible.language,
          image: artworkUrl,
          downloadUrl: Visible.url,
          // Preserve additional metadata
          year: Visible.year,
          playCount: Visible.playCount,
          label: Visible.label,
          copyright: Visible.copyright,
          hasLyrics: Visible.hasLyrics,
          album: Visible.album,
          artists: Visible.artists,
          releaseDate: Visible.releaseDate,
          explicitContent: Visible.explicitContent,
        };
      }

      const playlists = await GetCustomPlaylists();
      const playlist = playlists[playlistName] || [];

      if (playlist.some((track) => track.id === song.id)) {
        ToastAndroid.showWithGravity(
          'Song already exists in this playlist',
          ToastAndroid.SHORT,
          ToastAndroid.CENTER
        );
        return;
      }

      await AddSongToCustomPlaylist(playlistName, song);
      ToastAndroid.showWithGravity(
        'Song added to ' + playlistName,
        ToastAndroid.SHORT,
        ToastAndroid.CENTER
      );
      setShowPlaylistModal(false);
      setVisible({ visible: false });
    } catch (error) {
      console.error('Error adding song to playlist:', error);
      ToastAndroid.showWithGravity(
        `Error adding to playlist: ${error.message}`,
        ToastAndroid.SHORT,
        ToastAndroid.CENTER
      );
    }
  }
  async function handleCreatePlaylist() {
    if (newPlaylistName.trim()) {
      await CreateCustomPlaylist(newPlaylistName);
      const playlists = await GetCustomPlaylists();
      setAvailablePlaylists(playlists);
      setNewPlaylistName('');
      ToastAndroid.showWithGravity(
        'Playlist created successfully',
        ToastAndroid.SHORT,
        ToastAndroid.CENTER
      );
    }
  }
  const getPlaylistImage = (playlist) => {
    if (!playlist || playlist.length === 0) {
      return require('../../Images/wav.png');
    }

    // Safe image URL extraction for playlist cover - use last song's artwork
    const lastSong = playlist[playlist.length - 1];

    // Check artwork first (where we now store extracted URLs), then fallback to image
    const imageUrl =
      getHighestQualityArtwork(lastSong.artwork) ||
      getHighestQualityArtwork(lastSong.image);
    return imageUrl ? { uri: imageUrl } : require('../../Images/wav.png');
  };
  return (
    <>
      <Modal
        onBackButtonPress={() => setVisible({ visible: false })}
        onSwipeComplete={() => setVisible({ visible: false })}
        swipeDirection={['down']}
        isVisible={Visible?.visible || false}
        backdropOpacity={0.4}
        animationIn="slideInUp"
        animationOut="slideOutDown"
        animationInTiming={150}
        animationOutTiming={150}
        swipeThreshold={50}
        useNativeDriver
        hideModalContentWhileAnimating
        style={{
          margin: 0,
          justifyContent: 'flex-end',
        }}
      >
        <View
          style={{
            backgroundColor: colors.card,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            width: '100%',
            overflow: 'hidden',
            elevation: 10,
            paddingBottom: 20,
          }}
        >
          {/* Drawer Handle */}
          <View
            style={{ alignItems: 'center', paddingTop: 12, paddingBottom: 8 }}
          >
            <View
              style={{
                width: 40,
                height: 4,
                backgroundColor: colors.text,
                opacity: 0.2,
                borderRadius: 2,
              }}
            />
          </View>

          <MenuButton
            icon={
              <MaterialCommunityIcons
                name="play-speed"
                size={24}
                color={colors.text}
              />
            }
            text="Play Next"
            onPress={playNext}
            textColor={colors.text}
          />
          <MenuButton
            icon={
              <MaterialCommunityIcons
                name="playlist-plus"
                size={24}
                color={colors.text}
              />
            }
            text="Add to Queue"
            onPress={addSongToQueue}
            textColor={colors.text}
          />
          <MenuButton
            icon={
              <MaterialCommunityIcons
                name="playlist-music"
                size={24}
                color={colors.text}
              />
            }
            text="Add to Playlist"
            onPress={handleAddToPlaylist}
          />
          {isLocalMusic ? (
            <MenuButton
              icon={
                <MaterialCommunityIcons
                  name={isFavorite ? 'heart' : 'heart-outline'}
                  size={24}
                  color={isFavorite ? '#ff5252' : colors.text}
                />
              }
              text={isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}
              onPress={toggleLocalMusicFavorite}
            />
          ) : Visible?.source === 'favorites' ? (
            <MenuButton
              icon={
                <MaterialCommunityIcons
                  name="heart-broken"
                  size={24}
                  color={colors.text}
                />
              }
              text="Remove from Favorites"
              onPress={async () => {
                try {
                  const {
                    DeleteALikedSong,
                  } = require('../../LocalStorage/StoreLikedSongs');
                  await DeleteALikedSong(Visible?.id);
                  ToastAndroid.show(
                    'Removed from Favorites',
                    ToastAndroid.SHORT
                  );
                  setVisible({ visible: false });
                } catch (e) {
                  console.error(e);
                  ToastAndroid.show('Failed to remove', ToastAndroid.SHORT);
                }
              }}
              textColor={colors.text}
            />
          ) : (
            <MenuButton
              icon={
                <MaterialCommunityIcons
                  name="download"
                  size={24}
                  color={colors.text}
                />
              }
              text="Download"
              onPress={getPermission}
              textColor={colors.text}
            />
          )}
        </View>
      </Modal>
      <Modal
        isVisible={showPlaylistModal}
        onBackdropPress={() => setShowPlaylistModal(false)}
        onBackButtonPress={() => setShowPlaylistModal(false)}
        style={{
          margin: 0,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <View
          style={{
            backgroundColor: colors.card, // Themed background
            borderRadius: 10,
            padding: 20,
            width: '80%',
            maxHeight: '70%',
          }}
        >
          <TextInput
            placeholder="Create new playlist..."
            placeholderTextColor={colors.placeholder || colors.text} // Use placeholder or fallback to text
            value={newPlaylistName}
            onChangeText={setNewPlaylistName}
            style={{
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 5,
              padding: 12,
              color: colors.text,
              marginBottom: 10,
            }}
          />

          <Pressable
            onPress={handleCreatePlaylist}
            style={{
              backgroundColor: '#1DB954',
              padding: 12,
              borderRadius: 5,
              alignItems: 'center',
              marginBottom: 15,
            }}
          >
            <PlainText text="Create New Playlist" style={{ color: 'white' }} />
          </Pressable>

          <ScrollView style={{ maxHeight: 300 }}>
            {Object.keys(availablePlaylists).length === 0 ? (
              <View style={{ padding: 10, alignItems: 'center' }}>
                <PlainText
                  text="No playlists available"
                  style={{ color: colors.text, textAlign: 'center' }}
                />
              </View>
            ) : (
              Object.keys(availablePlaylists).map((name) => (
                <Pressable
                  key={name}
                  onPress={() => addSongToSelectedPlaylist(name)}
                  android_ripple={{
                    color: colors.dark
                      ? 'rgba(255,255,255,0.1)'
                      : 'rgba(0,0,0,0.05)',
                  }}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    padding: 12,
                    backgroundColor: colors.border, // Themed background for playlist items
                    borderRadius: 5,
                    marginBottom: 8,
                  }}
                >
                  <FastImage
                    source={getPlaylistImage(availablePlaylists[name])}
                    style={{
                      width: 50,
                      height: 50,
                      borderRadius: 4,
                    }}
                  />
                  <View style={{ marginLeft: 12, flex: 1 }}>
                    <PlainText
                      text={name}
                      style={{
                        color: colors.text,
                        fontSize: 16,
                      }}
                    />
                    <PlainText
                      text={`${availablePlaylists[name].length} songs`}
                      style={{
                        color: colors.textSecondary,
                        fontSize: 12,
                      }}
                    />
                  </View>
                </Pressable>
              ))
            )}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
};

const MenuButton = ({ icon, text, onPress, textColor: textColorProp }) => {
  const theme = useTheme();
  const rippleColor = theme.dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)';
  const finalTextColor = textColorProp || theme.colors.text;

  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: rippleColor }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 16,
        paddingHorizontal: 24,
      }}
    >
      {icon}
      <PlainText
        text={text}
        style={{
          color: finalTextColor,
          marginLeft: 20,
          fontSize: 16,
          fontWeight: '500',
        }}
      />
    </Pressable>
  );
};
