import { StorageManager } from './StorageManager';
import {
  downloadFileWithAnalytics,
  detectAudioFormat,
  renameToCorrectExtension,
} from './FileUtils';
import { ToastAndroid } from 'react-native';
import EventRegister from './EventRegister';
import { getIndexQuality } from '../MusicPlayerFunctions';
import { embedMetadataInFile } from './NativeMetadataWriter';
import RNFS from 'react-native-fs';

export class UnifiedDownloadService {
  static async downloadSong(song, onProgress = null) {
    try {
      if (!song || !song.id) {
        ToastAndroid.show('Invalid song data', ToastAndroid.SHORT);
        return false;
      }

      const isAlreadyDownloaded = await StorageManager.isSongDownloaded(
        song.id
      );
      if (isAlreadyDownloaded) {
        ToastAndroid.show('Song already downloaded', ToastAndroid.SHORT);
        return true;
      }

      EventRegister.emit('download-started', song.id);
      await StorageManager.ensureDirectoriesExist();

      const downloadResult = await this.getDownloadUrl(song);
      if (!downloadResult) {
        throw new Error('No valid download URL found');
      }

      let downloadUrl;
      let downloadHeaders = null;
      let audioFormat = null;
      if (typeof downloadResult === 'object' && downloadResult.url) {
        downloadUrl = downloadResult.url;
        downloadHeaders = downloadResult.headers || null;
        audioFormat = downloadResult.format || null;
      } else {
        downloadUrl = downloadResult;
      }

      const isYTMusic =
        song.source === 'ytmusic' ||
        (song.id &&
          typeof song.id === 'string' &&
          song.id.length === 11 &&
          !song.isDabTrack &&
          !song.isLocalMusic);

      let effectiveSource;
      if (isYTMusic && audioFormat) {
        effectiveSource = `ytmusic_${audioFormat}`;
      } else if (isYTMusic) {
        effectiveSource = 'ytmusic';
      } else {
        effectiveSource = song.source || (song.isDabTrack ? 'dab' : null);
      }
      const songPath = await StorageManager.getSongPath(
        song.id,
        song.title,
        effectiveSource
      );
      const artworkPath = await StorageManager.getArtworkPath(song.id);

      const songDownloadSuccess = await downloadFileWithAnalytics(
        downloadUrl,
        songPath,
        {
          id: String(song.id),
          name: String(song.title || 'Unknown'),
          type: 'song',
        },
        downloadHeaders,
        (progress) => {
          EventRegister.emit('download-progress', {
            songId: song.id,
            progress,
          });
          if (typeof onProgress === 'function') {
            onProgress(progress);
          }
        }
      );

      if (!songDownloadSuccess) {
        throw new Error('Failed to download song file');
      }

      // Try the upgraded artwork first, then the fallback. The high quality
      // variant (maxresdefault) does not exist for every video, so without a
      // second attempt an upgrade could silently lose the artwork entirely.
      let artworkDownloadSuccess = false;
      // The candidate that actually downloaded, recorded for the metadata.
      let usedArtworkUrl = null;
      const artworkCandidates = [
        this.getArtworkUrl(song),
        song.artworkFallback,
      ].filter(
        (url, index, all) =>
          typeof url === 'string' &&
          url.startsWith('http') &&
          all.indexOf(url) === index
      );

      for (const artworkUrl of artworkCandidates) {
        try {
          artworkDownloadSuccess = await downloadFileWithAnalytics(
            artworkUrl,
            artworkPath,
            {
              id: String(song.id),
              name: String(song.title || 'Unknown') + ' - Artwork',
              type: 'artwork',
            }
          );

          if (artworkDownloadSuccess) {
            const fileExists = await RNFS.exists(artworkPath);
            if (fileExists) {
              const fileInfo = await RNFS.stat(artworkPath);
              if (fileInfo.size < 100) {
                console.warn(
                  `[Artwork] Downloaded file too small (${fileInfo.size} bytes), likely invalid`
                );
                artworkDownloadSuccess = false;
                await RNFS.unlink(artworkPath).catch(() => {});
              }
            } else {
              console.warn(
                '[Artwork] Download reported success but file not found'
              );
              artworkDownloadSuccess = false;
            }
          }
        } catch (artworkError) {
          console.error(
            '[Artwork] Error downloading artwork:',
            artworkError.message
          );
          artworkDownloadSuccess = false;
        }

        if (artworkDownloadSuccess) {
          usedArtworkUrl = artworkUrl;
          break;
        }
      }

      if (!artworkDownloadSuccess && artworkCandidates.length > 0) {
        console.warn(`[Artwork] All artwork candidates failed for: ${song.title}`);
      }

      const formatInfo = await detectAudioFormat(songPath);
      let finalSongPath = songPath;
      if (
        formatInfo.actualExtension &&
        !songPath.toLowerCase().endsWith(formatInfo.actualExtension)
      ) {
        const renamedPath = await renameToCorrectExtension(
          songPath,
          formatInfo.actualExtension
        );
        if (renamedPath) {
          finalSongPath = renamedPath;
        }
      }

      let metadataEmbedded = false;
      if (formatInfo.canEmbedMetadata) {
        try {
          const artworkPathToEmbed = artworkDownloadSuccess
            ? artworkPath
            : null;
          metadataEmbedded = await embedMetadataInFile(
            finalSongPath,
            {
              title: String(song.title || 'Unknown'),
              artist: String(
                this.formatArtist(song.artist) || 'Unknown Artist'
              ),
              album: String(song.album || 'Unknown Album'),
              year: String(song.year || new Date().getFullYear().toString()),
            },
            artworkPathToEmbed
          );

          if (metadataEmbedded) {
            if (artworkDownloadSuccess && (await RNFS.exists(artworkPath))) {
              try {
                await RNFS.unlink(artworkPath);
              } catch (cleanupErr) {
              }
            }
          }
        } catch (embedError) {
          console.warn(
            `Failed to embed metadata for ${song.title}:`,
            embedError
          );
        }
      } else {
      }

      const metadata = {
        id: song.id,
        title: song.title || 'Unknown',
        artist: this.formatArtist(song.artist) || 'Unknown Artist',
        album: song.album || 'Unknown Album',
        url: downloadUrl,
        artwork: usedArtworkUrl || artworkCandidates[0] || null,
        localSongPath: finalSongPath,
        localArtworkPath:
          artworkDownloadSuccess && !metadataEmbedded ? artworkPath : null,
        duration: song.duration || 0,
        language: song.language || '',
        artistID: song.artistID || '',
        source: effectiveSource || 'saavn',
        isDownloaded: true,
        metadataEmbedded: metadataEmbedded,
        downloadedAt: new Date().toISOString(),
      };

      await StorageManager.saveDownloadedSongMetadata(song.id, metadata);
      EventRegister.emit('download-complete', song.id);

      ToastAndroid.show(`${song.title} Downloaded`, ToastAndroid.SHORT);

      return true;
    } catch (error) {
      console.error(`Download failed for ${song.title}:`, error);
      ToastAndroid.show(`Download failed: ${error.message}`, ToastAndroid.LONG);

      try {
        await StorageManager.removeDownloadedSongMetadata(song.id);
      } catch (cleanupError) {
        console.error(
          'Error cleaning up failed download metadata:',
          cleanupError
        );
      }

      return false;
    }
  }

  static async getDownloadUrl(song) {
    try {
      const quality = await getIndexQuality();

      const isYTMusic =
        song.source === 'ytmusic' ||
        (song.id &&
          typeof song.id === 'string' &&
          song.id.length === 11 &&
          !song.isDabTrack &&
          !song.isLocalMusic);

      if (isYTMusic) {
        try {
          const youtubeStreamingService =
            require('./YouTubeStreamingService').default;
          const streamData = await youtubeStreamingService.getStreamUrl(
            song.id,
            true
          );

          if (streamData && streamData.url) {
            return {
              url: streamData.url,
              headers: streamData.headers || {
                'User-Agent':
                  'com.google.android.youtube/19.09.37 (Linux; U; Android 12; en_IN)',
                Range: 'bytes=0-',
              },
              thumbnail: streamData.thumbnail,
              format: streamData.format || null,
              mimeType: streamData.mimeType || null,
              source: 'ytmusic',
            };
          }
          console.error(
            '❌ Failed to get YTMusic download URL - no URL returned'
          );
          return null;
        } catch (ytError) {
          console.error('❌ YTMusic stream URL fetch error:', ytError.message);
          return null;
        }
      }

      if (
        song.source === 'spotify' ||
        song.spotifyId ||
        song._needsSpotifyMapping ||
        (typeof song.url === 'string' && song.url?.startsWith('spotify://'))
      ) {
        try {
          const YouTubeMusicService = require('./YouTubeMusicService').default;
          const ytMusicResult = await YouTubeMusicService.searchAndStream(
            song.title || song.name,
            song.artist || song.primaryArtists || song.artists || ''
          );

          if (ytMusicResult && ytMusicResult.url && !ytMusicResult.error) {
            return {
              url: ytMusicResult.url,
              headers: ytMusicResult.headers || {
                'User-Agent':
                  'com.google.android.youtube/19.09.37 (Linux; U; Android 12; en_IN)',
                Range: 'bytes=0-',
              },
              format: ytMusicResult.format || null,
              source: 'ytmusic',
            };
          }
          console.error(
            '❌ Failed to map Spotify track to YTMusic for download:',
            song.title
          );
          return null;
        } catch (spotifyError) {
          console.error(
            '❌ Spotify mapping error for download:',
            spotifyError.message
          );
          return null;
        }
      }

      if (song.source === 'dab' || song.isDabTrack === true) {
        try {
          const dabMusicService = require('./DabMusicService').default;
          await dabMusicService.initialize();

          const streamUrl = await dabMusicService.getStreamUrl(song.id);
          if (streamUrl) {
            return streamUrl;
          }
          console.error('❌ Failed to get DAB download URL - no URL returned');
          return null;
        } catch (dabError) {
          console.error('❌ DAB stream URL fetch error:', dabError.message);
          return null;
        }
      }

      if (song.downloadUrl && Array.isArray(song.downloadUrl)) {
        if (song.downloadUrl[quality]?.url) {
          return song.downloadUrl[quality].url;
        }
        for (let i = song.downloadUrl.length - 1; i >= 0; i--) {
          if (song.downloadUrl[i]?.url) {
            return song.downloadUrl[i].url;
          }
        }
      }

      if (song.download_url && Array.isArray(song.download_url)) {
        if (song.download_url[quality]?.url) {
          return song.download_url[quality].url;
        }
        for (let i = song.download_url.length - 1; i >= 0; i--) {
          if (song.download_url[i]?.url) {
            return song.download_url[i].url;
          }
        }
      }

      if (song.url && Array.isArray(song.url)) {
        if (song.url[quality]?.url) {
          return song.url[quality].url;
        }
        for (let i = song.url.length - 1; i >= 0; i--) {
          if (song.url[i]?.url) {
            return song.url[i].url;
          }
        }
      }

      if (typeof song.url === 'string' && song.url.startsWith('http')) {
        return song.url;
      }

      console.error('No valid download URL found in song data:', song);
      return null;
    } catch (error) {
      console.error('Error getting download URL:', error);
      return null;
    }
  }

  static getArtworkUrl(song) {
    const isValidUrl = (url) => {
      if (!url || typeof url !== 'string') {
        return false;
      }
      if (!url.startsWith('http')) {
        return false;
      }
      if (url.includes('placeholder') || url.includes('htmlcolorcodes.com')) {
        return false;
      }
      return true;
    };

    if (isValidUrl(song.artwork)) {
      return song.artwork;
    }

    if (
      song.artwork &&
      typeof song.artwork === 'object' &&
      isValidUrl(song.artwork.uri)
    ) {
      return song.artwork.uri;
    }

    if (isValidUrl(song.image)) {
      return song.image;
    }

    if (
      song.image &&
      typeof song.image === 'object' &&
      !Array.isArray(song.image) &&
      isValidUrl(song.image.uri)
    ) {
      return song.image.uri;
    }

    if (song.image && Array.isArray(song.image) && song.image.length > 0) {
      for (let i = song.image.length - 1; i >= 0; i--) {
        const item = song.image[i];
        if (typeof item === 'string' && isValidUrl(item)) {
          return item;
        }
        if (item?.url && isValidUrl(item.url)) {
          return item.url;
        }
        if (item?.uri && isValidUrl(item.uri)) {
          return item.uri;
        }
        if (item?.link && isValidUrl(item.link)) {
          return item.link;
        }
      }
    }

    if (isValidUrl(song.cover)) {
      return song.cover;
    }

    if (isValidUrl(song.thumbnail)) {
      return song.thumbnail;
    }

    if (song.images && Array.isArray(song.images) && song.images.length > 0) {
      for (let i = song.images.length - 1; i >= 0; i--) {
        const item = song.images[i];
        if (typeof item === 'string' && isValidUrl(item)) {
          return item;
        }
        if (item?.url && isValidUrl(item.url)) {
          return item.url;
        }
      }
    }

    return null;
  }

  static formatArtist(artist) {
    if (!artist) {
      return 'Unknown Artist';
    }

    if (typeof artist === 'string') {
      return artist;
    }

    if (Array.isArray(artist)) {
      return artist.map((a) => (typeof a === 'object' ? a.name : a)).join(', ');
    }

    if (typeof artist === 'object' && artist.name) {
      return artist.name;
    }

    return 'Unknown Artist';
  }

  static async isDownloaded(songId) {
    return await StorageManager.isSongDownloaded(songId);
  }

  static async removeSong(songId) {
    try {
      await StorageManager.removeDownloadedSongMetadata(songId);
      EventRegister.emit('download-removed', songId);
      return true;
    } catch (error) {
      console.error('Error removing downloaded song:', error);
      return false;
    }
  }
}
