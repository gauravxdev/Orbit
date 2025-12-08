import { Dimensions, View } from "react-native";
import React, { memo, useContext, useCallback, useState, useEffect } from "react";
import { PlainText } from "../Global/PlainText";
import { SmallText } from "../Global/SmallText";
import Animated, { FadeIn } from "react-native-reanimated";
import { GestureDetector, Gesture, GestureHandlerRootView } from "react-native-gesture-handler";
import { PlayPauseButton } from "./PlayPauseButton";
import { NextSongButton } from "./NextSongButton";
import { PreviousSongButton } from "./PreviousSongButton";
import { LikeSongButton } from "./LikeSongButton";
import FastImage from "react-native-fast-image";
import { useActiveTrack, useProgress } from "react-native-track-player";
import { PlayNextSong, PlayPreviousSong } from "../../MusicPlayerFunctions";
import Context from "../../Context/Context";
import TrackPlayer from "react-native-track-player";
import { Pressable } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { useNavigation, useTheme } from "@react-navigation/native";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Function to get high quality artwork URL
const getHighQualityArtwork = (artworkUrl, track = null) => {
  if (!artworkUrl) {
    // Check if this is a local track and use Music.jpeg
    if (track && (track.isLocal || track.sourceType === 'mymusic' || track.path ||
      (track.url && (track.url.startsWith('file://') || track.url.includes('content://') || track.url.includes('/storage/'))))) {
      return require('../../Images/Music.jpeg');
    }
    return "https://htmlcolorcodes.com/assets/images/colors/gray-color-solid-background-1920x1080.png";
  }

  try {
    // For local files, return as is
    if (artworkUrl.startsWith('file://')) {
      return artworkUrl;
    }

    // Special handling for JioSaavn CDN
    if (artworkUrl.includes('saavncdn.com')) {
      // Replace any size with 1000x1000 for highest quality
      return artworkUrl.replace(/50x50|150x150|500x500|1000x1000/g, '1000x1000');
    }

    // For other URLs, try to add quality parameter
    try {
      const url = new URL(artworkUrl);
      // Set quality to maximum
      url.searchParams.set('quality', '100');
      return url.toString();
    } catch (e) {
      // If URL parsing fails, try direct string manipulation
      if (artworkUrl.includes('?')) {
        return `${artworkUrl}&quality=100`;
      } else {
        return `${artworkUrl}?quality=100`;
      }
    }
  } catch (error) {
    console.error('Error processing artwork URL:', error);
    return artworkUrl; // Return original URL as fallback
  }
};

export const MinimizedMusic = memo(({ setIndex, color }) => {
  const { position, duration } = useProgress()
  const { setPreviousScreen, setMusicPreviousScreen, setCurrentPlaylistData } = useContext(Context);
  const [isOffline, setIsOffline] = useState(false);
  const [localTracks, setLocalTracks] = useState([]);
  const navigation = useNavigation();
  const { colors } = useTheme(); // Get theme colors

  // Check network status
  useEffect(() => {
    const checkConnection = async () => {
      const state = await NetInfo.fetch();
      setIsOffline(!state.isConnected);
    };

    checkConnection();
    const unsubscribe = NetInfo.addEventListener(state => {
      setIsOffline(!state.isConnected);
    });

    return () => unsubscribe();
  }, []);

  // Function to extract and save playlist ID from navigation state
  const extractPlaylistInfo = useCallback((navState) => {
    try {
      if (!navState || !navState.routes || navState.routes.length === 0) {
        console.log('Navigation state is invalid or empty');
        return null;
      }

      // Check if we're in the Playlist screen
      const currentTabRoute = navState.routes[navState.index];
      if (!currentTabRoute) {
        console.log('Current tab route is undefined');
        return null;
      }

      // 1. Check if current screen is directly the Playlist
      if (currentTabRoute.name === 'Playlist' && currentTabRoute.params) {
        // Validate that we have the required id parameter
        if (!currentTabRoute.params.id) {
          console.log('Playlist params found but missing id');
          return null;
        }

        return {
          id: currentTabRoute.params.id,
          name: currentTabRoute.params.name || 'Playlist',
          image: currentTabRoute.params.image || '',
          follower: currentTabRoute.params.follower || ''
        };
      }

      // 2. Check if there's a nested navigation state with Playlist
      const nestedState = currentTabRoute.state;
      if (nestedState && nestedState.routes && nestedState.routes.length > 0) {
        if (nestedState.index >= nestedState.routes.length) {
          console.log('Nested state index out of bounds');
          return null;
        }

        const activeNestedRoute = nestedState.routes[nestedState.index];
        if (!activeNestedRoute) {
          console.log('Active nested route is undefined');
          return null;
        }

        // Check if the active nested route is a Playlist
        if (activeNestedRoute.name === 'Playlist' && activeNestedRoute.params) {
          // Validate that we have the required id parameter
          if (!activeNestedRoute.params.id) {
            console.log('Nested playlist params found but missing id');
            return null;
          }

          return {
            id: activeNestedRoute.params.id,
            name: activeNestedRoute.params.name || 'Playlist',
            image: activeNestedRoute.params.image || '',
            follower: activeNestedRoute.params.follower || ''
          };
        }

        // 3. Check if there's even deeper nesting
        if (activeNestedRoute.state && activeNestedRoute.state.routes && activeNestedRoute.state.routes.length > 0) {
          if (activeNestedRoute.state.index >= activeNestedRoute.state.routes.length) {
            console.log('Deep nested state index out of bounds');
            return null;
          }

          const deepNestedRoute = activeNestedRoute.state.routes[activeNestedRoute.state.index];
          if (!deepNestedRoute) {
            console.log('Deep nested route is undefined');
            return null;
          }

          if (deepNestedRoute.name === 'Playlist' && deepNestedRoute.params) {
            // Validate that we have the required id parameter
            if (!deepNestedRoute.params.id) {
              console.log('Deep nested playlist params found but missing id');
              return null;
            }

            return {
              id: deepNestedRoute.params.id,
              name: deepNestedRoute.params.name || 'Playlist',
              image: deepNestedRoute.params.image || '',
              follower: deepNestedRoute.params.follower || ''
            };
          }
        }
      }

      return null;
    } catch (error) {
      console.error('Error extracting playlist info:', error);
      return null;
    }
  }, []);

  // Function to save current screen and open player
  const saveCurrentScreenAndOpenPlayer = () => {
    try {
      // Get current route navigation state to determine where we are
      const state = navigation.getState();
      console.log('NAVIGATION STATE:', JSON.stringify(state, null, 2));

      // Extract the real path from the navigation state
      let screenPath = '';
      let customPlaylistParams = null;

      // Use a more reliable approach to find the current screen
      if (state && state.routes && state.routes.length > 0) {
        // Find the MainRoute container
        const mainRoute = state.routes.find(route => route.name === 'MainRoute');
        if (mainRoute && mainRoute.state && mainRoute.state.routes) {
          // Find the active tab in the bottom tab navigator
          const tabState = mainRoute.state;
          const activeTabIndex = tabState.index;

          if (activeTabIndex !== undefined && tabState.routes && tabState.routes.length > activeTabIndex) {
            const activeTab = tabState.routes[activeTabIndex];
            console.log(`Active tab: ${activeTab.name}`);

            // Start building the path with the tab name
            screenPath = activeTab.name;

            // Check if there's a nested stack within this tab
            if (activeTab.state && activeTab.state.routes) {
              const nestedState = activeTab.state;
              const activeNestedIndex = nestedState.index;

              if (activeNestedIndex !== undefined && nestedState.routes && nestedState.routes.length > activeNestedIndex) {
                const activeScreen = nestedState.routes[activeNestedIndex];
                console.log(`Active screen: ${activeScreen.name} in ${activeTab.name}`);

                // Add the active screen to the path
                screenPath = `${screenPath}/${activeScreen.name}`;

                // If we're in CustomPlaylistView, save its params
                if (activeScreen.name === 'CustomPlaylistView' && activeScreen.params) {
                  customPlaylistParams = activeScreen.params;
                  console.log('Captured CustomPlaylistView params:', customPlaylistParams);

                  // Also store in AsyncStorage for recovery
                  if (customPlaylistParams.playlistName && customPlaylistParams.songs) {
                    AsyncStorage.setItem('last_viewed_custom_playlist',
                      JSON.stringify({
                        name: customPlaylistParams.playlistName,
                        songs: customPlaylistParams.songs
                      })
                    ).catch(err => console.error('Failed to store playlist params:', err));
                  }
                }
              }
            }
          }
        }
      }

      // Log the extracted path
      console.log(`EXTRACTED PATH: ${screenPath}`);

      // Store the screen path for later use
      setMusicPreviousScreen(screenPath);

      // Set playlist data for display
      setCurrentPlaylistData(screenPath);

      // Open the fullscreen player
      setIndex(1);
    } catch (error) {
      console.error('Error in saveCurrentScreenAndOpenPlayer:', error);
      // Fallback: just open the player without saving the path
      setIndex(1);
    }
  };

  // Function to play next offline song
  const playNextOfflineSong = useCallback(async () => {
    if (isOffline && localTracks.length > 0) {
      try {
        const queue = await TrackPlayer.getQueue();
        const currentTrack = await TrackPlayer.getActiveTrack();
        if (!currentTrack || queue.length === 0) return;

        // Find current track index
        const currentIndex = queue.findIndex(track => track.id === currentTrack.id);
        if (currentIndex === -1) return;

        // Calculate next track index (with wrap-around)
        const nextIndex = (currentIndex + 1) % queue.length;

        // Skip to the next track
        await TrackPlayer.skip(nextIndex);
        await TrackPlayer.play();
      } catch (error) {
        console.error('Error playing next offline song:', error);
      }
    } else {
      // If online, use the regular function
      PlayNextSong();
    }
  }, [isOffline, localTracks]);

  // Function to play previous offline song
  const playPreviousOfflineSong = useCallback(async () => {
    if (isOffline && localTracks.length > 0) {
      try {
        const queue = await TrackPlayer.getQueue();
        const currentTrack = await TrackPlayer.getActiveTrack();
        if (!currentTrack || queue.length === 0) return;

        // Find current track index
        const currentIndex = queue.findIndex(track => track.id === currentTrack.id);
        if (currentIndex === -1) return;

        // Calculate previous track index (with wrap-around)
        const prevIndex = (currentIndex - 1 + queue.length) % queue.length;

        // Skip to the previous track
        await TrackPlayer.skip(prevIndex);
        await TrackPlayer.play();
      } catch (error) {
        console.error('Error playing previous offline song:', error);
      }
    } else {
      // If online, use the regular function
      PlayPreviousSong();
    }
  }, [isOffline, localTracks]);

  const pan = Gesture.Pan();
  pan.onFinalize((e) => {
    if (e.translationX > 100) {
      isOffline ? playPreviousOfflineSong() : PlayPreviousSong();
    } else if (e.translationX < -100) {
      isOffline ? playNextOfflineSong() : PlayNextSong();
    } else {
      // Save the current screen before opening fullscreen player
      saveCurrentScreenAndOpenPlayer();
    }
  });

  function TotalCompletedInpercent() {
    if (!duration || duration <= 0) return 0;
    const progress = Math.min(Math.max((position || 0) / duration, 0), 1) * 100;
    return Math.round(progress); // Round to avoid floating point precision issues
  }

  const size = Dimensions.get("window").height
  const currentPlaying = useActiveTrack()

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Animated.View
        entering={FadeIn}
        style={{
          flexDirection: 'row',
          justifyContent: "space-between",
          height: 80,
          paddingHorizontal: 15,
          paddingVertical: 15,
          alignItems: "center",
          gap: 10,
          backgroundColor: color || colors.musicPlayerBg,
        }}>
        <GestureDetector gesture={pan}>
          <View style={{
            flexDirection: "row",
            flex: 1,
          }}>
            <FastImage
              source={
                typeof getHighQualityArtwork(currentPlaying?.artwork, currentPlaying) === 'string'
                  ? { uri: getHighQualityArtwork(currentPlaying?.artwork, currentPlaying) }
                  : getHighQualityArtwork(currentPlaying?.artwork, currentPlaying)
              }
              style={{
                height: (size * 0.09) - 25,
                width: (size * 0.09) - 25,
                borderRadius: 8,
                marginRight: 6,
                alignSelf: 'center',
              }}
            />
            <View style={{
              flex: 1,
              height: (size * 0.1) - 25,
              justifyContent: 'center',
              paddingRight: 2,
              minWidth: 0,
              marginLeft: 2,
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <PlainText
                  text={currentPlaying?.title ?? "No music :("}
                  style={{
                    color: colors.text,
                    fontSize: 13,
                    flexShrink: 1,
                  }}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                />
              </View>
              <SmallText
                text={currentPlaying?.artist?.length > 20 ? currentPlaying.artist.substring(0, 20) + '...' : currentPlaying?.artist ?? "Explore now!"}
                maxLine={1}
                style={{
                  color: colors.textSecondary,
                  fontSize: 10,
                  marginTop: 1,
                  includeFontPadding: false
                }}
              />
            </View>
          </View>
        </GestureDetector>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <View style={{ marginRight: 0 }}>
            <LikeSongButton size={20} color={colors.icon} />
          </View>
          <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
            <Pressable onPress={isOffline ? playPreviousOfflineSong : PlayPreviousSong}>
              <PreviousSongButton color={colors.icon} />
            </Pressable>
            <PlayPauseButton isplaying={false} color={colors.icon} />
            <Pressable onPress={isOffline ? playNextOfflineSong : PlayNextSong}>
              <NextSongButton color={colors.icon} />
            </Pressable>
          </View>
        </View>
      </Animated.View>
      <View style={{ height: 2, width: `${TotalCompletedInpercent()}%`, backgroundColor: colors.primary }} />
    </GestureHandlerRootView>
  );
});
