package com.triptych.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.util.Size;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// "Music on this device" on Android: lists the phone's music from MediaStore
// (the same index every music app reads) in the shape localLibrary.js
// expects, and serves the files and album covers to the WebView under
// /_triptych_local_/ on the app's own origin. Served here rather than via
// Capacitor.convertFileSrc because Capacitor's local server answers a Range
// request from the start of the file, which breaks seeking in a song.
@CapacitorPlugin(
    name = "TriptychLocalMusic",
    permissions = {
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class LocalMusicPlugin extends Plugin {
    private static final String PATH_PREFIX = "/_triptych_local_/";
    private static final int COVER_PX = 512;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private File coversDir;

    // READ_MEDIA_AUDIO replaced READ_EXTERNAL_STORAGE for audio in Android 13.
    private static String permissionAlias() {
        return Build.VERSION.SDK_INT >= 33 ? "audio" : "storage";
    }

    @Override
    public void load() {
        coversDir = new File(getContext().getCacheDir(), "local-covers");
        Bridge bridge = getBridge();
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String path = request.getUrl().getPath();
                if (path != null && path.startsWith(PATH_PREFIX)) return serve(request, path.substring(PATH_PREFIX.length()));
                return super.shouldInterceptRequest(view, request);
            }
        });
    }

    @PluginMethod
    public void checkAccess(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState(permissionAlias()) == PermissionState.GRANTED);
        call.resolve(result);
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (getPermissionState(permissionAlias()) == PermissionState.GRANTED) {
            checkAccess(call);
            return;
        }
        requestPermissionForAlias(permissionAlias(), call, "accessCallback");
    }

    @PermissionCallback
    private void accessCallback(PluginCall call) {
        checkAccess(call);
    }

    // Every song in MediaStore marked as music. Covers are written to the
    // cache once per album (the first scan of a big library takes a few
    // seconds for that), so the list can say which albums have one.
    @PluginMethod
    public void getTracks(PluginCall call) {
        if (getPermissionState(permissionAlias()) != PermissionState.GRANTED) {
            call.reject("No permission to read music on this device.", "permission");
            return;
        }
        executor.execute(() -> {
            try {
                call.resolve(queryTracks());
            } catch (Exception e) {
                call.reject("Could not read the music on this device: " + e.getMessage(), "query_failed", e);
            }
        });
    }

    private JSObject queryTracks() {
        ContentResolver resolver = getContext().getContentResolver();
        JSArray tracks = new JSArray();
        Map<Long, String> covers = new HashMap<>();
        Set<Long> albums = new LinkedHashSet<>();
        String selection = MediaStore.Audio.Media.IS_MUSIC + " != 0";
        // null projection: some columns (album_artist, genre) only exist on
        // newer Android versions, and naming a missing one makes the query throw.
        try (Cursor c = resolver.query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, null, selection, null, null)) {
            if (c != null) {
                int total = c.getCount();
                int done = 0;
                while (c.moveToNext()) {
                    long id = getLong(c, MediaStore.Audio.Media._ID);
                    long albumId = getLong(c, MediaStore.Audio.Media.ALBUM_ID);
                    if (!albums.contains(albumId)) {
                        albums.add(albumId);
                        String cover = ensureCover(resolver, albumId);
                        if (cover != null) covers.put(albumId, cover);
                    }
                    int trackField = (int) getLong(c, MediaStore.Audio.Media.TRACK);
                    JSObject t = new JSObject();
                    t.put("id", "lt" + id);
                    t.put("title", orDefault(getString(c, MediaStore.Audio.Media.TITLE), getString(c, MediaStore.Audio.Media.DISPLAY_NAME)));
                    t.put("artists", splitArtists(getString(c, MediaStore.Audio.Media.ARTIST)));
                    t.put("albumArtist", cleanTag(getString(c, "album_artist")));
                    t.put("album", cleanTag(getString(c, MediaStore.Audio.Media.ALBUM)));
                    // TRACK packs the disc in as disc * 1000 + track.
                    putPositive(t, "track", trackField % 1000);
                    putPositive(t, "disc", trackField / 1000);
                    putPositive(t, "year", (int) getLong(c, MediaStore.Audio.Media.YEAR));
                    JSArray genres = new JSArray();
                    String genre = cleanTag(getString(c, "genre"));
                    if (genre != null) genres.put(genre);
                    t.put("genres", genres);
                    t.put("duration", getLong(c, MediaStore.Audio.Media.DURATION) / 1000.0);
                    t.put("addedMs", getLong(c, MediaStore.Audio.Media.DATE_ADDED) * 1000);
                    t.put("gain", JSObject.NULL);
                    t.put("cover", covers.containsKey(albumId) ? covers.get(albumId) : JSObject.NULL);
                    tracks.put(t);
                    done++;
                    if (done % 50 == 0 || done == total) {
                        JSObject progress = new JSObject();
                        progress.put("done", done);
                        progress.put("total", total);
                        notifyListeners("scanProgress", progress);
                    }
                }
            }
        }
        JSObject result = new JSObject();
        result.put("tracks", tracks);
        return result;
    }

    // Returns the album id as the cover tag when a cover exists (cached as
    // <id>.jpg), or null.
    private String ensureCover(ContentResolver resolver, long albumId) {
        File file = new File(coversDir, albumId + ".jpg");
        if (file.exists()) return String.valueOf(albumId);
        Bitmap bitmap = null;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                Uri albumUri = ContentUris.withAppendedId(MediaStore.Audio.Albums.EXTERNAL_CONTENT_URI, albumId);
                bitmap = resolver.loadThumbnail(albumUri, new Size(COVER_PX, COVER_PX), null);
            } else {
                Uri art = ContentUris.withAppendedId(Uri.parse("content://media/external/audio/albumart"), albumId);
                try (InputStream in = resolver.openInputStream(art)) {
                    bitmap = BitmapFactory.decodeStream(in);
                }
            }
        } catch (Exception e) {
            return null;
        }
        if (bitmap == null) return null;
        try {
            coversDir.mkdirs();
            try (FileOutputStream out = new FileOutputStream(file)) {
                bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out);
            }
            return String.valueOf(albumId);
        } catch (IOException e) {
            file.delete();
            return null;
        }
    }

    // ---------- Serving ----------

    private WebResourceResponse serve(WebResourceRequest request, String rest) {
        try {
            if (rest.startsWith("track/lt")) {
                long id = Long.parseLong(rest.substring("track/lt".length()));
                Uri uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id);
                String mime = getContext().getContentResolver().getType(uri);
                ParcelFileDescriptor pfd = getContext().getContentResolver().openFileDescriptor(uri, "r");
                if (pfd == null) return notFound();
                return rangeResponse(pfd, mime != null ? mime : "audio/mpeg", rangeHeader(request));
            }
            if (rest.startsWith("cover/")) {
                File file = new File(coversDir, Long.parseLong(rest.substring("cover/".length())) + ".jpg");
                if (!file.exists()) return notFound();
                ParcelFileDescriptor pfd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
                return rangeResponse(pfd, "image/jpeg", null);
            }
        } catch (Exception e) {
            return notFound();
        }
        return notFound();
    }

    private static String rangeHeader(WebResourceRequest request) {
        Map<String, String> headers = request.getRequestHeaders();
        String range = headers.get("Range");
        return range != null ? range : headers.get("range");
    }

    private WebResourceResponse rangeResponse(ParcelFileDescriptor pfd, String mime, String range) throws IOException {
        long size = pfd.getStatSize();
        long start = 0;
        long end = size - 1;
        boolean partial = false;
        if (range != null && range.startsWith("bytes=") && size > 0) {
            String[] parts = range.substring(6).split("-", -1);
            try {
                if (!parts[0].isEmpty()) {
                    start = Long.parseLong(parts[0].trim());
                    if (parts.length > 1 && !parts[1].trim().isEmpty()) end = Math.min(Long.parseLong(parts[1].trim()), size - 1);
                } else if (parts.length > 1 && !parts[1].trim().isEmpty()) {
                    start = Math.max(0, size - Long.parseLong(parts[1].trim()));
                }
                partial = true;
            } catch (NumberFormatException ignored) {
                // malformed: send the whole file
            }
        }
        Map<String, String> headers = new HashMap<>();
        headers.put("Accept-Ranges", "bytes");
        headers.put("Access-Control-Allow-Origin", "*");
        if (partial && start > end) {
            pfd.close();
            headers.put("Content-Range", "bytes */" + size);
            return new WebResourceResponse(mime, null, 416, "Range Not Satisfiable", headers, null);
        }
        FileInputStream in = new ParcelFileDescriptor.AutoCloseInputStream(pfd);
        long skipped = 0;
        while (skipped < start) {
            long n = in.skip(start - skipped);
            if (n <= 0) break;
            skipped += n;
        }
        long length = end - start + 1;
        headers.put("Content-Length", String.valueOf(length));
        if (partial) headers.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
        return new WebResourceResponse(mime, null, partial ? 206 : 200, partial ? "Partial Content" : "OK", headers, new LimitedInputStream(in, length));
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), null);
    }

    // Stops at the end of the requested range.
    private static class LimitedInputStream extends FilterInputStream {
        private long remaining;

        LimitedInputStream(InputStream in, long limit) {
            super(in);
            remaining = limit;
        }

        @Override
        public int read() throws IOException {
            if (remaining <= 0) return -1;
            int b = super.read();
            if (b >= 0) remaining--;
            return b;
        }

        @Override
        public int read(byte[] buf, int off, int len) throws IOException {
            if (remaining <= 0) return -1;
            int n = super.read(buf, off, (int) Math.min(len, remaining));
            if (n > 0) remaining -= n;
            return n;
        }

        @Override
        public int available() throws IOException {
            return (int) Math.min(super.available(), remaining);
        }
    }

    // ---------- Cursor helpers ----------

    private static long getLong(Cursor c, String column) {
        int i = c.getColumnIndex(column);
        return i >= 0 && !c.isNull(i) ? c.getLong(i) : 0;
    }

    private static String getString(Cursor c, String column) {
        int i = c.getColumnIndex(column);
        return i >= 0 && !c.isNull(i) ? c.getString(i) : null;
    }

    // MediaStore fills missing tags with "<unknown>".
    private static String cleanTag(String value) {
        if (value == null) return null;
        String v = value.trim();
        return v.isEmpty() || v.equals("<unknown>") ? null : v;
    }

    private static String orDefault(String value, String fallback) {
        String v = cleanTag(value);
        if (v != null) return v;
        String f = cleanTag(fallback);
        if (f == null) return "Unknown";
        int dot = f.lastIndexOf('.');
        return dot > 0 ? f.substring(0, dot) : f;
    }

    private static JSArray splitArtists(String value) {
        JSArray out = new JSArray();
        String v = cleanTag(value);
        if (v == null) return out;
        Set<String> seen = new HashSet<>();
        for (String part : v.split(";")) {
            String p = part.trim();
            if (!p.isEmpty() && seen.add(p)) out.put(p);
        }
        return out;
    }

    private static void putPositive(JSObject obj, String key, int value) {
        if (value > 0) obj.put(key, value);
        else obj.put(key, JSObject.NULL);
    }
}
