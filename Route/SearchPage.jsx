import { MainWrapper } from "../Layout/MainWrapper";
import Tabs from "../Component/Global/Tabs/Tabs";
import { useEffect, useState, useCallback } from "react";
import { getSearchSongData, getSearchArtistData } from "../Api/Songs";
import {
  getYTMusicSearchSongData,
  getYTMusicSearchPlaylistData,
  getYTMusicSearchAlbumData,
  getYTMusicSearchArtistData
} from "../Api/YTMusic";
import dabMusicService from "../Utils/DabMusicService";
import { View, TouchableOpacity, TextInput, Pressable, Dimensions, FlatList, StyleSheet, Text, Modal, ToastAndroid, Platform } from "react-native";
import SongDisplay from "../Component/SearchPage/SongDisplay";
import { LoadingComponent } from "../Component/Global/Loading";
import { getSearchPlaylistData } from "../Api/Playlist";
import PlaylistDisplay from "../Component/SearchPage/PlaylistDisplay";
import { getSearchAlbumData } from "../Api/Album";
import AlbumsDisplay from "../Component/SearchPage/AlbumDisplay";
import ArtistDisplay from "../Component/SearchPage/ArtistDisplay";
import { Spacer } from "../Component/Global/Spacer";
import { useTheme } from "@react-navigation/native";
import { GitFork } from 'lucide-react-native';
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Divider } from 'react-native-paper';
import SwipeableHistoryItem from '../Component/SearchPage/SwipeableHistoryItem';

const SEARCH_HISTORY_KEY = '@search_history';
const MAX_HISTORY_ITEMS = 20;
const SELECTED_SOURCE_KEY = '@selected_search_source';

export const SearchPage = ({ navigation }) => {
  const { colors } = useTheme();
  const width = Dimensions.get("window").width;
  const [ActiveTab, setActiveTab] = useState(0);
  const [query, setQuery] = useState("");
  const [SearchText, setSearchText] = useState("");
  const [Loading, setLoading] = useState(false);
  const [Data, setData] = useState({ data: { results: [] } });
  const [searchHistory, setSearchHistory] = useState([]);
  const [selectedSource, setSelectedSource] = useState('saavn');
  const [modalVisible, setModalVisible] = useState(false);
  const limit = 20;

  async function fetchSearchData(text) {
    if (!text) {
      setData({ data: { results: [] } });
      return;
    }

    try {
      setLoading(true);
      let data = null;

      // DAB Music - only supports songs, requires authentication
      if (selectedSource === 'dab') {
        try {
          const tracks = await dabMusicService.searchTracks(text, limit);
          data = {
            success: tracks.length > 0,
            data: {
              results: tracks,
              total: tracks.length
            }
          };
        } catch (error) {
          if (error.message === 'AUTH_REQUIRED') {
            // Auto-fallback to Saavn instead of blocking the user
            if (Platform.OS === 'android') {
              ToastAndroid.show(
                '🎵 DAB Music requires login. Switched to JioSaavn.',
                ToastAndroid.LONG
              );
            }

            // Switch to Saavn source
            await saveSelectedSource('saavn');

            // Fetch data using Saavn for the current tab
            if (ActiveTab === 0) {
              data = await getSearchSongData(text, 1, limit);
            } else if (ActiveTab === 1) {
              data = await getSearchPlaylistData(text, 1, limit);
            } else if (ActiveTab === 2) {
              data = await getSearchAlbumData(text, 1, limit);
            } else if (ActiveTab === 3) {
              data = await getSearchArtistData(text, 1, limit);
            }

            if (data && data.success !== false) {
              setData(data);
            } else {
              setData({ data: { results: [] } });
            }
            setLoading(false);
            return;
          }
          // Other errors
          throw error;
        }
      }
      // For YTMusic, handle categories based on tabs
      else if (selectedSource === 'ytmusic') {
        if (ActiveTab === 0) {
          data = await getYTMusicSearchSongData(text, 1, limit);
        } else if (ActiveTab === 1) {
          data = await getYTMusicSearchPlaylistData(text, 1, limit);
        } else if (ActiveTab === 2) {
          data = await getYTMusicSearchAlbumData(text, 1, limit);
        } else if (ActiveTab === 3) {
          data = await getYTMusicSearchArtistData(text, 1, limit);
        }
      } else {
        // Saavn logic
        if (ActiveTab === 0) {
          // Songs
          data = await getSearchSongData(text, 1, limit);
        } else if (ActiveTab === 1) {
          // Playlists - Always use Saavn API
          data = await getSearchPlaylistData(text, 1, limit);
        } else if (ActiveTab === 2) {
          // Albums - Always use Saavn API
          data = await getSearchAlbumData(text, 1, limit);
        } else if (ActiveTab === 3) {
          // Artists
          data = await getSearchArtistData(text, 1, limit);
        }
      }

      if (data && data.success !== false) {
        setData(data);
      } else {
        setData({ data: { results: [] } });
      }
    } catch (e) {
      console.error('Search error:', e);
      setData({ data: { results: [] } });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (SearchText) {
      fetchSearchData(SearchText);
    } else {
      // Clear data when no search text, regardless of tab/source switch
      setData({ data: { results: [] } });
    }
  }, [SearchText, ActiveTab, selectedSource]);

  // Load search history on mount
  useEffect(() => {
    const loadSearchHistory = async () => {
      try {
        const history = await AsyncStorage.getItem(SEARCH_HISTORY_KEY);
        if (history) {
          setSearchHistory(JSON.parse(history));
        }
      } catch (error) {
        console.error('Error loading search history:', error);
      }
    };
    loadSearchHistory();
  }, []);

  // Load selected source on mount
  useEffect(() => {
    const loadSelectedSource = async () => {
      try {
        const source = await AsyncStorage.getItem(SELECTED_SOURCE_KEY);
        if (source) {
          setSelectedSource(source);
        }
      } catch (error) {
        console.error('Error loading selected source:', error);
      }
    };
    loadSelectedSource();
  }, []);

  // Save selected source
  const saveSelectedSource = async (source) => {
    try {
      await AsyncStorage.setItem(SELECTED_SOURCE_KEY, source);
      setSelectedSource(source);
      // Clear data when switching sources to avoid incompatible data structures
      setData({ data: { results: [] } });
    } catch (error) {
      console.error('Error saving selected source:', error);
    }
  };

  // Save search query to history
  const saveToHistory = useCallback(async (query) => {
    if (!query || query.length < 2) return; // Don't save very short queries

    try {
      const updatedHistory = [
        query,
        ...searchHistory.filter(item => item.toLowerCase() !== query.toLowerCase())
      ].slice(0, MAX_HISTORY_ITEMS);

      await AsyncStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(updatedHistory));
      setSearchHistory(updatedHistory);
    } catch (error) {
      console.error('Error saving search history:', error);
    }
  }, [searchHistory]);

  // Handle search with debounce
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (query.trim()) {
        setSearchText(query);
      } else {
        setSearchText('');
        setData({ data: { results: [] } });
      }
    }, 500);
    return () => clearTimeout(timeoutId);
  }, [query]);

  // Handle search from history item
  const handleHistoryItemPress = (item) => {
    setQuery(item);
  };

  // Clear search history
  const clearHistory = async () => {
    try {
      await AsyncStorage.removeItem(SEARCH_HISTORY_KEY);
      setSearchHistory([]);
    } catch (error) {
      console.error('Error clearing search history:', error);
    }
  };

  const handleManualSearch = () => {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length > 1) { // Only save if query has more than 1 character
      saveToHistory(trimmedQuery);
      setSearchText(trimmedQuery);
    } else if (trimmedQuery.length > 0) {
      setSearchText(trimmedQuery);
    }
  };

  // Handle delete history item
  const handleDeleteHistoryItem = async (itemToDelete) => {
    try {
      const updatedHistory = searchHistory.filter(item => item !== itemToDelete);
      await AsyncStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(updatedHistory));
      setSearchHistory(updatedHistory);
    } catch (error) {
      console.error('Error deleting history item:', error);
    }
  };

  // Render search history item with swipe to delete
  const renderHistoryItem = ({ item }) => (
    <SwipeableHistoryItem
      item={item}
      onPress={() => handleHistoryItemPress(item)}
      onDelete={() => handleDeleteHistoryItem(item)}
      onSwipeableOpen={(direction) => {
        if (direction === 'right') {
          handleDeleteHistoryItem(item);
        }
      }}
    />
  );

  // Render search history list
  const renderSearchHistory = () => (
    <View style={{ flex: 1, marginTop: 10 }}>
      <View style={[styles.historyHeader, { borderBottomColor: colors.border }]}>
        <Text style={[styles.historyTitle, { color: colors.text }]}>
          Recent Searches
        </Text>
        {searchHistory.length > 0 && (
          <Pressable
            onPress={() => {
              AsyncStorage.removeItem(SEARCH_HISTORY_KEY);
              setSearchHistory([]);
            }}
            style={({ pressed }) => ({
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ color: colors.primary, fontWeight: '600' }}>Clear All</Text>
          </Pressable>
        )}
      </View>
      <FlatList
        data={searchHistory}
        renderItem={renderHistoryItem}
        keyExtractor={(item, index) => index.toString()}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.historyList}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );

  return (
    <MainWrapper>
      <Spacer />

      <View style={styles.searchContainer}>
        <View style={styles.searchInputContainer}>
          <TextInput
            cursorColor={colors.text}
            placeholder="Search songs, albums, artists"
            placeholderTextColor={colors.text + '80'}
            style={[styles.searchInput, { color: colors.text }]}
            onChangeText={setQuery}
            onSubmitEditing={handleManualSearch}
            returnKeyType="search"
            autoFocus={true}
            value={query}
          />
        </View>

        <Pressable
          onPress={() => setModalVisible(true)}
          style={[styles.clearButton, { backgroundColor: colors.card }]}
        >
          <GitFork
            size={20}
            color={colors.text}
          />
        </Pressable>
      </View>

      {(selectedSource === 'saavn' || selectedSource === 'ytmusic') && (
        <Tabs tabs={["Songs", "Playlists", "Albums", "Artists"]} setState={setActiveTab} state={ActiveTab} />
      )}
      {selectedSource === 'dab' && (
        <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
          <Text style={{ color: colors.text, opacity: 0.7, fontSize: 12, textAlign: 'center' }}>
            🎵 DAB Music (High-Quality FLAC)
          </Text>
        </View>
      )}
      <Spacer height={15} />

      {!SearchText && searchHistory.length > 0 ? (
        renderSearchHistory()
      ) : Loading ? (
        <LoadingComponent loading={Loading} />
      ) : (
        <View style={{ flex: 1, paddingHorizontal: 10 }}>
          {selectedSource === 'dab' ? (
            // DAB only supports Songs (no tabs shown)
            <SongDisplay data={Data} limit={limit} Searchtext={SearchText} source={selectedSource} />
          ) : (
            // Saavn and YTMusic support all categories
            <>
              {ActiveTab === 0 && <SongDisplay data={Data} limit={limit} Searchtext={SearchText} source={selectedSource} />}
              {ActiveTab === 1 && <PlaylistDisplay data={Data} limit={limit} Searchtext={SearchText} source={selectedSource} />}
              {ActiveTab === 2 && <AlbumsDisplay data={Data} limit={limit} Searchtext={SearchText} source={selectedSource} />}
              {ActiveTab === 3 && <ArtistDisplay data={Data} limit={limit} Searchtext={SearchText} source={selectedSource} />}
            </>
          )}
        </View>
      )}

      {/* Source Selection Modal */}
      <Modal
        visible={modalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setModalVisible(false)}
        >
          <View style={[styles.modalContent, { backgroundColor: colors.card }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Select Music Source</Text>

            <TouchableOpacity
              style={[styles.sourceOption, selectedSource === 'saavn' && styles.selectedOption]}
              onPress={() => {
                saveSelectedSource('saavn');
                setModalVisible(false);
              }}
            >
              <Text style={[styles.sourceText, { color: colors.text }]}>JioSaavn</Text>
              {selectedSource === 'saavn' && <Text style={[styles.checkmark, { color: colors.primary }]}>✓</Text>}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.sourceOption, selectedSource === 'ytmusic' && styles.selectedOption]}
              onPress={() => {
                saveSelectedSource('ytmusic');
                setModalVisible(false);
              }}
            >
              <Text style={[styles.sourceText, { color: colors.text }]}>YTMusic</Text>
              {selectedSource === 'ytmusic' && <Text style={[styles.checkmark, { color: colors.primary }]}>✓</Text>}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.sourceOption, selectedSource === 'dab' && styles.selectedOption]}
              onPress={() => {
                saveSelectedSource('dab');
                setModalVisible(false);
              }}
            >
              <Text style={[styles.sourceText, { color: colors.text }]}>DAB (FLAC)</Text>
              {selectedSource === 'dab' && <Text style={[styles.checkmark, { color: colors.primary }]}>✓</Text>}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </MainWrapper>
  );
};

const styles = StyleSheet.create({
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 15,
    marginBottom: 10,
  },
  searchInputContainer: {
    flex: 1,
    borderBottomWidth: 1,
    borderBottomColor: 'gray',
    marginRight: 10,
  },
  searchInput: {
    fontSize: 18,
    paddingVertical: 8,
  },
  clearButton: {
    padding: 8,
    borderRadius: 20,
  },
  historyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  historyTitle: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  historyList: {
    paddingBottom: 20,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '80%',
    borderRadius: 10,
    padding: 20,
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  sourceOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    padding: 15,
    borderRadius: 8,
    marginVertical: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  selectedOption: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },
  sourceText: {
    fontSize: 16,
  },
  checkmark: {
    fontSize: 18,
    fontWeight: 'bold',
  },
});
