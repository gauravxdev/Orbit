package com.orbit.app

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import okhttp3.OkHttpClient
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.services.youtube.YoutubeService
import org.schabi.newpipe.extractor.stream.StreamInfo
import java.util.concurrent.TimeUnit

class StreamModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    init {
        // Initialize NewPipe with proper timeout configuration
        if (NewPipeDownloaderInstance.downloader == null) {
             val client = OkHttpClient.Builder()
                 .connectTimeout(30, TimeUnit.SECONDS)
                 .readTimeout(30, TimeUnit.SECONDS)
                 .writeTimeout(30, TimeUnit.SECONDS)
                 .build()
             val downloader = NewPipeDownloader(client)
             NewPipe.init(downloader)
             NewPipeDownloaderInstance.downloader = downloader
        }
        android.util.Log.i(
            "StreamModule",
            "StreamModule init - NewPipeExtractor v0.26.5 build $NATIVE_BUILD_MARKER"
        )
    }

    override fun getName(): String {
        return "StreamModule"
    }

    /**
     * Build marker. Logged once at init so it is possible to tell from the
     * device log whether the NATIVE side was actually rebuilt - JS changes
     * arrive over Metro without touching the extractor, which made a stale
     * native binary look like a code bug.
     */
    @ReactMethod
    fun getBuildInfo(promise: Promise) {
        val info = com.facebook.react.bridge.Arguments.createMap()
        info.putString("newPipeExtractor", "v0.26.5")
        info.putString("streamModuleBuild", NATIVE_BUILD_MARKER)
        promise.resolve(info)
    }

    companion object {
        const val NATIVE_BUILD_MARKER = "2026-08-20-sabr-diagnostics"
    }

    /**
     * Get stream URL for STREAMING - selects based on quality preference
     * 
     * @param videoId YouTube video ID
     * @param cookies Optional authentication cookies
     * @param autoQuality If true, use first available stream (faster). If false, select highest bitrate.
     */
    @ReactMethod
    fun getStreamUrl(videoId: String, cookies: String?, autoQuality: Boolean, promise: Promise) {
        // Delegate to internal method with preferM4A = false (streaming mode)
        getStreamUrlInternal(videoId, cookies, false, autoQuality, promise)
    }

    /**
     * Get stream URL for DOWNLOAD - prioritizes M4A format for metadata embedding
     */
    @ReactMethod
    fun getStreamUrlForDownload(videoId: String, cookies: String?, promise: Promise) {
        // Delegate to internal method with preferM4A = true (download mode), autoQuality = false (always best quality for downloads)
        getStreamUrlInternal(videoId, cookies, true, false, promise)
    }

    /**
     * Internal method that handles both streaming and download cases
     * Implements "Lazy Fallback" - tries multiple extraction strategies if the primary fails
     * 
     * @param preferM4A If true, prefer M4A format for metadata embedding
     * @param autoQuality If true, use first available stream (faster startup)
     */
    private fun getStreamUrlInternal(videoId: String, cookies: String?, preferM4A: Boolean, autoQuality: Boolean, promise: Promise) {
        // Run on background thread to prevent UI freeze
        Thread {
            // Fallback URL formats to try (in order of preference)
            val urlFormats = listOf(
                "https://www.youtube.com/watch?v=$videoId",           // Standard YouTube
                "https://music.youtube.com/watch?v=$videoId",         // YouTube Music
                "https://www.youtube.com/embed/$videoId"              // Embed format
            )
            
            var lastError: Exception? = null
            var attemptCount = 0
            val maxAttempts = urlFormats.size + 1 // +1 for reinit attempt
            
            for (urlIndex in urlFormats.indices) {
                attemptCount++
                val url = urlFormats[urlIndex]
                
                try {
                    // Set cookies if provided
                    if (cookies != null && cookies.isNotEmpty()) {
                        NewPipeDownloaderInstance.downloader?.setCookies(cookies)
                    }

                    val service = ServiceList.YouTube
                    
                    if (urlIndex > 0) {
                        android.util.Log.d("StreamModule", "🔄 [Fallback $urlIndex] Trying alternative URL format: $url")
                    }
                    
                    // Get stream info (Synchronous Network Call)
                    val streamInfo = StreamInfo.getInfo(service, url)
                    
                    // Get audio streams
                    val audioStreams = streamInfo.audioStreams
                    
                    if (audioStreams.isEmpty()) {
                        // Zero audio streams usually means YouTube served a SABR-only
                        // response for this player client. Record it as a real error so
                        // the JS side reports the cause instead of a generic failure.
                        val detail = "No audio streams returned (videoStreams=" +
                            "${streamInfo.videoStreams.size}, " +
                            "videoOnly=${streamInfo.videoOnlyStreams.size}) - " +
                            "likely SABR enforcement / missing PO token"
                        android.util.Log.w("StreamModule", "No audio streams for URL format $urlIndex: $detail")
                        lastError = Exception(detail)
                        continue
                    }
                    
                    // Stream selection depends on use case:
                    // - For DOWNLOAD (preferM4A = true): Prefer M4A for metadata embedding support
                    // - For STREAMING with autoQuality = true: Use first available stream (faster)
                    // - For STREAMING with autoQuality = false: Smart selection (prefer Opus)
                    
                    val bestStream = if (preferM4A) {
                        // DOWNLOAD MODE: Prioritize M4A format for metadata embedding
                        val m4aStreams = audioStreams.filter { stream ->
                            val mimeType = stream.format?.mimeType ?: ""
                            val formatId = stream.formatId?.toString() ?: ""
                            mimeType.contains("mp4") || mimeType.contains("m4a") || 
                            formatId == "140" || formatId == "139"
                        }
                        
                        if (m4aStreams.isNotEmpty()) {
                            android.util.Log.d("StreamModule", "📥 [Download] Found ${m4aStreams.size} M4A streams, selecting best for metadata support")
                            m4aStreams.maxByOrNull { it.bitrate }
                        } else {
                            android.util.Log.w("StreamModule", "⚠️ No M4A streams found, falling back to highest bitrate")
                            audioStreams.maxByOrNull { it.bitrate }
                        }
                    } else if (autoQuality) {
                        // AUTO MODE: Use first available stream for faster playback start
                        android.util.Log.d("StreamModule", "🚀 [Auto] Using first available audio stream (fast mode)")
                        audioStreams.firstOrNull()
                    } else {
                        // SMART HIGH QUALITY MODE: Prefer Opus (WebM) codec, fallback to highest bitrate
                        android.util.Log.d("StreamModule", "🎵 [High] Smart selection: preferring Opus, fallback to highest bitrate")
                        audioStreams.maxByOrNull { stream ->
                            val mimeType = stream.format?.mimeType ?: ""
                            val isOpus = mimeType.contains("webm") || mimeType.contains("opus")
                            stream.bitrate + (if (isOpus) 50000 else 0)
                        }
                    }
                    
                    if (bestStream != null) {
                        // Return URL and metadata including format info
                        val result = com.facebook.react.bridge.Arguments.createMap()
                        result.putString("url", bestStream.content)
                        result.putString("title", streamInfo.name)
                        result.putString("author", streamInfo.uploaderName)
                        result.putDouble("duration", streamInfo.duration.toDouble())
                        result.putString("thumbnail", streamInfo.thumbnails.get(0).url)
                        
                        // Get format info
                        val formatId = bestStream.formatId?.toString() ?: ""
                        val formatSuffix = when {
                            formatId.contains("251") || formatId.contains("250") -> "opus"
                            formatId.contains("140") || formatId.contains("139") -> "m4a"
                            else -> "m4a"
                        }
                        
                        result.putString("mimeType", bestStream.format?.mimeType ?: "audio/mp4")
                        result.putString("format", formatSuffix)
                        result.putString("formatId", formatId)
                        result.putInt("bitrate", bestStream.bitrate)
                        
                        if (urlIndex > 0) {
                            android.util.Log.d("StreamModule", "✅ [Fallback $urlIndex] Successfully recovered using alternative URL")
                        }
                        
                        promise.resolve(result)
                        return@Thread
                    }
                } catch (e: Exception) {
                    lastError = e
                    val errorMessage = e.message?.lowercase() ?: ""
                    android.util.Log.w("StreamModule", "⚠️ [Attempt $attemptCount] Failed: ${e.message}")
                    
                    // If this is a session/reload error and we haven't tried reinit yet
                    val needsReinit = errorMessage.contains("reload") ||
                                     errorMessage.contains("refresh") ||
                                     errorMessage.contains("expired") ||
                                     errorMessage.contains("session") ||
                                     errorMessage.contains("timeout")
                    
                    // On last URL format, try reinitializing NewPipe completely
                    if (urlIndex == urlFormats.size - 1 && needsReinit) {
                        try {
                            android.util.Log.d("StreamModule", "🔧 [Recovery] Reinitializing NewPipe extractor...")
                            val client = OkHttpClient.Builder()
                                .connectTimeout(45, TimeUnit.SECONDS)  // Extended timeout for recovery
                                .readTimeout(45, TimeUnit.SECONDS)
                                .writeTimeout(45, TimeUnit.SECONDS)
                                .build()
                            val downloader = NewPipeDownloader(client)
                            NewPipe.init(downloader)
                            NewPipeDownloaderInstance.downloader = downloader
                            
                            Thread.sleep(500) // Brief pause before final attempt
                            
                            // One final attempt with the primary URL after reinit
                            val streamInfo = StreamInfo.getInfo(ServiceList.YouTube, urlFormats[0])
                            val audioStreams = streamInfo.audioStreams
                            
                            if (audioStreams.isNotEmpty()) {
                                val bestStream = if (autoQuality) {
                                    audioStreams.firstOrNull()
                                } else {
                                    audioStreams.maxByOrNull { stream ->
                                        val mimeType = stream.format?.mimeType ?: ""
                                        val isOpus = mimeType.contains("webm") || mimeType.contains("opus")
                                        stream.bitrate + (if (isOpus) 50000 else 0)
                                    }
                                }
                                
                                if (bestStream != null) {
                                    val result = com.facebook.react.bridge.Arguments.createMap()
                                    result.putString("url", bestStream.content)
                                    result.putString("title", streamInfo.name)
                                    result.putString("author", streamInfo.uploaderName)
                                    result.putDouble("duration", streamInfo.duration.toDouble())
                                    result.putString("thumbnail", streamInfo.thumbnails.get(0).url)
                                    
                                    val formatId = bestStream.formatId?.toString() ?: ""
                                    val formatSuffix = when {
                                        formatId.contains("251") || formatId.contains("250") -> "opus"
                                        formatId.contains("140") || formatId.contains("139") -> "m4a"
                                        else -> "m4a"
                                    }
                                    
                                    result.putString("mimeType", bestStream.format?.mimeType ?: "audio/mp4")
                                    result.putString("format", formatSuffix)
                                    result.putString("formatId", formatId)
                                    result.putInt("bitrate", bestStream.bitrate)
                                    
                                    android.util.Log.d("StreamModule", "✅ [Recovery] Successfully recovered after NewPipe reinit")
                                    promise.resolve(result)
                                    return@Thread
                                }
                            }
                        } catch (reinitError: Exception) {
                            android.util.Log.e("StreamModule", "❌ [Recovery] Reinit failed: ${reinitError.message}")
                            lastError = reinitError
                        }
                    }
                    
                    // Continue to next URL format
                    continue
                }
            }
            
            // All attempts failed
            android.util.Log.e("StreamModule", "❌ All ${attemptCount} extraction attempts failed for $videoId")
            promise.reject("STREAM_ERROR", lastError?.message ?: "All extraction strategies failed", lastError)
        }.start()
    }
}

object NewPipeDownloaderInstance {
    var downloader: NewPipeDownloader? = null
}
