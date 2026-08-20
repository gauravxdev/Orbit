import { createContext } from 'react';

/**
 * Dedicated context for the player queue.
 *
 * The queue array changes on every track change and every batch append. Keeping
 * it in the main app Context meant a new context value on each of those, which
 * re-rendered all ~28 Context consumers - including the song cards rendered on
 * Home and Search. Only the queue panel actually needs this data, so it lives
 * in its own provider.
 */
const QueueContext = createContext({ Queue: [], updateTrack: () => {} });

export default QueueContext;
