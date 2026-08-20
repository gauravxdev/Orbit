/**
 * BatchDownloadService
 *
 * Manages batch downloading of songs from playlists and albums.
 * Downloads through the shared downloadSongNow() helper.
 * Supports YTMusic, DAB, and Saavn sources.
 */

import { ToastAndroid } from 'react-native';
import { StorageManager } from './StorageManager';
import EventRegister from './EventRegister';
import {
  downloadSongNow,
  normalizeSongForDownload,
} from '../hooks/useDownloadSong';

class BatchDownloadService {
  static isDownloading = false;
  static shouldCancel = false;
  static currentProgress = {
    current: 0,
    total: 0,
    songTitle: '',
    percent: 0,
  };

  /**
   * Format song data for unified download service
   * Handles different song object structures from playlists/albums
   */
  /**
   * Delegates to the shared normaliser so batch downloads and single
   * downloads build identical payloads (and detect source identically).
   */
  static formatSongForDownload(song) {
    return normalizeSongForDownload(song);
  }


  /**
   * Download all songs from a playlist
   * @param {Array} songs - Array of song objects
   * @param {string} playlistName - Name of the playlist (for display)
   * @returns {Promise<{success: number, failed: number, skipped: number}>}
   */
  static async downloadPlaylist(songs, playlistName) {
    return this.downloadBatch(songs, playlistName, 'playlist');
  }

  /**
   * Download all songs from an album
   * @param {Array} songs - Array of song objects
   * @param {string} albumName - Name of the album (for display)
   * @returns {Promise<{success: number, failed: number, skipped: number}>}
   */
  static async downloadAlbum(songs, albumName) {
    return this.downloadBatch(songs, albumName, 'album');
  }

  /**
   * Core batch download logic
   */
  static async downloadBatch(songs, collectionName, type = 'playlist') {
    if (this.isDownloading) {
      ToastAndroid.show(
        'A download is already in progress',
        ToastAndroid.SHORT
      );
      return { success: 0, failed: 0, skipped: 0 };
    }

    if (!songs || songs.length === 0) {
      ToastAndroid.show(
        `No songs to download in this ${type}`,
        ToastAndroid.SHORT
      );
      return { success: 0, failed: 0, skipped: 0 };
    }

    this.isDownloading = true;
    this.shouldCancel = false;

    const results = {
      success: 0,
      failed: 0,
      skipped: 0,
    };

    // Emit start event
    EventRegister.emit('batch-download-started', {
      total: songs.length,
      name: collectionName,
      type,
    });

    ToastAndroid.show(
      `Downloading ${songs.length} songs from ${collectionName}...`,
      ToastAndroid.SHORT
    );

    try {
      for (let i = 0; i < songs.length; i++) {
        // Check for cancellation
        if (this.shouldCancel) {
          ToastAndroid.show('Download cancelled', ToastAndroid.SHORT);
          break;
        }

        const song = songs[i];
        const formattedSong = this.formatSongForDownload(song);

        if (!formattedSong || !formattedSong.id) {
          console.warn('[BatchDownload] Skipping invalid song:', song);
          results.failed++;
          continue;
        }

        // Update progress
        this.currentProgress = {
          current: i + 1,
          total: songs.length,
          songTitle: formattedSong.title,
          percent: Math.round(((i + 1) / songs.length) * 100),
        };

        // Emit progress event
        EventRegister.emit('batch-download-progress', this.currentProgress);

        // Check if already downloaded
        const isAlreadyDownloaded = await StorageManager.isSongDownloaded(
          formattedSong.id
        );
        if (isAlreadyDownloaded) {
          results.skipped++;
          continue;
        }

        // Download the song
        try {
          const success = await downloadSongNow(
            formattedSong,
            (percent) => {
              // Per-song progress callback - emit detailed progress
              EventRegister.emit('batch-download-song-progress', {
                ...this.currentProgress,
                songPercent: percent,
              });
            }
          );

          if (success) {
            results.success++;
          } else {
            results.failed++;
          }
        } catch (downloadError) {
          console.error(
            `[BatchDownload] Failed to download ${formattedSong.title}:`,
            downloadError
          );
          results.failed++;
        }

        // Small delay between downloads to avoid overwhelming the system
        if (i < songs.length - 1 && !this.shouldCancel) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    } catch (error) {
      console.error('[BatchDownload] Batch download error:', error);
      ToastAndroid.show('Download error occurred', ToastAndroid.SHORT);
    } finally {
      this.isDownloading = false;
      this.currentProgress = {
        current: 0,
        total: 0,
        songTitle: '',
        percent: 0,
      };

      // Emit completion event
      EventRegister.emit('batch-download-complete', results);

      // Show completion toast
      if (results.success > 0 || results.skipped > 0) {
        let message = '';
        if (results.success > 0) {
          message += `${results.success} downloaded`;
        }
        if (results.skipped > 0) {
          message += message
            ? `, ${results.skipped} already had`
            : `${results.skipped} already downloaded`;
        }
        if (results.failed > 0) {
          message += message
            ? `, ${results.failed} failed`
            : `${results.failed} failed`;
        }
        ToastAndroid.show(message, ToastAndroid.LONG);
      } else if (results.failed > 0) {
        ToastAndroid.show(
          `Failed to download ${results.failed} songs`,
          ToastAndroid.SHORT
        );
      }
    }

    return results;
  }

  /**
   * Cancel the current batch download
   */
  static cancelDownload() {
    if (this.isDownloading) {
      this.shouldCancel = true;
      ToastAndroid.show('Cancelling download...', ToastAndroid.SHORT);
    }
  }

  /**
   * Get current download progress
   */
  static getProgress() {
    return {
      isDownloading: this.isDownloading,
      ...this.currentProgress,
    };
  }

  /**
   * Check if a batch download is in progress
   */
  static isInProgress() {
    return this.isDownloading;
  }
}

export default BatchDownloadService;
