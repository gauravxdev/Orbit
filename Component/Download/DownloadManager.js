import { Alert } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import RNFS from 'react-native-fs';
import { StorageManager } from '../../Utils/StorageManager';
import { safePath, safeDownloadFile, safeUnlink } from '../../Utils/FileUtils';
import EventRegister from '../../Utils/EventRegister';
import { getIndexQuality } from '../../MusicPlayerFunctions';

/**
 * DownloadManager - Handles the core download logic, metadata saving, and artwork caching
 * Provides a clean interface for downloading songs with progress tracking
 */
export class DownloadManager {

  /**
   * Downloads a song with progress tracking and metadata saving
   * @param {Object} songData - Song data object
   * @param {Function} onProgress - Progress callback (percentage) => void
   * @param {Function} onComplete - Completion callback (success, songId) => void
   * @param {Function} onError - Error callback (error, songId) => void
   * @returns {Promise<boolean>} - Success status
   */
  static async downloadSong(songData, onProgress = null, onComplete = null, onError = null) {
    const songId = songData?.id;

    try {
      console.log("DownloadManager: Received song data:", JSON.stringify(songData, null, 2));

      // Validate input
      if (!songData || !songId) {
        const error = new Error("Invalid song data provided - missing songData or songId");
        console.error("DownloadManager: Invalid song data:", songData);
        if (onError) onError(error, songId);
        return false;
      }

      // Get download URL using the same logic as UnifiedDownloadService
      const downloadUrl = await this.getDownloadUrl(songData);
      if (!downloadUrl) {
        const error = new Error("No valid download URL found in song data");
        console.error("DownloadManager: No valid URL found in song data:", songData);
        if (onError) onError(error, songId);
        return false;
      }

      console.log("DownloadManager: Starting download for:", songData.title, "URL:", downloadUrl);

      // Check if already downloaded
      console.log("DownloadManager: Checking if song is already downloaded, songId:", songId);
      const isAlreadyDownloaded = await StorageManager.isSongDownloaded(songId);
      console.log("DownloadManager: isSongDownloaded result:", isAlreadyDownloaded);

      if (isAlreadyDownloaded) {
        console.log("DownloadManager: Song already downloaded:", songId);
        Alert.alert("Already Downloaded", "This song is already in your library");
        if (onComplete) onComplete(true, songId);
        return true;
      }

      console.log("DownloadManager: Song not downloaded yet, proceeding with download");

      // Ensure directories exist
      console.log("DownloadManager: Ensuring directories exist...");
      await this.ensureDownloadDirectories();

      // Prepare download path
      const downloadPath = await this.getDownloadPath(songId, songData.title);
      console.log("DownloadManager: Download path:", downloadPath);

      // Start download
      console.log("DownloadManager: Starting file download...");
      const downloadSuccess = await this.performDownload(
        downloadUrl,
        downloadPath,
        onProgress
      );

      if (!downloadSuccess) {
        throw new Error("Failed to download song file");
      }

      console.log("DownloadManager: File download successful, saving metadata...");
      // Save metadata
      await this.saveMetadata(songData, downloadPath, downloadUrl);

      console.log("DownloadManager: Downloading artwork...");
      // Download artwork if available
      await this.downloadArtwork(songData);

      // Emit completion events
      EventRegister.emit('download-complete', songId);
      console.log("DownloadManager: Download completed successfully for:", songData.title);

      if (onComplete) onComplete(true, songId);
      return true;

    } catch (error) {
      console.error("DownloadManager: Download failed for", songData?.title, ":", error);

      // Clean up partial downloads
      try {
        const downloadPath = await this.getDownloadPath(songId, songData?.title);
        await safeUnlink(downloadPath);
      } catch (cleanupError) {
        console.error("DownloadManager: Error cleaning up partial download:", cleanupError);
      }

      if (onError) {
        onError(error, songId);
      } else {
        Alert.alert("Download Failed", "There was an error downloading the song. Please try again.");
      }

      return false;
    }
  }

  /**
   * Ensures all necessary download directories exist
   */
  static async ensureDownloadDirectories() {
    try {
      // Use StorageManager's directory structure
      await StorageManager.ensureDirectoriesExist();
      console.log("DownloadManager: Directories ensured via StorageManager");
    } catch (error) {
      console.error("DownloadManager: Error in ensureDownloadDirectories:", error);
      // Continue - ReactNativeBlobUtil might handle this
    }
  }

  /**
   * Gets the download path for a song using StorageManager
   * @param {string} songId - Song ID
   * @param {string} songTitle - Song title for filename
   * @returns {string} - Safe download path
   */
  static async getDownloadPath(songId, songTitle = null) {
    try {
      const path = await StorageManager.getSongPath(songId, songTitle);
      return safePath(path);
    } catch (error) {
      console.error("DownloadManager: Error getting download path:", error);
      throw new Error("Failed to get download path");
    }
  }

  /**
   * Performs the actual file download with progress tracking
   * @param {string} url - Download URL
   * @param {string} downloadPath - Local file path
   * @param {Function} onProgress - Progress callback
   * @returns {Promise<boolean>} - Success status
   */
  static async performDownload(url, downloadPath, onProgress) {
    const downloadConfig = {
      fileCache: false,
      path: downloadPath,
      overwrite: true,
      indicator: false,
      timeout: 60000
    };

    try {
      const res = await ReactNativeBlobUtil.config(downloadConfig)
        .fetch('GET', url, {
          'Accept': 'audio/mpeg, application/octet-stream',
          'Cache-Control': 'no-store'
        })
        .progress((received, total) => {
          if (total <= 0) return;
          const percentage = Math.floor((received / total) * 100);
          if (onProgress) onProgress(percentage);
        });

      // Fix: Use respInfo.status instead of res.info().status
      if (res.respInfo.status !== 200) {
        throw new Error(`Download failed with status: ${res.respInfo.status}`);
      }

      return true;
    } catch (error) {
      console.error('DownloadManager: ReactNativeBlobUtil.fetch failed:', error);
      throw error;
    }
  }

  /**
   * Saves song metadata after successful download
   * @param {Object} songData - Song data
   * @param {string} downloadPath - Local file path
   * @param {string} downloadUrl - The actual download URL used
   */
  static async saveMetadata(songData, downloadPath, downloadUrl) {
    try {
      const metadata = {
        id: songData.id,
        title: songData.title || 'Unknown',
        artist: songData.artist || 'Unknown',
        album: songData.album || 'Unknown',
        url: downloadUrl, // Use the resolved download URL
        artwork: songData.artwork || null,
        duration: songData.duration || 0,
        downloadedAt: new Date().toISOString(),
        localPath: downloadPath
      };

      await StorageManager.saveDownloadedSongMetadata(songData.id, metadata);
      console.log("DownloadManager: Metadata saved successfully for:", songData.id);
    } catch (error) {
      console.error("DownloadManager: Error saving metadata:", error);
      // Continue - song is still downloaded even if metadata fails
    }
  }

  /**
   * Downloads and saves artwork for the song
   * @param {Object} songData - Song data
   */
  static async downloadArtwork(songData) {
    if (!songData.artwork || typeof songData.artwork !== 'string') {
      console.log("DownloadManager: No artwork URL provided");
      return;
    }

    try {
      // Ensure we're using the highest quality artwork
      let highQualityArtwork = songData.artwork;
      if (highQualityArtwork.includes('saavncdn.com')) {
        highQualityArtwork = highQualityArtwork.replace(/50x50|150x150|500x500|1000x1000/g, '1000x1000');
      }

      // Use StorageManager for artwork download
      const artworkPath = await StorageManager.saveArtwork(songData.id, highQualityArtwork);
      if (artworkPath) {
        console.log("DownloadManager: Artwork saved successfully via StorageManager");
      } else {
        console.log("DownloadManager: Artwork download failed via StorageManager");
      }
    } catch (artworkError) {
      console.error("DownloadManager: Error saving artwork:", artworkError);
      // Continue - song is still downloaded even if artwork fails
    }
  }

  /**
   * Checks if a song is downloaded
   * @param {string} songId - Song ID
   * @returns {Promise<boolean>} - Download status
   */
  static async isDownloaded(songId) {
    try {
      return await StorageManager.isSongDownloaded(songId);
    } catch (error) {
      console.error("DownloadManager: Error checking download status:", error);
      return false;
    }
  }

  /**
   * Gets the best quality download URL from song data
   * @param {Object} song - Song object
   * @returns {Promise<string|null>} - Download URL or null
   */
  static async getDownloadUrl(song) {
    try {
      const quality = await getIndexQuality();

      // Method 1: downloadUrl array (most common)
      if (song.downloadUrl && Array.isArray(song.downloadUrl)) {
        if (song.downloadUrl[quality]?.url) {
          return song.downloadUrl[quality].url;
        }
        // Fallback to any available URL
        for (let i = song.downloadUrl.length - 1; i >= 0; i--) {
          if (song.downloadUrl[i]?.url) {
            return song.downloadUrl[i].url;
          }
        }
      }

      // Method 2: download_url array (alternative format)
      if (song.download_url && Array.isArray(song.download_url)) {
        if (song.download_url[quality]?.url) {
          return song.download_url[quality].url;
        }
        // Fallback to any available URL
        for (let i = song.download_url.length - 1; i >= 0; i--) {
          if (song.download_url[i]?.url) {
            return song.download_url[i].url;
          }
        }
      }

      // Method 3: url array (from EachSongCard format)
      if (song.url && Array.isArray(song.url)) {
        if (song.url[quality]?.url) {
          return song.url[quality].url;
        }
        // Fallback to any available URL
        for (let i = song.url.length - 1; i >= 0; i--) {
          if (song.url[i]?.url) {
            return song.url[i].url;
          }
        }
      }

      // Method 4: Direct URL string
      if (typeof song.url === 'string' && song.url.startsWith('http')) {
        return song.url;
      }

      console.error('DownloadManager: No valid download URL found in song data:', song);
      return null;

    } catch (error) {
      console.error('DownloadManager: Error getting download URL:', error);
      return null;
    }
  }

  /**
   * Removes a downloaded song
   * @param {string} songId - Song ID
   * @returns {Promise<boolean>} - Success status
   */
  static async removeSong(songId) {
    try {
      await StorageManager.removeDownloadedSongMetadata(songId);
      EventRegister.emit('download-removed', songId);
      return true;
    } catch (error) {
      console.error("DownloadManager: Error removing downloaded song:", error);
      return false;
    }
  }
}
