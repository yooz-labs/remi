import type { FileDownloadController } from './file-download';

const URL_LIFETIME_MS = 30_000;

/** Owns one local download URL. A request means browser handoff, not durable file storage. */
export class FileDownloadSave {
  private objectUrl: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') this.clear();
  };

  private readonly onPageHide = () => this.clear();

  constructor() {
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
  }

  /** Call only from the explicit Save gesture for the currently selected controller. */
  request(controller: FileDownloadController): boolean {
    if (this.disposed || document.visibilityState === 'hidden') return false;
    // A later explicit attempt replaces the prior URL; there is never a retained URL queue.
    this.clear();
    let anchor: HTMLAnchorElement | null = null;
    try {
      const file = controller.copyVerifiedFile();
      if (!file) return false;
      const blob = new Blob([file.bytes], { type: 'application/octet-stream' });
      const objectUrl = URL.createObjectURL(blob);
      this.objectUrl = objectUrl;
      this.timer = setTimeout(() => this.clear(), URL_LIFETIME_MS);
      anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = file.fileName;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      return true;
    } catch {
      this.clear();
      return false;
    } finally {
      anchor?.remove();
    }
  }

  /** Dismissal, context loss and owner disposal release the handoff immediately. */
  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const objectUrl = this.objectUrl;
    this.objectUrl = null;
    if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pagehide', this.onPageHide);
  }
}
