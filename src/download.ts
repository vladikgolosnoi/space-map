/** Native Android streams this Blob into a user-selected document. iOS uses WKDownload. */
export function saveDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const native = (window as Window & {
    SpaceMapNative?: { saveBlob: (url: string, filename: string, mime: string) => void };
  }).SpaceMapNative;
  if (navigator.userAgent.includes('SpaceMapNative/Android') && native) {
    try {
      native.saveBlob(url, filename, blob.type);
      // The native document picker owns the URL until save/cancel has completed.
      return;
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
