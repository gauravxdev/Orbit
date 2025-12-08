import React, { useState, useEffect, useContext, useCallback, useRef } from 'react';
import { ShowLyrics } from './ShowLyrics';
import { GetLyricsButton } from './GetLyricsButton';
import { getLyricsFromLrcLib } from '../../Api/Songs';

// Constants for error messages
const ERROR_MESSAGES = {
  NO_TRACK: 'No song playing or missing track information. Please play a song first.',
  OFFLINE: 'You are offline. Lyrics are not available in offline mode.',
  NOT_FOUND: 'No Lyrics Found\nSorry, we couldn\'t find lyrics for this song.',
  EMPTY_LYRICS: 'No Lyrics Found\nLyrics data is empty for this song.',
  FETCH_ERROR: 'Could not fetch lyrics. Please try again.'
};

/**
 * Handles fetching and displaying lyrics for the currently playing track
 */
export const LyricsHandler = ({
  currentPlayingTrack,
  isOffline,
  onLyricsVisibilityChange,
  currentArtworkSource,
  iconColor,
}) => {
  const [showDialog, setShowDialog] = useState(false);
  const [lyric, setLyric] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const isFetchingRef = useRef(false); // Prevent multiple simultaneous fetches

  // Notify parent component about dialog visibility changes
  useEffect(() => {
    onLyricsVisibilityChange?.(showDialog);
  }, [showDialog, onLyricsVisibilityChange]);

  /**
   * Fetches lyrics for the current track
   */
  const fetchLyrics = useCallback(async () => {
    // Prevent multiple simultaneous fetches
    if (isFetchingRef.current) {
      return;
    }

    isFetchingRef.current = true;

    // Open modal immediately for instant feedback
    setShowDialog(true);
    setIsLoading(true);
    setLyric(null);

    if (!currentPlayingTrack?.title || !currentPlayingTrack?.artist) {
      setLyric({ plain: ERROR_MESSAGES.NO_TRACK });
      setIsLoading(false);
      isFetchingRef.current = false;
      return;
    }

    try {
      if (isOffline) {
        setLyric({ plain: ERROR_MESSAGES.OFFLINE });
        setIsLoading(false);
        isFetchingRef.current = false;
        return;
      }

      const { artist, title } = currentPlayingTrack;
      const lyricsData = await getLyricsFromLrcLib(artist, title);

      if (!lyricsData?.success) {
        setLyric({ plain: lyricsData?.message || ERROR_MESSAGES.NOT_FOUND });
        return;
      }

      const { syncedLyrics, plainLyrics } = lyricsData.data || {};

      if (syncedLyrics) {
        setLyric({ synced: syncedLyrics, plain: plainLyrics });
      } else if (plainLyrics) {
        setLyric({ plain: plainLyrics });
      } else {
        setLyric({ plain: ERROR_MESSAGES.EMPTY_LYRICS });
      }
    } catch (error) {
      console.error('Error fetching lyrics:', error);
      setLyric({ plain: ERROR_MESSAGES.FETCH_ERROR });
    } finally {
      setIsLoading(false);
      isFetchingRef.current = false;
    }
  }, [currentPlayingTrack, isOffline]);

  return (
    <>
      <GetLyricsButton onPress={fetchLyrics} color={iconColor} />
      <ShowLyrics
        ShowDailog={showDialog}
        Loading={isLoading}
        Lyric={lyric}
        setShowDailog={setShowDialog}
        currentArtworkSource={currentArtworkSource}
      />
    </>
  );
};

// Add prop type validation if needed
// LyricsHandler.propTypes = {
//   currentPlayingTrack: PropTypes.shape({
//     title: PropTypes.string,
//     artist: PropTypes.string,
//     id: PropTypes.string,
//   }),
//   isOffline: PropTypes.bool,
//   onLyricsVisibilityChange: PropTypes.func,
//   currentArtworkSource: PropTypes.any,
// };
