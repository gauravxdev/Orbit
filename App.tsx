import 'react-native-get-random-values'; // Must be imported before any crypto operations
import { NavigationContainer, CommonActions, NavigationContainerRef } from "@react-navigation/native";
import { RootRoute } from "./Route/RootRoute.jsx";
import { createStackNavigator } from "@react-navigation/stack";
import { ToastAndroid, BackHandler } from "react-native";
import ContextState from "./Context/ContextState";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet'
import { RouteOnboarding } from "./Route/OnboardingScreen/RouteOnboarding";
import { InitialScreen } from "./Route/InitialScreen";
import { Album } from './Route/Album';
import ArtistPage from './Route/ArtistPage';
import LoginScreen from './Component/Auth/LoginScreen';
import CodePush from "react-native-code-push";
import { useEffect, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from '@react-native-community/netinfo';
// Firebase Analytics is initialized within AnalyticsUtils using the modular API
// Import analytics service
import { analyticsService, AnalyticsEvents } from './Utils/AnalyticsUtils';
// Import ThemeProvider from ThemeContext
import { ThemeProvider } from './Context/ThemeContext';
import { StorageManager } from './Utils/StorageManager';
// Import theme types
import { darkTheme } from './Theme/darkTheme';
import { PaperProvider } from 'react-native-paper';

type ThemeContextType = {
  theme: typeof darkTheme;
  paperTheme: any;
  themeMode: string;
  colorSchemeName: string;
  colorScheme: any;
  toggleTheme: () => Promise<void>;
  changeColorScheme: (scheme: string) => Promise<void>;
  isThemeLoaded: boolean;
};

const Stack = createStackNavigator()
let codePushOptions = { checkFrequency: CodePush.CheckFrequency.ON_APP_START };

function App() {
  const navigationRef = useRef<NavigationContainerRef<any>>(null);

  useEffect(() => {
    // Initialize playlists structure if needed
    const initializeUserPlaylists = async () => {
      try {
        const userPlaylistsJson = await AsyncStorage.getItem('userPlaylists');
        if (!userPlaylistsJson) {
          await AsyncStorage.setItem('userPlaylists', JSON.stringify([]));
        }
      } catch (error) {
        // Silent error handling for playlist initialization
      }
    };

    initializeUserPlaylists();
  }, []);

  // Initialize Firebase Analytics
  useEffect(() => {
    // Set analytics collection enabled (can be toggled for GDPR compliance)
    analyticsService.setAnalyticsCollectionEnabled(true);

    // Log app open event
    analyticsService.logEvent(AnalyticsEvents.APP_OPEN);
  }, []);

  useEffect(() => {
    // @ts-ignore
    CodePush.notifyAppReady();

    // Check for CodePush updates with proper error handling
    const checkForCodePushUpdate = async () => {
      try {
        // Check network connectivity first
        const netState = await NetInfo.fetch();

        if (!netState.isConnected) {
          // Skip update check if no network connection
          return;
        }

        // Attempt to check for updates
        const update = await CodePush.checkForUpdate();

        if (update) {
          ToastAndroid.showWithGravity(
            `App Update Available and will be updated automatically`,
            ToastAndroid.LONG,
            ToastAndroid.CENTER,
          );
          CodePush.sync(
            { installMode: CodePush.InstallMode.IMMEDIATE },
          );
        }
      } catch (error) {
        // Silently handle CodePush errors (network failures, server unavailable, etc.)
        // These are non-critical and shouldn't disrupt the app
      }
    };

    checkForCodePushUpdate();
  }, [])

  useEffect(() => {
    // Ensure storage directories exist early to avoid ENOENT when accessing files
    StorageManager.ensureDirectoriesExist().catch(err => {
      console.warn('Failed to ensure storage directories at startup:', err && err.message ? err.message : err);
    });

    const handleBackPress = () => {
      if (navigationRef.current) {
        try {
          // If we can't go back (we're at the root), allow the app to exit
          if (!navigationRef.current.canGoBack()) {
            return false; // Return false to allow system to handle (exit app)
          }

          return false; // Allow default back navigation
        } catch (error) {
          return false;
        }
      }
      return false;
    };

    const backHandler = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
    return () => backHandler.remove();
  }, []);

  return <GestureHandlerRootView style={{ flex: 1 }}>
    <ContextState>
      <BottomSheetModalProvider>
        <ThemeProvider>
          {({ theme, paperTheme, isThemeLoaded }: ThemeContextType) => {
            // Only render when theme is loaded to prevent flash of wrong theme
            if (!isThemeLoaded) {
              return null; // Or a loading indicator if preferred
            }

            return (
              <PaperProvider theme={paperTheme}>
                <NavigationContainer
                  ref={navigationRef}
                  theme={theme}
                  onStateChange={(state) => {
                    const currentRouteName = navigationRef.current?.getCurrentRoute()?.name;
                    if (currentRouteName) {
                      // Log screen view to Firebase Analytics
                      analyticsService.logScreenView(currentRouteName);
                    }
                  }}
                  fallback={<InitialScreen navigation={undefined as any} />}
                >
                  <Stack.Navigator screenOptions={{
                    headerShown: false,
                    cardStyle: { backgroundColor: theme.colors.background }
                  }}>
                    <Stack.Screen name="Initial" component={InitialScreen} />
                    <Stack.Screen name="Onboarding" component={RouteOnboarding} />
                    <Stack.Screen name="MainRoute" component={RootRoute} />
                    <Stack.Screen name="Album" component={Album} />
                    <Stack.Screen name="ArtistPage" component={ArtistPage} />
                    <Stack.Screen name="LoginScreen" component={LoginScreen} />
                  </Stack.Navigator>
                </NavigationContainer>
              </PaperProvider>
            );
          }}
        </ThemeProvider>
      </BottomSheetModalProvider>
    </ContextState>
  </GestureHandlerRootView>
}
export default CodePush(codePushOptions)(App)