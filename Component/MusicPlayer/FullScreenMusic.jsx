import React, { useState, useContext, useMemo, useCallback } from "react";
import { Dimensions, ImageBackground, View, StyleSheet, StatusBar, InteractionManager } from "react-native";
import LinearGradient from "react-native-linear-gradient";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useActiveTrack } from "react-native-track-player";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "react-native-paper";
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import SongInfoModal from './SongInfoModal';

import { Spacer } from "../Global/Spacer";
import ProgressBar from "./ProgressBar";
import { LikeSongButton } from "./LikeSongButton";
import QueueBottomSheet from "./QueueBottomSheet";
import { SleepTimerButton } from "./SleepTimer";
import { LyricsHandler } from "./LyricsHandler";
import { AlbumArtworkDisplay } from "./AlbumArtworkDisplay";
import { SongInfoDisplay } from "./SongInfoDisplay";
import { PlaybackControls } from "./PlaybackControls";
import { OfflineBanner, QualityIndicator, LocalTracksList, useOffline } from "../Offline";
import { useThemeManager } from "./ThemeManager";
import { TidalSourceSwitcher, useTidalIntegration } from "./TidalIntegration";
import { useNavigationHandler, BackButtonHandler } from "./NavigationHandler";

import { useLocalTracks, LocalTracksErrorBoundary } from "./LocalTracks";
import {
  FullScreenMusicMenuButton,
  FullScreenMusicMenuModal,
  useFullScreenMusicMenu,
} from "./FullScreenMusicMenu";

import Context from "../../Context/Context";
import useDynamicArtwork from "../../hooks/useDynamicArtwork.js";
import { SmartDownloadControl } from "../Download/DownloadControl";
import {
  Surface,
  IconButton,
  Portal,
  Modal,
} from "react-native-paper";

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: "center",
  },
  gradientContainer: {
    flex: 1,
    alignItems: "center",
    width: "100%",
    justifyContent: 'space-between',
    paddingBottom: 0,
  },
  bottomGradientWrapper: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: Dimensions.get("window").height * 0.6,
    zIndex: 0,
  },
  bottomGradient: {
    flex: 1,
  },
  iconContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4, // Reduced gap between icons
  },
  iconWrapper: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    margin: 0,
    padding: 0,
  },
  iconButton: {
    margin: 0,
    padding: 0,
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    // Adjust vertical alignment for the icons
    transform: [{ translateY: 1 }],
  },
  headerContainer: {
    width: "100%",
    padding: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    zIndex: 2,
  },
  closeButton: {
    margin: 0,
    backgroundColor: "transparent",
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    zIndex: 2,
  },
  albumSurface: {
    elevation: 4,
    borderRadius: 12,
    overflow: "hidden",
    marginVertical: 16,
    backgroundColor: "transparent",
    zIndex: 2,
  },
  contentContainer: {
    width: "100%",
    paddingHorizontal: 16,
    flex: 1,
    justifyContent: "flex-start",
    paddingTop: 8,
    zIndex: 2,
  },
  bottomControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingVertical: 8,
    marginTop: 16,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  bottomBarContainer: {
    position: 'absolute',
    right: 20,
    zIndex: 10,
    // Positioned very close to the bottom
    bottom: '2%', // Position 2% from bottom for better placement
  },
  infoBarContainer: {
    position: 'absolute',
    left: 20,
    zIndex: 10,
    // Match the same position as the menu icon
    bottom: '2%',
  },
  barsButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  backgroundImage: {
    flex: 1,
  },
  fallbackBackground: {
    flex: 1,
  },
});

export const FullScreenMusic = ({ Index, setIndex }) => {
  const width = Dimensions.get("window").width;
  const currentPlaying = useActiveTrack();
  const { musicPreviousScreen } = useContext(Context);
  const { getArtworkSourceFromHook } = useDynamicArtwork();
  // const [isLyricsActive, setIsLyricsActive] = useState(false); // REMOVED
  const [isInfoModalVisible, setIsInfoModalVisible] = useState(false);
  const [queueIndex, setQueueIndex] = useState(-1);
  const insets = useSafeAreaInsets();

  // Memoize artwork source to prevent excessive hook calls
  const currentArtworkSource = useMemo(() => {
    return getArtworkSourceFromHook(currentPlaying);
  }, [
    currentPlaying?.id,
    currentPlaying?.artwork,
    currentPlaying?.isLocal,
    currentPlaying?.sourceType,
    getArtworkSourceFromHook,
  ]);

  const {
    getTextColor,
    getBackgroundOverlay,
    getGradientColors,
    getBottomGradientColors,
  } =
    useThemeManager();
  const { isOffline } = useOffline();
  const { shouldShowTidalFeatures } = useTidalIntegration();
  const { handlePlayerClose } = useNavigationHandler({ musicPreviousScreen });
  const iconColor = getTextColor("icon");

  const {
    menuVisible,
    menuPosition,
    showMenu,
    closeMenu,
    getMenuOptions,
  } =
    useFullScreenMusicMenu(currentPlaying, isOffline);

  const {
    localTracks,
    showLocalTracks,
    playLocalTrack,
    closeLocalTracks,
    isLoading: localTracksLoading,
    error: localTracksError,
  } = useLocalTracks({ isOffline });

  /* Removed unused isLyricsActive state to prevent re-renders */

  const handlePlayerCloseAction = () => {
    setIndex(0);
    handlePlayerClose();
  };

  // Optimized handlers for instant button response
  const handleQueueToggle = useCallback(() => {
    // Immediate visual feedback - defer heavy work
    requestAnimationFrame(() => {
      setQueueIndex(prev => prev === -1 ? 1 : -1);
    });
  }, []);

  const handleQueueChange = useCallback((index) => {
    setQueueIndex(index);
  }, []);

  const handleInfoModalOpen = useCallback(() => {
    // Instant modal open without blocking
    requestAnimationFrame(() => {
      setIsInfoModalVisible(true);
    });
  }, []);

  const paperTheme = useTheme();
  const hasArtworkBackground = useMemo(() => {
    if (!currentArtworkSource) {
      return false;
    }
    if (typeof currentArtworkSource === "number") {
      return true;
    }
    return Boolean(currentArtworkSource?.uri);
  }, [currentArtworkSource]);

  // Constant blur radius to prevent re-renders
  const backgroundBlurRadius = 28;

  const renderPlayerContent = () => (
    <View
      style={[styles.overlay, { backgroundColor: getBackgroundOverlay() }]}
    >
      {/* Show offline banner or quality indicator */}
      {isOffline ? (
        <OfflineBanner top={insets.top + 25} />
      ) : (
        currentPlaying && (() => {
          // Determine streaming source and quality
          let source = 'saavn'; //default
          let quality = '';

          // Check for DAB - parse quality from URL fmt parameter
          // FIXED: Also check URL pattern for qobuz
          if (currentPlaying.isDabTrack ||
            currentPlaying.source === 'dab' ||
            (currentPlaying.url && currentPlaying.url.includes('qobuz'))) {
            source = 'dab';

            // Parse quality from URL instead of using setting-based quality
            if (currentPlaying.url) {
              const fmtMatch = currentPlaying.url.match(/[?&]fmt=(\d+)/);
              const fmt = fmtMatch ? fmtMatch[1] : null;
              const formatMap = {
                '5': 'MP3 320kbps',
                '6': 'FLAC',
                '7': 'FLAC',
                '27': 'FLAC'
              };
              quality = formatMap[fmt] || 'FLAC';
            } else {
              quality = 'FLAC';
            }
          }
          // Check for YouTube (11-character ID)
          else if (currentPlaying.id && typeof currentPlaying.id === 'string' && currentPlaying.id.length === 11) {
            source = 'youtube';
            quality = currentPlaying.currentPlayingQuality || '';
          }
          // Check for Tidal
          else if (currentPlaying.source === 'tidal' || currentPlaying.sourceType === 'tidal') {
            source = 'tidal';
            quality = currentPlaying.currentPlayingQuality || '';
          }
          // Default to Saavn
          else {
            quality = currentPlaying.currentPlayingQuality || '';
          }

          return (
            <QualityIndicator
              top={insets.top + 25}
              quality={quality}
              source={source}
            />
          );
        })()
      )}
      <LinearGradient
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        colors={getGradientColors()}
        style={styles.gradientContainer}
      >
        <View
          style={[
            styles.headerContainer,
            { paddingTop: insets.top + 16 },
          ]}
        >
          <IconButton
            icon="chevron-down"
            size={30}
            onPress={() => setIndex(0)}
            iconColor={iconColor}
            style={styles.closeButton}
          />

          <View style={styles.headerActions}>
            <LyricsHandler
              currentPlayingTrack={currentPlaying}
              isOffline={isOffline}
              Index={Index}
              currentArtworkSource={currentArtworkSource}
              iconColor={iconColor}
            />
            <View style={{ width: 8 }} />
            <FullScreenMusicMenuButton onPress={showMenu} size={25} color={iconColor} />
          </View>
        </View>

        <Spacer height={5} />

        <Surface
          style={[styles.albumSurface, { width: width * 0.9, height: width * 0.9 }]}
        >
          <AlbumArtworkDisplay
            currentPlaying={currentPlaying}
            artworkSource={currentArtworkSource}
            onClose={handlePlayerCloseAction}
          />
        </Surface>

        <Spacer height={8} />

        <View
          style={[
            styles.contentContainer,
            { minHeight: Dimensions.get("window").height * 0.55 },
          ]}
        >
          <View style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', width: '100%' }}>
              <View style={{ flex: 1 }}>
                <SongInfoDisplay
                  currentPlaying={currentPlaying}
                  isOffline={isOffline}
                  getTextColor={getTextColor}
                />
              </View>
              <View style={styles.iconContainer}>
                <View style={[styles.iconWrapper, { transform: [{ translateY: 1 }] }]}>
                  <View style={styles.iconButton}>
                    <LikeSongButton size={24} color={iconColor} />
                  </View>
                </View>
                <View style={[styles.iconWrapper, { transform: [{ translateY: -5 }] }]}>
                  <View style={styles.iconButton}>
                    <SleepTimerButton size={24} iconColor={iconColor} />
                  </View>
                </View>
                <View style={[styles.iconWrapper, { marginRight: 0, transform: [{ translateY: 1 }] }]}>
                  <View style={styles.iconButton}>
                    <SmartDownloadControl
                      songData={currentPlaying}
                      isOffline={isOffline}
                      size={28}
                      iconColor={iconColor}
                    />
                  </View>
                </View>
              </View>
            </View>
          </View>

          <View style={{ marginBottom: 12 }}>
            <ProgressBar />
          </View>

          <View style={{ marginTop: 24, marginBottom: 16 }}>
            <PlaybackControls
              iconColor={iconColor}
              navigationButtonSize={36}
              showLikeButton={false}
            />
          </View>

          <View style={styles.bottomControls}>
            {shouldShowTidalFeatures(isOffline) && (
              <TidalSourceSwitcher
                currentTrack={currentPlaying}
                variant="chip"
                size="small"
              />
            )}
          </View>
        </View>
        <View style={styles.bottomGradientWrapper} pointerEvents="none">
          <LinearGradient
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            colors={getBottomGradientColors()}
            style={styles.bottomGradient}
          />
        </View>

        {/* Bottom bar with icons */}
        <View style={styles.bottomBarContainer}>
          <View style={styles.barsButton}>
            <IconButton
              icon="menu"
              size={24}
              iconColor={iconColor}
              onPress={handleQueueToggle}
              style={{ margin: 0 }}
              rippleColor="rgba(255, 255, 255, 0.2)"
            />
          </View>
        </View>

        {/* Info icon on bottom left */}
        <View style={styles.infoBarContainer}>
          <View style={styles.barsButton}>
            <IconButton
              icon="information-outline"
              size={24}
              iconColor={iconColor}
              onPress={handleInfoModalOpen}
              style={{ margin: 0 }}
              rippleColor="rgba(255, 255, 255, 0.2)"
            />
          </View>
        </View>
      </LinearGradient>
    </View>
  );

  return (
    <BackButtonHandler
      Index={Index}
      setIndex={setIndex}
      musicPreviousScreen={musicPreviousScreen}
    >
      <Animated.View
        entering={FadeInDown.delay(200)}
        style={{
          backgroundColor: paperTheme.colors.background,
          flex: 1,
          paddingBottom: 0,
        }}
      >
        <StatusBar
          translucent
          backgroundColor="transparent"
          barStyle={paperTheme.dark ? "light-content" : "dark-content"}
        />
        <View style={{ flex: 1 }}>
          <LocalTracksErrorBoundary>
            <LocalTracksList
              localTracks={localTracks}
              onTrackPress={playLocalTrack}
              onClose={closeLocalTracks}
              visible={showLocalTracks}
              isLoading={localTracksLoading}
              error={localTracksError}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 200,
                paddingTop: 60,
                paddingHorizontal: 20,
                backgroundColor: paperTheme.colors.surface,
              }}
            />
          </LocalTracksErrorBoundary>

          {hasArtworkBackground ? (
            /* PERFORMANCE CRITICAL FIX:
             * React Native's blurRadius is extremely expensive on Android.
             * It processes the image on every render, causing massive lag.
             * 
             * Solution: Use a dark overlay instead of blur. This achieves
             * a similar visual effect (subdued background) at near-zero cost.
             * The LinearGradient overlays already provide depth and contrast.
             */
            <ImageBackground
              source={currentArtworkSource}
              style={styles.backgroundImage}
              resizeMode="cover"
              /* blurRadius REMOVED - was causing severe performance issues */
              key={`bg-${currentPlaying?.id || 'default'}`}
            >
              {/* Dark overlay to simulate blur effect cheaply */}
              <View style={{
                ...StyleSheet.absoluteFillObject,
                backgroundColor: 'rgba(0,0,0,0.6)',
              }} />
              {renderPlayerContent()}
            </ImageBackground>
          ) : (
            <View
              style={[styles.fallbackBackground, { backgroundColor: paperTheme.colors.surface }]}
            >
              {renderPlayerContent()}
            </View>
          )}
        </View>

        {/* Three-dot menu modal */}
        <FullScreenMusicMenuModal
          visible={menuVisible}
          position={menuPosition}
          onClose={closeMenu}
          menuOptions={getMenuOptions()}
        />
        <SongInfoModal
          visible={isInfoModalVisible}
          onDismiss={() => setIsInfoModalVisible(false)}
          track={currentPlaying}
        />

        <QueueBottomSheet
          index={queueIndex}
          onChange={handleQueueChange}
          enablePanDownToClose={true}
        />
      </Animated.View>
    </BackButtonHandler>
  );
};
