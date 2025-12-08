import TrackPlayer from 'react-native-track-player';
import { getRecommendedSongs } from '../Api/Recommended';
import youtubeStreamingService from './YouTubeStreamingService';
import dabMusicService from './DabMusicService';
import { getIndexQuality } from '../MusicPlayerFunctions';
import InnerTubeClient from '../Api/InnertubeClient';

/**
 * QueueManager - Centralized queue management with lazy stream loading
 * Handles recommendations-based queue building and on-demand stream fetching
 */
class QueueManager {
    constructor() {
        this.prefetchInProgress = false;
        this.streamCache = new Map(); // Cache fetched streams to avoid re-fetching
    }

    /**
     * Build queue from recommendations for a given song
     * @param {string} songId - The song ID to get recommendations for
     * @param {string} source - Source of the song (ytmusic, saavn, dab)
     * @param {number} limit - Number of recommendations to fetch (default: 10)
     * @returns {Promise<Array>} Array of song objects for queue
     */
    async buildQueueFromRecommendations(songId, source = 'saavn', limit = 10) {
        try {
            console.log(`🎵 Building queue from recommendations for song: ${songId}, source: ${source}`);

            // For YouTube Music songs, use YouTube's own recommendations API
            if (source === 'ytmusic' || (typeof songId === 'string' && songId.length === 11)) {

                const nextData = await InnerTubeClient.getNext(songId);


                if (!nextData || !nextData.items || nextData.items.length === 0) {
                    return [];
                }


                // Map YouTube recommendations to queue format
                // Filter out items without valid videoId first
                const queueSongs = nextData.items
                    .filter(song => {
                        const videoId = song.videoId || song.id;
                        // Validate videoId exists and is a valid YouTube video ID format
                        return videoId && typeof videoId === 'string' && videoId.length === 11;
                    })
                    .slice(0, limit)
                    .map(song => {
                        const videoId = song.videoId || song.id;

                        // Use high-resolution YouTube thumbnail URL (maxresdefault = 1280x720)
                        // Fallback chain: artwork -> highResThumbnail -> construct from videoId -> thumbnail
                        let artworkUri = song.artwork || song.highResThumbnail;

                        if (!artworkUri && videoId) {
                            // Construct highest quality YouTube thumbnail URL
                            artworkUri = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
                        }

                        // Final fallbacks
                        if (!artworkUri) {
                            if (song.thumbnails && Array.isArray(song.thumbnails)) {
                                const bestThumb = song.thumbnails[song.thumbnails.length - 1];
                                artworkUri = bestThumb?.url || '';
                            } else if (song.thumbnail) {
                                artworkUri = song.thumbnail;
                            } else if (song.image && typeof song.image === 'string') {
                                artworkUri = song.image;
                            }
                        }

                        return {
                            url: `https://music.youtube.com/watch?v=${videoId}`, // Valid URL placeholder - will be replaced with stream
                            title: song.title || song.name || 'Unknown',
                            artist: song.artist || 'Unknown Artist',
                            artwork: artworkUri,
                            image: artworkUri,
                            duration: song.duration || 0,
                            id: videoId,
                            language: 'unknown',
                            downloadUrl: videoId,
                            source: 'ytmusic',
                            isYTMusic: true,
                            _needsStream: true // Mark for on-demand fetching
                        };
                    });

                console.log(`✅ QueueManager: Built ${queueSongs.length} queue songs from recommendations`);

                return queueSongs;
            }

            // For Saavn songs, use Saavn recommendations API
            const recommendationsData = await getRecommendedSongs(songId);

            if (!recommendationsData?.data || recommendationsData.data.length === 0) {
                console.log('⚠️ No recommendations found for song:', songId);
                return [];
            }

            const recommendations = recommendationsData.data.slice(0, limit);
            console.log(`✅ Found ${recommendations.length} recommendations`);

            // Get quality index for URL selection
            const qualityIndex = await getIndexQuality();

            // Map recommendations to queue format (without stream URLs)
            const queueSongs = recommendations.map(song => {
                let songUrl = '';

                // Extract URL based on quality
                if (song.downloadUrl && Array.isArray(song.downloadUrl)) {
                    if (song.downloadUrl[qualityIndex]?.url) {
                        songUrl = song.downloadUrl[qualityIndex].url;
                    } else if (song.downloadUrl[0]?.url) {
                        songUrl = song.downloadUrl[0].url;
                    }
                } else if (song.download_url && Array.isArray(song.download_url)) {
                    if (song.download_url[qualityIndex]?.url) {
                        songUrl = song.download_url[qualityIndex].url;
                    } else if (song.download_url[0]?.url) {
                        songUrl = song.download_url[0].url;
                    }
                }

                // Extract artwork
                let artworkUri = '';
                if (typeof song.image === 'string') {
                    artworkUri = song.image;
                } else if (song.image && Array.isArray(song.image)) {
                    const imageItem = song.image[2] || song.image[song.image.length - 1] || song.image[0];
                    artworkUri = imageItem?.url || imageItem?.link || '';
                }

                return {
                    url: songUrl,
                    title: song.name || song.title || 'Unknown',
                    artist: this._formatArtist(song.artists?.primary || song.artist),
                    artwork: artworkUri,
                    image: artworkUri,
                    duration: song.duration || 0,
                    id: song.id,
                    language: song.language || '',
                    downloadUrl: song.downloadUrl || song.download_url || [],
                    source: 'saavn',
                    _needsStream: false
                };
            });

            return queueSongs;
        } catch (error) {
            console.error('❌ Error building queue from recommendations:', error);
            console.error('❌ Error stack:', error.stack);
            return [];
        }
    }

    /**
     * Prefetch stream URL for the next track in queue
     * DELEGATES to SmartPrefetchManager which correctly handles track replacement
     * NOTE: updateMetadataForTrack CANNOT update URLs, must remove/re-add track
     */
    async prefetchNextTrack() {
        // Delegate to SmartPrefetchManager - it handles this correctly
        // by removing and re-adding tracks (updateMetadataForTrack doesn't work for URLs)
        try {
            const smartPrefetchManager = require('./SmartPrefetchManager').default;
            const currentIndex = await TrackPlayer.getActiveTrackIndex();
            if (currentIndex !== null && currentIndex !== undefined) {
                await smartPrefetchManager._prefetchNextSong(currentIndex);
            }
        } catch (error) {
            console.error('Error in prefetchNextTrack delegation:', error.message);
        }
    }

    /**
     * Fetch stream URL for a specific track by index
     * Used when user skips to a track that hasn't been streamed yet
     * @param {number} trackIndex - Index of track in queue
     * @param {AbortSignal} signal - Optional abort signal
     */
    async fetchStreamForTrack(trackIndex, signal = null) {
        try {
            const queue = await TrackPlayer.getQueue();

            if (trackIndex < 0 || trackIndex >= queue.length) {
                console.error('❌ Invalid track index:', trackIndex);
                return null;
            }

            const track = queue[trackIndex];

            // Check cache first
            if (this.streamCache.has(track.id)) {
                const cached = this.streamCache.get(track.id);
                console.log(`✅ Using cached stream for: ${track.title}`);
                return cached;
            }

            console.log(`🔄 Fetching stream on-demand for: ${track.title}`);
            const streamData = await this._fetchStreamForSong(track, signal);

            if (streamData && streamData.url) {
                // Validate the URL
                if (streamData.url.startsWith('ytmusic://') || streamData.url.startsWith('http') === false) {
                    console.error(`❌ Invalid stream URL format: ${streamData.url}`);
                    return null;
                }

                // Update track in queue with the real stream URL
                await TrackPlayer.updateMetadataForTrack(trackIndex, {
                    url: streamData.url,
                    headers: streamData.headers,
                    userAgent: streamData.headers?.['User-Agent']
                });

                // Cache the stream (will expire in 2 minutes)
                this.streamCache.set(track.id, streamData);
                console.log(`✅ Fetched and updated stream for: ${track.title}`);
                return streamData;
            }

            console.error(`❌ No stream data returned for: ${track.title}`);
            return null;
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log(`🚫 Stream fetch aborted for track ${trackIndex}`);
            } else {
                console.error('❌ Error fetching stream for track:', error);
            }
            return null;
        }
    }

    /**
     * Internal method to fetch stream for a song based on its source
     * @private
     * @param {Object} song - Song object
     * @param {AbortSignal} signal - Optional abort signal
     */
    async _fetchStreamForSong(song, signal = null) {
        try {
            const isYouTubeSong = song.id && typeof song.id === 'string' &&
                song.id.length === 11 && !song.isLocalMusic;
            const isDabSong = song.isDabTrack || song.source === 'dab';

            if (isYouTubeSong) {
                // Use streamFetchManager for caching and deduplication
                const streamFetchManager = require('./StreamFetchManager').default;
                const streamData = await streamFetchManager.fetchStream(
                    song.id,
                    async (videoId) => {
                        return await youtubeStreamingService.getStreamUrl(videoId);
                    },
                    signal
                );

                if (streamData && streamData.url) {
                    return {
                        url: streamData.url,
                        headers: streamData.headers,
                        thumbnail: streamData.thumbnail,
                        duration: streamData.duration,
                        title: streamData.title
                    };
                }
            } else if (isDabSong) {
                await dabMusicService.initialize();
                const streamUrl = await dabMusicService.getStreamUrl(song.id);
                if (streamUrl) {
                    return {
                        url: streamUrl,
                        headers: {},
                    };
                }
            }

            return null;
        } catch (error) {
            if (error.message === 'AbortError' || error.name === 'AbortError') {
                console.log(`🚫 Stream fetch aborted for: ${song.title}`);
            } else {
                console.error('❌ Error in _fetchStreamForSong:', error);
            }
            return null;
        }
    }

    /**
     * Format artist data to string
     * @private
     */
    _formatArtist(artistData) {
        if (!artistData) return 'Unknown Artist';
        if (typeof artistData === 'string') return artistData;
        if (Array.isArray(artistData)) {
            return artistData.map(a => a.name || a).join(', ');
        }
        if (artistData.name) return artistData.name;
        return 'Unknown Artist';
    }

    /**
     * Start monitoring queue and fetch more recommendations when near end
     * @param {string} originalVideoId - The original video ID to base recommendations on
     */
    startContinuousQueueMonitor(originalVideoId) {
        // Store the video ID for fetching more recommendations
        this.currentVideoId = originalVideoId;
        this.isFetchingMore = false;
        this.fetchThreshold = 5; // Fetch more when 5 songs left in queue

        // Set up track change listener
        if (!this.trackChangeSubscription) {
            console.log('📡 Starting continuous queue monitor');
            this.trackChangeSubscription = TrackPlayer.addEventListener(
                'playback-active-track-changed',
                this._onTrackChange.bind(this)
            );
        }
    }

    /**
     * Stop the continuous queue monitor
     */
    stopContinuousQueueMonitor() {
        if (this.trackChangeSubscription) {
            console.log('🛑 Stopping continuous queue monitor');
            this.trackChangeSubscription.remove();
            this.trackChangeSubscription = null;
        }
        this.currentVideoId = null;
        this.isFetchingMore = false;
    }

    /**
     * Handler for track change events - checks if we need more recommendations
     * @private
     */
    async _onTrackChange(event) {
        if (this.isFetchingMore || !this.currentVideoId) return;

        try {
            const queue = await TrackPlayer.getQueue();
            const currentIndex = event.index ?? (await TrackPlayer.getActiveTrackIndex());

            if (currentIndex === null || currentIndex === undefined) return;

            const songsRemaining = queue.length - currentIndex - 1;

            console.log(`📊 Queue status: ${songsRemaining} songs remaining after current`);

            // If less than threshold songs remaining, fetch more
            if (songsRemaining <= this.fetchThreshold) {
                this.isFetchingMore = true;
                console.log(`🔄 Near end of queue! Fetching more recommendations...`);

                // Get the last song in queue to base recommendations on
                const lastSong = queue[queue.length - 1];
                const videoIdForRecs = lastSong?.id || this.currentVideoId;

                try {
                    // Import AddSongsToQueue dynamically to avoid circular dependencies
                    const { AddSongsToQueue } = require('../MusicPlayerFunctions');

                    const recommendations = await this.buildQueueFromRecommendations(
                        videoIdForRecs,
                        'ytmusic',
                        20
                    );

                    if (recommendations && recommendations.length > 0) {
                        // Filter out songs already in queue
                        const existingIds = new Set(queue.map(s => s.id));
                        const newSongs = recommendations.filter(rec => !existingIds.has(rec.id));

                        if (newSongs.length > 0) {
                            await AddSongsToQueue(newSongs);
                            console.log(`✅ Added ${newSongs.length} more songs to extend queue!`);
                        } else {
                            console.log('⚠️ No new songs to add (all duplicates)');
                        }
                    }
                } catch (error) {
                    console.error('❌ Error fetching more recommendations:', error);
                }

                this.isFetchingMore = false;
            }
        } catch (error) {
            console.error('❌ Error in queue monitor:', error);
            this.isFetchingMore = false;
        }
    }

    /**
     * Clear the stream cache
     */
    clearCache() {
        this.streamCache.clear();
        console.log('🗑️ Stream cache cleared');
    }
}

// Export singleton instance
const queueManager = new QueueManager();
export default queueManager;
