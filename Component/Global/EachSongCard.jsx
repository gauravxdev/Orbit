import {
  Dimensions,
  Pressable,
  View,
  Image,
  ToastAndroid,
} from 'react-native';
import { PlainText } from './PlainText';
import { SmallText } from './SmallText';
import { GlassBox } from './GlassBox';
import { AddPlaylist, getIndexQuality, PlayOneSong } from '../../MusicPlayerFunctions';
import { useTheme, useNavigation } from '@react-navigation/native';
import { memo, useContext, useState, useEffect } from 'react';
import Context from '../../Context/Context';
import TrackPlayer from 'react-native-track-player';
import FormatTitleAndArtist, {
  truncateText,
} from '../../Utils/FormatTitleAndArtist';
import FormatArtist from '../../Utils/FormatArtists';
import { EachSongMenuButton } from '../MusicPlayer/EachSongMenuButton';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { StorageManager } from '../../Utils/StorageManager';
import EventRegister from '../../Utils/EventRegister';
import Octicons from 'react-native-vector-icons/Octicons';
import { downloadSongNow } from '../../hooks/useDownloadSong';
import { DownloadProgressIndicator } from '../Download/DownloadProgressIndicator';

export const EachSongCard = memo(function EachSongCard({
  title,
  artist,
  image,
  id,
  url,
  duration,
  language,
  artistID,
  isLibraryLiked,
  width,
  titleandartistwidth,
  isFromPlaylist,
  isFromAlbum = false,
  Data,
  index,
  showNumber = false,
  source = 'ytmusic',
  truncateTitle = false,
  onDeleteComplete,
  activeTrackId,
  isPlaying,
  item,
  onLongPress,
  localSongPath,
  isLocal = false,
  allSongs = [],
  isArtist = false,
}) {
  const theme = useTheme();
  const navigation = useNavigation();
  const { colors } = theme;
  const width1 = Dimensions.get('window').width;
  const { updateTrack } = useContext(Context);
  const [isDownloaded, setIsDownloaded] = useState(isLocal);
  const [downloadInProgress, setDownloadInProgress] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  let imageSource = null;
  let safeImageUri = '';

  try {
    if (id === (activeTrackId ?? '') && isPlaying) {
      imageSource = require('../../Images/playing.gif');
    } else if (id === (activeTrackId ?? '') && !isPlaying) {
      imageSource = require('../../Images/songPaused.gif');
    } else {
      if (typeof image === 'string') {
        safeImageUri = image;
      } else if (Array.isArray(image) && image.length > 0) {
        if (typeof image[0] === 'object') {
          const maxRes = image.find(
            (img) => img.quality === 'max' || img.quality === 'hd'
          );
          if (maxRes && maxRes.url) {
            safeImageUri = maxRes.url;
          } else {
            for (let i = image.length - 1; i >= 0; i--) {
              const img = image[i];
              if (img && (img.url || img.uri || img.link)) {
                safeImageUri = img.url || img.uri || img.link;
                break;
              }
            }
          }
        } else if (typeof image[0] === 'string') {
          const lastValid = image
            .filter((i) => i && typeof i === 'string' && i.trim() !== '')
            .pop();
          safeImageUri = lastValid || '';
        }
      } else if (image && typeof image === 'object') {
        safeImageUri = image.uri || image.url || image.link || '';
      }
      imageSource = safeImageUri ? { uri: safeImageUri } : null;
    }
  } catch (error) {
    console.error('Error preparing image source:', error);
    imageSource = null;
    safeImageUri = '';
  }

  useEffect(() => {
    if (isLocal) {
      return;
    }

    const checkDownloadStatus = async () => {
      if (id) {
        try {
          const downloaded = await StorageManager.isSongDownloaded(id);
          setIsDownloaded(downloaded);
        } catch (error) {
          console.error('Error checking download status:', error);
          setIsDownloaded(false);
        }
      }
    };

    checkDownloadStatus();
  }, [id, isLocal]);

  useEffect(() => {
    let downloadListener = null;
    let downloadStartedListener = null;
    let downloadProgressListener = null;

    try {
      downloadListener = EventRegister.addEventListener(
        'download-complete',
        (songId) => {
          if (songId === id) {
            setIsDownloaded(true);
            setDownloadInProgress(false);
            setDownloadProgress(100);
          }
        }
      );

      downloadStartedListener = EventRegister.addEventListener(
        'download-started',
        (songId) => {
          if (songId === id) {
            setDownloadInProgress(true);
            setDownloadProgress(0);
          }
        }
      );

      downloadProgressListener = EventRegister.addEventListener(
        'download-progress',
        ({ songId, progress }) => {
          if (songId === id) {
            setDownloadProgress(progress);
          }
        }
      );
    } catch (error) {
      console.error('Error setting up download listeners:', error);
    }

    return () => {
      try {
        if (downloadListener !== null) {
          EventRegister.removeEventListener(downloadListener);
        }
        if (downloadStartedListener !== null) {
          EventRegister.removeEventListener(downloadStartedListener);
        }
        if (downloadProgressListener !== null) {
          EventRegister.removeEventListener(downloadProgressListener);
        }
      } catch (error) {
        console.error('Error cleaning up download listeners:', error);
      }
    };
  }, [id]);

  const formatText = (text) => {
    if (!text) {
      return 'Unknown';
    }
    try {
      const formattedText = FormatTitleAndArtist(String(text));
      if (!formattedText) {
        return 'Unknown';
      }
      return formattedText.length > 15
        ? formattedText.substring(0, 20) + '...'
        : formattedText;
    } catch (error) {
      console.warn('Error formatting text:', error);
      return 'Unknown';
    }
  };

  const formatDuration = (seconds) => {
    if (!seconds || seconds === 0 || seconds === '0') {
      return '';
    }
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return ` • ${mins}:${secs.toString().padStart(2, '0')}`;
  };

  async function AddSongToPlayer() {
    if (isLocal && allSongs.length > 0) {
      const isValidArtwork = (art) => {
        if (!art || typeof art !== 'string') {
          return false;
        }
        if (art.includes('htmlcolorcodes.com') || art.includes('placeholder')) {
          return false;
        }
        return (
          art.startsWith('http') ||
          art.startsWith('file://') ||
          art.startsWith('/') ||
          art.startsWith('data:')
        );
      };

      // Order songs starting from clicked index
      const orderedSongs = [
        ...allSongs.slice(index),
        ...allSongs.slice(0, index),
      ];

      const formattedTracks = [];
      for (const s of orderedSongs) {
        const sPath = s.url || s.localSongPath || s.filePath;
        if (!sPath) {
          continue;
        }

        const fileUrl =
          typeof sPath === 'string' && sPath.startsWith('file://')
            ? sPath
            : `file://${sPath}`;

        // Use valid artwork, filtering out placeholders
        const sArtwork = isValidArtwork(s.artwork)
          ? s.artwork
          : isValidArtwork(s.image)
            ? s.image
            : null;

        formattedTracks.push({
          id: s.id,
          url: fileUrl,
          title: s.title || s.name || 'Unknown Title',
          artist: s.artist || s.artists || 'Unknown Artist',
          artwork: sArtwork,
          image: sArtwork, // For minimized player compatibility
          duration: s.duration || 0,
          isLocal: true,
          isDownloaded: true,
          sourceType: 'download',
        });
      }

      if (formattedTracks.length > 0) {
        try {
          await TrackPlayer.reset();
          await TrackPlayer.add(formattedTracks);
          await TrackPlayer.play();
          updateTrack();
        } catch (playError) {
          console.error(
            '[Downloads] Error in TrackPlayer operations:',
            playError
          );
          ToastAndroid.show('Error playing song', ToastAndroid.SHORT);
        }
        return;
      }
    }

    if (isFromPlaylist) {
      const songs = Data?.data?.songs || [];
      const current = songs[index];
      const isYtMusicPlaylist =
        current &&
        (current.source === 'ytmusic' ||
          (typeof current.id === 'string' && current.id.length === 11));

      const isSpotifyPlaylist =
        current && (current.source === 'spotify' || current.spotifyId);

      const isDabPlaylist =
        current && (current.source === 'dab' || current.isDabTrack);

      if (
        (isYtMusicPlaylist || isSpotifyPlaylist || isDabPlaylist) &&
        current
      ) {
        const sourceType = isDabPlaylist
          ? 'DAB'
          : isSpotifyPlaylist
            ? 'Spotify'
            : 'YTMusic';

        const mappedSongs = songs.map((s) => ({
          ...s,
          artist:
            s.artist ||
            (s.artists?.primary ? FormatArtist(s.artists.primary) : null) ||
            s.primaryArtists ||
            (isFromAlbum ? artist : 'Unknown Artist'),
        }));
        await AddPlaylist(mappedSongs, current.id || current.videoId);

        updateTrack();
        return;
      }
      const ForMusicPlayer = [];
      const quality = await getIndexQuality();

      const getTrackUrl = (sources) => {
        if (!Array.isArray(sources) || sources.length === 0) {
          return '';
        }

        const preferredEntry =
          sources[quality] || sources[sources.length - 1] || sources[0];
        if (!preferredEntry || typeof preferredEntry !== 'object') {
          return '';
        }

        return (
          preferredEntry.url || preferredEntry.link || preferredEntry.uri || ''
        );
      };

      for (let i = index; i < songs.length; i++) {
        const e = songs[i];
        if (!e) {
          continue;
        }

        const songUrl =
          getTrackUrl(e.downloadUrl) || getTrackUrl(e.download_url);

        if (!songUrl) {
          continue;
        }

        let artworkUri = '';
        try {
          if (typeof e?.image === 'string') {
            artworkUri = e.image;
          } else if (e?.image && typeof e.image === 'object') {
            if (typeof e.image.uri === 'string') {
              artworkUri = e.image.uri;
            } else if (typeof e.image.url === 'string') {
              artworkUri = e.image.url;
            } else if (typeof e.image.link === 'string') {
              artworkUri = e.image.link;
            } else if (Array.isArray(e.image) && e.image.length > 0) {
              if (typeof e.image[0] === 'string') {
                artworkUri = e.image[0];
              } else if (e.image[0] && typeof e.image[0].url === 'string') {
                artworkUri = e.image[0].url;
              } else if (e.image[0] && typeof e.image[0].link === 'string') {
                artworkUri = e.image[0].link;
              }
            }
          }
        } catch (error) {
          console.error('Error extracting artwork URI:', error);
        }

        ForMusicPlayer.push({
          url: songUrl,
          title: formatText(e?.name),
          artist: formatText(
            e?.primaryArtists || FormatArtist(e?.artists?.primary) || (isFromAlbum ? artist : null)
          ),
          artwork: artworkUri,
          image: artworkUri,
          duration: e?.duration,
          id: e?.id,
          language: e?.language,
          downloadUrl: e?.downloadUrl || e?.download_url || [],
        });
      }

      if (ForMusicPlayer.length > 0) {
        await AddPlaylist(ForMusicPlayer);
        updateTrack();
      }
    } else if (isLibraryLiked) {
      const Final = [];

      for (let i = index; i < Data.length; i++) {
        const e = Data[i];

        let artworkUri = '';
        try {
          if (typeof e?.artwork === 'string') {
            artworkUri = e.artwork;
          } else if (e?.artwork && typeof e.artwork === 'object') {
            if (typeof e.artwork.uri === 'string') {
              artworkUri = e.artwork.uri;
            } else if (typeof e.artwork.url === 'string') {
              artworkUri = e.artwork.url;
            } else if (Array.isArray(e.artwork) && e.artwork.length > 0) {
              if (typeof e.artwork[0] === 'string') {
                artworkUri = e.artwork[0];
              } else if (e.artwork[0] && typeof e.artwork[0].url === 'string') {
                artworkUri = e.artwork[0].url;
              }
            }
          }
        } catch (error) {
          console.error('Error extracting artwork URI:', error);
        }

        let songUrl;
        if (e?.url) {
          if (typeof e.url === 'string') {
            songUrl = e.url;
          } else if (Array.isArray(e.url) && e.url.length > 0) {
            const qualityIdx = await getIndexQuality();
            const entry = e.url[qualityIdx] || e.url[0];
            songUrl = entry?.url || entry?.link || entry?.uri || '';
          }
        }

        if (!songUrl) {
          continue;
        }

        Final.push({
          url: songUrl,
          title: formatText(e?.title),
          artist: formatText(e?.artist),
          artwork: artworkUri,
          duration: e?.duration,
          id: e?.id,
          language: e?.language,
          artistID: e?.primary_artists_id,
          downloadUrl: e?.downloadUrl,
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

      await AddPlaylist(Final);
    } else {
      if (source === 'ytmusic') {
        const song = {
          url: '',
          title: formatText(title),
          artist: formatText(artist),
          artwork: safeImageUri,
          image: safeImageUri,
          duration: duration,
          id,
          language,
          artistID,
          downloadUrl: id,
          ...(Data?.data?.results?.[index] && {
            year: Data.data.results[index].year,
            playCount: Data.data.results[index].playCount,
            label: Data.data.results[index].label,
            copyright: Data.data.results[index].copyright,
            hasLyrics: Data.data.results[index].hasLyrics,
            album: Data.data.results[index].album,
            artists: Data.data.results[index].artists,
            releaseDate: Data.data.results[index].releaseDate,
            explicitContent: Data.data.results[index].explicitContent,
          }),
        };
        PlayOneSong(song);
        return;
      } else if (source === 'spotify') {
        const song = {
          url: '',
          title: formatText(title),
          artist: formatText(artist),
          artwork: safeImageUri,
          image: safeImageUri,
          duration: duration,
          id,
          spotifyId: id,
          source: 'spotify',
          language,
          artistID,
          // Preserve additional metadata
          ...(Data?.data?.results?.[index] && {
            album: Data.data.results[index].album,
            explicit: Data.data.results[index].explicit,
            previewUrl: Data.data.results[index].previewUrl,
          }),
        };
        PlayOneSong(song);
        return;
      } else if (
        source === 'dab' ||
        item?.isDabTrack ||
        (!isNaN(url) && String(url).length > 5)
      ) {
        const song = {
          url: url,
          title: formatText(title),
          artist: formatText(artist),
          artwork: safeImageUri,
          image: safeImageUri,
          duration: duration,
          id,
          source: 'dab',
          isDabTrack: true,
          language,
          artistID,
          ...(Data?.data?.results?.[index] && {
            album: Data.data.results[index].album,
            audioQuality: Data.data.results[index].audioQuality,
            isHiRes: Data.data.results[index].isHiRes,
            qualityLabel: Data.data.results[index].qualityLabel,
          }),
        };
        PlayOneSong(song);
        return;
      } else {

        const quality = await getIndexQuality();

        let songUrl;

        const downloadUrlSource =
          url || item?.downloadUrl || item?.download_url;

        if (downloadUrlSource) {
          if (Array.isArray(downloadUrlSource) && downloadUrlSource.length > 0) {
            const entry =
              downloadUrlSource[quality] ||
              downloadUrlSource[downloadUrlSource.length - 1] ||
              downloadUrlSource[0];

            if (entry) {
              songUrl = entry.link || entry.url || entry.uri;
            }
          } else if (typeof downloadUrlSource === 'string') {
            songUrl = downloadUrlSource;
          }
        }

        if (!songUrl) {
          console.warn(
            `[Saavn Playback] No valid URL found for song: "${title}" (ID: ${id}). url prop:`,
            url,
            'item.downloadUrl:',
            item?.downloadUrl
          );
          return;
        }

        const song = {
          url: songUrl,
          title: formatText(title),
          artist: formatText(artist),
          artwork: safeImageUri,
          duration,
          id,
          language,
          artistID: artistID,
          image: safeImageUri,
          downloadUrl: url,
          ...(Data?.data?.results?.[index] && {
            year: Data.data.results[index].year,
            playCount: Data.data.results[index].playCount,
            label: Data.data.results[index].label,
            copyright: Data.data.results[index].copyright,
            hasLyrics: Data.data.results[index].hasLyrics,
            album: Data.data.results[index].album,
            artists: Data.data.results[index].artists,
            releaseDate: Data.data.results[index].releaseDate,
            explicitContent: Data.data.results[index].explicitContent,
          }),
        };
        PlayOneSong(song);
      }
    }

    if (source === 'search' && Data?.data?.results?.[index]?.album?.id) {
      try {
        const { getAlbumData } = require('../../Api/Album');
        const albumId = Data.data.results[index].album.id;
        const albumData = await getAlbumData(albumId);
        if (albumData?.data?.songs?.length > 0) {
          const quality = await getIndexQuality();
          const albumSongs = albumData.data.songs
            .filter((e) => e.id !== id)
            .map((e) => {
              let songUrl = '';
              if (e.downloadUrl && Array.isArray(e.downloadUrl) && e.downloadUrl.length > 0) {
                const entry = e.downloadUrl[quality] || e.downloadUrl[0];
                songUrl = entry?.url || entry?.link || entry?.uri || '';
              } else if (e.download_url && Array.isArray(e.download_url) && e.download_url.length > 0) {
                const entry = e.download_url[quality] || e.download_url[0];
                songUrl = entry?.url || entry?.link || entry?.uri || '';
              }
              let artworkUri = '';
              if (typeof e?.image === 'string') {
                artworkUri = e.image;
              } else if (e?.image && typeof e.image === 'object') {
                artworkUri = e.image.url || e.image.link || e.image.uri || '';
                if (!artworkUri && Array.isArray(e.image) && e.image.length > 0) {
                  const firstImg = e.image[0];
                  artworkUri = typeof firstImg === 'string' ? firstImg : firstImg?.url || firstImg?.link || firstImg?.uri || '';
                }
              }
              return {
                url: songUrl,
                title: e?.name,
                artist: FormatArtist(e?.artists?.primary),
                artwork: artworkUri,
                image: artworkUri,
                duration: e?.duration,
                id: e?.id,
                language: e?.language,
                downloadUrl: e?.downloadUrl || e?.download_url || [],
                albumId: albumId,
              };
            });
          if (albumSongs.length > 0) {
            const { AddSongsToQueue } = require('../../MusicPlayerFunctions');
            await AddSongsToQueue(albumSongs);
          }
        }
      } catch (err) {
        console.error('Error adding album songs to queue from search:', err);
      }
      try {
        const { getArtistSongsPaginated } = require('../../Api/Songs');
        const { AddSongsToQueue } = require('../../MusicPlayerFunctions');
        const songObj = Data?.data?.results?.[index];
        const artistArr = songObj?.artists?.primary || [];
        for (const artist of artistArr) {
          const artistId = artist.id;
          if (!artistId) {
            continue;
          }
          const artistSongsData = await getArtistSongsPaginated(
            artistId,
            1,
            10
          );
          const artistSongs = (artistSongsData?.data?.songs || [])
            .filter(
              (e) =>
                e.id !== id &&
                (!songObj.album || e.album?.id !== songObj.album.id)
            )
            .map((e) => {
              let songUrl = '';
              const qualityPref = 4;
              if (e.downloadUrl && Array.isArray(e.downloadUrl) && e.downloadUrl.length > 0) {
                const entry = e.downloadUrl[qualityPref] || e.downloadUrl[0];
                songUrl = entry?.url || entry?.link || entry?.uri || '';
              } else if (e.download_url && Array.isArray(e.download_url) && e.download_url.length > 0) {
                const entry = e.download_url[qualityPref] || e.download_url[0];
                songUrl = entry?.url || entry?.link || entry?.uri || '';
              }
              let artworkUri = '';
              if (typeof e?.image === 'string') {
                artworkUri = e.image;
              } else if (e?.image && typeof e.image === 'object') {
                artworkUri = e.image.url || e.image.link || e.image.uri || '';
                if (!artworkUri && Array.isArray(e.image) && e.image.length > 0) {
                  const firstImg = e.image[0];
                  artworkUri = typeof firstImg === 'string' ? firstImg : firstImg?.url || firstImg?.link || firstImg?.uri || '';
                }
              }
              return {
                url: songUrl,
                title: e?.name,
                artist: FormatArtist(e?.artists?.primary),
                artwork: artworkUri,
                image: artworkUri,
                duration: e?.duration,
                id: e?.id,
                language: e?.language,
                downloadUrl: e?.downloadUrl || e?.download_url || [],
                albumId: e?.album?.id || null,
              };
            });
          if (artistSongs.length > 0) {
            await AddSongsToQueue(artistSongs);
          }
        }
      } catch (err) {
        console.error('Error adding artist songs to queue from search:', err);
      }
    }

    updateTrack();
  }

  const handleDownload = async () => {
    if (isDownloaded) {
      ToastAndroid.show('Song is already downloaded!', ToastAndroid.SHORT);
      return;
    }
    if (downloadInProgress) {
      ToastAndroid.show('Download already in progress.', ToastAndroid.SHORT);
      return;
    }

    try {
      setDownloadInProgress(true);

      // Permission handling and source detection live in the shared helper.
      const success = await downloadSongNow({
        ...(item || {}),
        id,
        title,
        artist,
        url,
        image: typeof image === 'string' ? image : image?.uri || safeImageUri,
        duration,
        language,
        artistID,
      });

      if (success) {
        setIsDownloaded(true);
      }
    } catch (error) {
      console.error('Download failed:', error);
      ToastAndroid.show(
        `Download failed for ${title}: ${error.message}`,
        ToastAndroid.LONG
      );
    } finally {
      setDownloadInProgress(false);
    }
  };

  const handleDelete = async (songId, songTitle) => {
    try {
      await StorageManager.removeDownloadedSongMetadata(songId, localSongPath);
      setIsDownloaded(false);
      if (onDeleteComplete) {
        onDeleteComplete(songId);
      }

      ToastAndroid.show('Song deleted', ToastAndroid.SHORT);
    } catch (error) {
      console.error('Delete failed:', error);
      ToastAndroid.show(`Delete failed: ${error.message}`, ToastAndroid.LONG);
    }
  };

  return (
    <>
      <Pressable
        onPress={
          isArtist
            ? () => {
              navigation.navigate('MainRoute', {
                screen: 'Home',
                params: {
                  screen: 'ArtistPage',
                  params: {
                    artistId: id || item?.id || item?.browseId,
                    artistName: title || name,
                    source: item?.source || (source === 'ytmusic' ? 'ytmusic' : 'saavn'),
                  },
                },
              });
            }
            : AddSongToPlayer
        }
        onLongPress={() => {
          if (onLongPress) {
            onLongPress();
          }
        }}
        android_ripple={{
          color: theme.dark
            ? 'rgba(255, 255, 255, 0.15)'
            : 'rgba(0, 0, 0, 0.05)',
          borderless: false,
        }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 8,
          paddingHorizontal: 12,
          backgroundColor:
            id === activeTrackId ? colors.playingCard : 'transparent',
        }}
      >
        {showNumber && (
          <View style={{ marginRight: 10 }}>
            <PlainText text={index + 1} />
          </View>
        )}
        <View style={{ marginRight: 10 }}>
          <Image
            source={imageSource || require('../../Images/default.jpg')}
            style={{
              width: isFromAlbum ? 45 : 50,
              height: isFromAlbum ? 45 : 50,
              borderRadius: isArtist ? 25 : 4,
            }}
          />
        </View>
        <View
          style={{
            flex: 1,
          }}
        >
          <PlainText
            text={
              truncateTitle
                ? truncateText(
                  formatText(title),
                  isFromAlbum ? 15 : isFromPlaylist ? 15 : 15
                )
                : formatText(title)
            }
            songId={id}
            isSongTitle={true}
            isCurrentlyPlaying={id === activeTrackId}
            style={{
              width: titleandartistwidth
                ? titleandartistwidth
                : width1 * (isFromAlbum ? 0.65 : isFromPlaylist ? 0.63 : 0.66),
              marginBottom: 2,
              color: theme.dark ? colors.text : '#333333',
            }}
            numberOfLines={1}
            ellipsizeMode="tail"
          />
          <SmallText
            text={
              isArtist
                ? (artist ? String(artist).replace(/[\s•·]+$/, '').trim() : 'artist')
                : truncateText(
                    formatText(artist),
                    isFromAlbum ? 30 : isFromPlaylist ? 32 : 35
                  )
            }
            isArtistName={true}
            style={{
              width: titleandartistwidth
                ? titleandartistwidth
                : width1 * (isFromAlbum ? 0.63 : isFromPlaylist ? 0.59 : 0.63),
              color: theme.dark ? colors.textSecondary : '#666666',
            }}
            numberOfLines={1}
            ellipsizeMode="tail"
          />
        </View>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'flex-end',
            alignItems: 'center',
            minWidth: isFromAlbum ? 70 : isFromPlaylist ? 70 : 65,
          }}
        >
          {isArtist ? (
            <MaterialCommunityIcons name="chevron-right" size={24} color={theme.dark ? '#666' : '#999'} style={{ marginRight: 10 }} />
          ) : (
            <>
              <Pressable
                onPress={(e) => {
                  e.stopPropagation();
                  handleDownload();
                }}
                style={{
                  marginRight: isFromAlbum ? 10 : isFromPlaylist ? 10 : 10,
                }}
              >
                <GlassBox
                  id={`download-${id}`}
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
                      { offset: '0%', opacity: 0.5 },
                      { offset: '25%', opacity: 0.5 },
                      { offset: '50%', opacity: 0.0 },
                      { offset: '75%', opacity: 0.5 },
                      { offset: '100%', opacity: 0.5 },
                    ],
                  }}
                >
                  {isDownloaded ? (
                    <Octicons name="check-circle" size={18} color="#1DB954" />
                  ) : downloadInProgress ? (
                    <DownloadProgressIndicator
                      progress={downloadProgress}
                      size={18}
                      thickness={2}
                      showPercentage={false}
                    />
                  ) : (
                    <Octicons
                      name="download"
                      size={18}
                      color={theme.dark ? '#ffffff' : '#333333'}
                    />
                  )}
                </GlassBox>
              </Pressable>

              <EachSongMenuButton
                song={{
                  title,
                  artist,
                  artwork: image,
                  image: image,
                  id,
                  url,
                  downloadUrl: item?.downloadUrl || item?.download_url,
                  duration,
                  language,
                  artistID,
                  localSongPath,
                  source: item?.source || source || 'saavn',
                  spotifyId:
                    source === 'spotify' || item?.source === 'spotify'
                      ? id
                      : undefined,
                  isDabTrack: item?.isDabTrack || source === 'dab' || false,
                }}
                isFromPlaylist={isFromPlaylist}
                isFromAlbum={isFromAlbum}
                size={isFromAlbum ? 36 : 32}
                marginRight={isFromAlbum ? 0 : 0}
                isDownloaded={isDownloaded}
                onDelete={handleDelete}
              />
            </>
          )}
        </View>
      </Pressable>
    </>
  );
});
