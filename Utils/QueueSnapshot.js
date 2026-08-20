import TrackPlayer, { Event } from 'react-native-track-player';
import { DeviceEventEmitter } from 'react-native';

/**
 * QueueSnapshot
 *
 * TrackPlayer.getQueue() serializes every track in the queue across the native
 * bridge and JSON-parses it on the JS thread. With a 100+ track YTMusic queue
 * that is tens of milliseconds each time - and a single track change used to
 * trigger four of them (ContextState, QueueManager, LocalMusicQueueManager,
 * AutoRecommendations), which is what froze the progress bar and the buttons.
 *
 * This module collapses those into one shared, short-lived snapshot with
 * in-flight de-duplication. Anything that mutates the queue should call
 * invalidateQueueSnapshot().
 */

const DEFAULT_TTL_MS = 1000;

let cachedQueue = null;
let cachedAt = 0;
let inFlight = null;

/** Drop the cached snapshot - call after any queue mutation. */
export function invalidateQueueSnapshot() {
  cachedQueue = null;
  cachedAt = 0;
}

/**
 * Get the queue, reusing a recent snapshot when possible.
 * @param {number} maxAgeMs - Accept a cached snapshot up to this old.
 * @returns {Promise<Array>}
 */
export async function getQueueSnapshot(maxAgeMs = DEFAULT_TTL_MS) {
  ensureListeners();

  if (cachedQueue && Date.now() - cachedAt <= maxAgeMs) {
    return cachedQueue;
  }

  // Coalesce concurrent callers onto a single bridge round-trip.
  if (inFlight) {
    return inFlight;
  }

  inFlight = TrackPlayer.getQueue()
    .then((queue) => {
      cachedQueue = queue || [];
      cachedAt = Date.now();
      inFlight = null;
      return cachedQueue;
    })
    .catch((error) => {
      inFlight = null;
      throw error;
    });

  return inFlight;
}

/** Queue length without forcing a fresh serialization. */
export async function getQueueLength(maxAgeMs = DEFAULT_TTL_MS) {
  try {
    const queue = await getQueueSnapshot(maxAgeMs);
    return queue.length;
  } catch (e) {
    return 0;
  }
}

let listenersRegistered = false;

/**
 * Registered lazily on first use so importing this module never touches the
 * native player before it has been set up.
 */
function ensureListeners() {
  if (listenersRegistered) {
    return;
  }
  listenersRegistered = true;

  // Any batch append/removal announces itself through this event.
  DeviceEventEmitter.addListener('queue-updated', invalidateQueueSnapshot);

  // Track changes are also when the prefetch manager trims old tracks, so
  // treat them as a mutation point.
  try {
    TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, () => {
      invalidateQueueSnapshot();
    });
  } catch (e) {
    // Player not ready yet - the queue-updated listener still covers appends
    listenersRegistered = false;
  }
}

export default {
  getQueueSnapshot,
  getQueueLength,
  invalidateQueueSnapshot,
};
