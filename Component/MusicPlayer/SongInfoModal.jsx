import React, { useMemo } from 'react';
import { View, StyleSheet, ScrollView, useWindowDimensions, Image } from 'react-native';
import {
  Modal,
  Portal,
  Text,
  useTheme,
  ActivityIndicator,
  Chip,
  Divider,
  Button,
  IconButton,
  Surface
} from 'react-native-paper';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import useSongDetails from '../../hooks/useSongDetails';

const styles = StyleSheet.create({
  modalContainer: {
    alignSelf: 'center',
    margin: 16,
  },
  modalSurface: {
    borderRadius: 20,
    overflow: 'hidden',
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 18,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  coverArt: {
    width: 88,
    height: 88,
    borderRadius: 12,
    marginRight: 16,
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  headerContent: {
    flex: 1,
    gap: 4,
  },
  trackTitle: {
    fontWeight: '600',
  },
  trackSubtitle: {
    opacity: 0.8,
  },
  scrollArea: {
    flexGrow: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingVertical: 20,
    gap: 16,
  },
  sectionSurface: {
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 16,
    elevation: 1,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionIcon: {
    marginRight: 8,
  },
  sectionTitle: {
    fontWeight: '600',
  },
  rowDivider: {
    marginVertical: 10,
    height: StyleSheet.hairlineWidth,
  },
  listItem: {
    paddingHorizontal: 0,
    paddingVertical: 8,
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  infoLabel: {
    fontSize: 14,
    fontWeight: '500',
    flexShrink: 1,
    flexBasis: '45%',
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'right',
    flexShrink: 1,
    flexBasis: '45%',
  },
  chipGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
  },
  chip: {
    marginRight: 8,
    marginBottom: 8,
  },
  loadingContainer: {
    paddingVertical: 48,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorContainer: {
    paddingVertical: 40,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorDescription: {
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
  retryButton: {
    marginTop: 20,
  },
  placeholderArt: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButton: {
    margin: 0,
    marginLeft: 8,
    alignSelf: 'flex-start',
  }
});

const InfoSection = ({ title, icon, children }) => {
  const theme = useTheme();

  return (
    <Surface
      style={[styles.sectionSurface, { backgroundColor: theme.colors.surface }]}
      elevation={2}
    >
      <View style={[styles.sectionHeader, { borderBottomColor: theme.colors.outlineVariant }]}>
        {icon && (
          <MaterialIcons
            name={icon}
            size={20}
            color={theme.colors.primary}
            style={styles.sectionIcon}
          />
        )}
        <Text
          variant="titleSmall"
          style={[styles.sectionTitle, { color: theme.colors.onSurface }]}
        >
          {title}
        </Text>
      </View>
      {children}
    </Surface>
  );
};

const SongInfoModal = ({ visible, onDismiss, track }) => {
  const theme = useTheme();
  const dimensions = useWindowDimensions();
  const { songDetails, loading, error, reload } = useSongDetails(track);

  const trackTitle = useMemo(() => track?.title || songDetails?.basicInfo?.[0]?.value || 'Unknown Track', [track?.title, songDetails?.basicInfo]);
  const trackSubtitle = useMemo(() => track?.artist || songDetails?.basicInfo?.find(item => item.label === 'Artists')?.value || 'Unknown Artist', [track?.artist, songDetails?.basicInfo]);

  const renderSection = (title, icon, rows) => {
    if (!rows || rows.length === 0) return null;

    return (
      <InfoSection title={title} icon={icon}>
        {rows.map((row, index) => (
          <React.Fragment key={`${title}-${index}`}>
            <View style={styles.listItem}>
              <Text
                style={[styles.infoLabel, { color: theme.colors.onSurfaceVariant }]}
                numberOfLines={2}
              >
                {row.label}
              </Text>
              <Text
                style={[
                  styles.infoValue,
                  {
                    color: row.highlight ? theme.colors.primary : theme.colors.onSurface,
                  },
                ]}
                numberOfLines={2}
              >
                {row.value || 'N/A'}
              </Text>
            </View>
            {index < rows.length - 1 && (
              <Divider style={[styles.rowDivider, { backgroundColor: theme.colors.outlineVariant }]} />
            )}
          </React.Fragment>
        ))}
      </InfoSection>
    );
  };

  // Get the current playing quality from the track object
  const getCurrentPlayingQuality = useMemo(() => {
    return track?.currentPlayingQuality || null;
  }, [track?.currentPlayingQuality]);

  const renderChips = (title, icon, chips) => {
    if (!chips || chips.length === 0) return null;

    return (
      <InfoSection title={title} icon={icon}>
        <View style={styles.chipGroup}>
          {chips.map((chip, index) => {
            // Check if this chip represents the currently playing quality
            const isCurrentlyPlaying = chip.label === getCurrentPlayingQuality;

            return (
              <Chip
                key={`${title}-${chip}-${index}`}
                mode={isCurrentlyPlaying ? 'flat' : 'outlined'}
                style={[styles.chip, isCurrentlyPlaying && { backgroundColor: theme.colors.primary }]}
                textStyle={{ color: isCurrentlyPlaying ? theme.colors.onPrimary : theme.colors.onSurfaceVariant }}
              >
                {chip.label}
              </Chip>
            );
          })}
        </View>
      </InfoSection>
    );
  };

  const modalMaxHeight = Math.min(dimensions.height * 0.85, 680);

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onDismiss}
        contentContainerStyle={[styles.modalContainer, { maxWidth: Math.min(dimensions.width - 32, 520) }]}
      >
        <Surface elevation={4} style={[styles.modalSurface, { backgroundColor: theme.colors.background }]}
        >
          <View
            style={[
              styles.header,
              {
                borderBottomColor: theme.colors.outlineVariant,
                backgroundColor: theme.colors.surface,
              },
            ]}
          >
            {(songDetails?.imageUrl || track?.artwork || track?.image) ? (
              <Image source={{ uri: songDetails?.imageUrl || track?.artwork || track?.image }} style={styles.coverArt} resizeMode="cover" />
            ) : (
              <View
                style={[
                  styles.coverArt,
                  styles.placeholderArt,
                  { backgroundColor: theme.colors.surfaceVariant },
                ]}
              >
                <MaterialIcons name="music-note" size={34} color={theme.colors.onSurfaceVariant} />
              </View>
            )}
            <View style={styles.headerContent}>
              <Text variant="titleLarge" style={[styles.trackTitle, { color: theme.colors.onSurface }]} numberOfLines={1}
              >
                {trackTitle}
              </Text>
              <Text variant="bodyMedium" style={[styles.trackSubtitle, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
                {trackSubtitle}
              </Text>
            </View>
            <IconButton
              icon="close"
              size={22}
              onPress={onDismiss}
              iconColor={theme.colors.onSurfaceVariant}
              style={styles.closeButton}
              rippleColor={`${theme.colors.onSurfaceVariant}33`}
            />
          </View>

          <ScrollView
            contentContainerStyle={[styles.scrollContent, { paddingBottom: 32 }]}
            style={{ maxHeight: modalMaxHeight - 130 }}
            showsVerticalScrollIndicator={false}
          >
            {loading ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator animating size="large" color={theme.colors.primary} />
                <Text
                  style={{
                    marginTop: 16,
                    color: theme.colors.onSurfaceVariant,
                  }}
                >
                  Fetching song details…
                </Text>
              </View>
            ) : error ? (
              <View style={styles.errorContainer}>
                <MaterialIcons name="error-outline" size={50} color={theme.colors.error} />
                <Text
                  variant="titleMedium"
                  style={{
                    marginTop: 12,
                    color: theme.colors.error,
                  }}
                >
                  Unable to load details
                </Text>
                <Text
                  variant="bodyMedium"
                  style={[styles.errorDescription, { color: theme.colors.onSurfaceVariant }]}
                >
                  {error || 'Please check your connection and try again.'}
                </Text>
                <Button
                  mode="contained-tonal"
                  icon="refresh"
                  onPress={reload}
                  style={styles.retryButton}
                >
                  Try again
                </Button>
              </View>
            ) : songDetails ? (
              <>
                {renderSection('Track information', 'music-note', songDetails.basicInfo)}
                {songDetails.featuredArtists ? renderSection('Featured artists', 'group', [
                  { label: 'Artists', value: songDetails.featuredArtists },
                ]) : null}
                {renderSection('Additional details', 'info-outline', songDetails.additionalInfo)}
                {renderSection('Media information', 'album', songDetails.mediaInfo)}
                {renderChips(
                  'Available qualities',
                  'high-quality',
                  songDetails.availableQualities?.map((quality) => ({
                    label: quality,
                  }))
                )}
              </>
            ) : (
              <View style={styles.loadingContainer}>
                <ActivityIndicator animating size="small" color={theme.colors.primary} />
              </View>
            )}
          </ScrollView>
        </Surface>
      </Modal>
    </Portal>
  );
};

export default SongInfoModal;
