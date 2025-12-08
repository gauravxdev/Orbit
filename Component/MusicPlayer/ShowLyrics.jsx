import { Dimensions, Modal, Pressable, ScrollView, Text, View, StyleSheet, ImageBackground } from "react-native";
import { Heading } from "../Global/Heading";
import { Spacer } from "../Global/Spacer";
import { LoadingComponent } from "../Global/Loading";
import React, { useState, useEffect, useRef } from "react";
// import { useTheme } from "@react-navigation/native"; // Replaced with useThemeContext
import { useThemeContext } from '../../Context/ThemeContext'; // Added custom theme context
import LinearGradient from "react-native-linear-gradient";
import Clipboard from '@react-native-clipboard/clipboard';
import { useProgress } from "react-native-track-player";
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';

const parseLRC = (lrcString) => {
  if (!lrcString) return [];
  const lines = lrcString.split('\n');
  const lyrics = [];
  const timeRegex = /^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)$/;

  lines.forEach(line => {
    const match = line.match(timeRegex);
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const msString = match[3];
      const milliseconds = parseInt(msString.length === 2 ? msString + '0' : msString, 10);
      const time = (minutes * 60 * 1000) + (seconds * 1000) + milliseconds;
      const text = match[4].trim();
      if (text) {
        lyrics.push({ time, text });
      }
    }
  });
  return lyrics.sort((a, b) => a.time - b.time);
};

export const ShowLyrics = ({ ShowDailog, Loading, Lyric, setShowDailog, currentArtworkSource }) => {
  const screenHeight = Dimensions.get("window").height;
  const screenWidth = Dimensions.get("window").width;
  const { theme, themeMode } = useThemeContext(); // Use custom theme context
  // PERFORMANCE: Increased from 250ms to 500ms - still smooth for lyrics sync
  const { position } = useProgress(500);

  const artworkCenterOpacity = 0.3;
  const artworkEdgeOpacity = 1.0; // Fully opaque edge for artwork background
  const fallbackCenterOpacity = 0.5;
  const fallbackEdgeOpacity = 1.0; // Increased opacity (fully opaque) for the edge of the fade (fallback background)

  const artworkCenterColor = `rgba(0,0,0,${artworkCenterOpacity})`;
  const artworkEdgeColor = `rgba(0,0,0,${artworkEdgeOpacity})`;
  const fallbackCenterColor = `rgba(0,0,0,${fallbackCenterOpacity})`;
  const fallbackEdgeColor = `rgba(0,0,0,${fallbackEdgeOpacity})`;

  const [parsedLyrics, setParsedLyrics] = useState([]);
  const [activeLyricIndex, setActiveLyricIndex] = useState(-1);
  const scrollViewRef = useRef(null);
  const lyricLineRefs = useRef([]);

  useEffect(() => {
    if (Lyric?.synced) {
      const parsed = parseLRC(Lyric.synced);
      setParsedLyrics(parsed);
      lyricLineRefs.current = parsed.map((_, i) => lyricLineRefs.current[i] || React.createRef());
      setActiveLyricIndex(-1);
    } else {
      setParsedLyrics([]);
    }
  }, [Lyric?.synced]);

  useEffect(() => {
    if (parsedLyrics.length === 0 || !ShowDailog) return;
    const currentPositionMs = position * 1000;
    let newActiveIndex = -1;
    for (let i = 0; i < parsedLyrics.length; i++) {
      if (currentPositionMs >= parsedLyrics[i].time) {
        newActiveIndex = i;
      } else {
        break;
      }
    }
    if (newActiveIndex !== activeLyricIndex) {
      setActiveLyricIndex(newActiveIndex);
    }
  }, [position, parsedLyrics, activeLyricIndex, ShowDailog]);

  useEffect(() => {
    if (activeLyricIndex >= 0 && activeLyricIndex < lyricLineRefs.current.length && ShowDailog) {
      const activeRef = lyricLineRefs.current[activeLyricIndex];
      if (activeRef && activeRef.current && scrollViewRef.current) {
        activeRef.current.measureLayout(
          scrollViewRef.current.getInnerViewNode(),
          (x, y, width, height) => {
            const lyricsViewVisibleHeight = screenHeight - 50 - 50 - 120 - 20; // topPad - bottomPad - controlsHeight - controlsBottomMargin
            const scrollToY = y - (lyricsViewVisibleHeight / 2) + (height / 2);
            scrollViewRef.current.scrollTo({ y: Math.max(0, scrollToY), animated: true });
          },
          () => { /* Error handling for measureLayout */ }
        );
      }
    }
  }, [activeLyricIndex, ShowDailog, screenHeight]);

  const styles = StyleSheet.create({

    contentWrapper: {
      flex: 1,
      paddingHorizontal: 20,
      paddingTop: 50, // SafeArea top padding, content starts below this
      // paddingBottom is implicitly handled by the bottom fade gradient position
    },
    scrollViewContent: {
      paddingTop: 20, // Remove gradient spacing
      paddingBottom: 20, // Remove gradient spacing
    },
    lyricText: {
      fontFamily: 'System', // Use system font for better performance
      fontWeight: 'bold', // Made base lyric text bold
      fontSize: screenWidth * 0.055,
      paddingVertical: 10,
      textAlign: "center",
      lineHeight: screenWidth * 0.055 * 1.5,
    },
    plainLyricText: {
      fontFamily: 'System', // Use system font for better performance
      fontWeight: '300', // Fixed duplicate fontWeight
      color: theme.colors.text,
      fontSize: screenWidth * 0.055,
      textAlign: "center",
      lineHeight: screenWidth * 0.055 * 1.5,
    },
    fadeGradient: {
      position: 'absolute',
      left: 0,
      right: 0,
      height: 100, // Further reduced height for a narrower fade effect
      zIndex: 2, // Ensure gradient is above ScrollView content
    },
  });

  return (
    <Modal
      visible={ShowDailog}
      transparent={true}
      onRequestClose={() => setShowDailog(false)}
      statusBarTranslucent={true} // Allow content to go behind status bar
      animationType="fade" // Recommended for smooth transition with translucent status bar
    >
      {currentArtworkSource && (typeof currentArtworkSource === 'number' || currentArtworkSource.uri) ? (
        <ImageBackground
          source={currentArtworkSource}
          style={{ flex: 1 }}
          blurRadius={15} // Keep existing blur
        >
          <View style={{ ...StyleSheet.absoluteFillObject, backgroundColor: artworkCenterColor }} />
          {/* Close button */}
          <Pressable
            onPress={() => setShowDailog(false)}
            style={{
              position: 'absolute',
              top: 50,
              right: 20,
              zIndex: 10,
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: 'rgba(0, 0, 0, 0.5)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <MaterialIcons name="close" size={24} color="#FFFFFF" />
          </Pressable>
          <Pressable style={{ flex: 1, backgroundColor: 'transparent' }} onPress={() => setShowDailog(false)}>
            {/* This View consumes touch events to prevent modal close when interacting with content */}
            <View style={styles.contentWrapper} onStartShouldSetResponder={() => true}>
              {/* Top fade gradient removed as per request */}
              <ScrollView
                ref={scrollViewRef}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.scrollViewContent}
                scrollEventThrottle={16}
                style={{ zIndex: 1 }} // Ensure gradients can overlay
              >
                {Loading && <LoadingComponent loading={true} height={screenHeight - 150} />}
                {!Loading && (
                  <>
                    {parsedLyrics.length > 0 ? (
                      parsedLyrics.map((line, index) => (
                        <Text
                          key={`${index}-${line.time}`}
                          ref={lyricLineRefs.current[index]}
                          style={[
                            styles.lyricText, // fontWeight is now handled by styles.lyricText base style
                            {
                              color: index === activeLyricIndex ? '#FFFFFF' : '#9E9E9E' // Active: white, Inactive: gray
                            }
                          ]}
                        >
                          {line.text}
                        </Text>
                      ))
                    ) : (
                      <Text selectable={true} style={styles.plainLyricText}>
                        {Lyric?.plain?.replaceAll("<br>", "\n") || "No lyrics available for this song."}
                      </Text>
                    )}
                  </>
                )}
              </ScrollView>
              {/* Bottom fade gradient removed as per request */}
            </View>
          </Pressable>
        </ImageBackground>
      ) : (
        <View style={{ flex: 1, backgroundColor: fallbackCenterColor }}>
          {/* Close button */}
          <Pressable
            onPress={() => setShowDailog(false)}
            style={{
              position: 'absolute',
              top: 50,
              right: 20,
              zIndex: 10,
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: 'rgba(0, 0, 0, 0.5)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <MaterialIcons name="close" size={24} color="#FFFFFF" />
          </Pressable>
          <Pressable style={{ flex: 1, backgroundColor: 'transparent' }} onPress={() => setShowDailog(false)}>
            {/* This View consumes touch events to prevent modal close when interacting with content */}
            <View style={styles.contentWrapper} onStartShouldSetResponder={() => true}>
              <ScrollView
                ref={scrollViewRef}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.scrollViewContent}
                scrollEventThrottle={16}
                style={{ zIndex: 1 }} // Ensure gradients can overlay
              >
                {Loading && <LoadingComponent loading={true} height={screenHeight - 150} />}
                {!Loading && (
                  <>
                    {parsedLyrics.length > 0 ? (
                      parsedLyrics.map((line, index) => (
                        <Text
                          key={`${index}-${line.time}`}
                          ref={lyricLineRefs.current[index]}
                          style={[
                            styles.lyricText,
                            {
                              color: index === activeLyricIndex ? '#FFFFFF' : '#9E9E9E' // Active: white, Inactive: gray
                            }
                          ]}
                        >
                          {line.text}
                        </Text>
                      ))
                    ) : (
                      <Text selectable={true} style={styles.plainLyricText}>
                        {Lyric?.plain?.replaceAll("<br>", "\n") || "No lyrics available for this song."}
                      </Text>
                    )}
                  </>
                )}
              </ScrollView>
            </View>
          </Pressable>
        </View>
      )}
    </Modal>
  );
};
