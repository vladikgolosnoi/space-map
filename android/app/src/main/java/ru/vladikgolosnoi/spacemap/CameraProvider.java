package ru.vladikgolosnoi.spacemap;

import android.app.*;
import android.content.*;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.*;
import android.provider.OpenableColumns;
import java.io.*;

/** Grants the camera access to one temporary image, never arbitrary filesystem paths. */
public class CameraProvider extends ContentProvider {
    public boolean onCreate() { return true; }
    private File image(Uri uri) throws FileNotFoundException {
        String path = uri.getPath();
        if (path == null || !path.matches("/capture-[a-f0-9-]{36}\\.jpg")) throw new FileNotFoundException();
        return new File(getContext().getCacheDir(), path.substring(1));
    }
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        return ParcelFileDescriptor.open(image(uri), ParcelFileDescriptor.parseMode(mode));
    }
    public String getType(Uri uri) { return "image/jpeg"; }
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        MatrixCursor cursor = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        try { cursor.addRow(new Object[]{image(uri).getName(), image(uri).length()}); } catch (IOException ignored) {}
        return cursor;
    }
    public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    public int delete(Uri uri, String selection, String[] args) { return 0; }
    public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }
}
