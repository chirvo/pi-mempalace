/**
 * notifier.ts — Stateful notification trackers for pi-mempalace.
 *
 * Extracted so tests can validate notification logic without
 * depending on pi's ExtensionAPI or TUI.
 */

/**
 * Tracks whether the first-time auto-capture notification
 * has been shown in the current session.
 *
 * Used in the `turn_end` hook: on first successful auto-capture,
 * the extension shows a one-time info notification per session.
 */
export class CaptureNotifier {
  private notified = false;

  /** Whether the user has been notified this session. */
  get hasNotified(): boolean {
    return this.notified;
  }

  /**
   * Mark as notified. Returns true if this is the first call
   * (caller should show a notification). Returns false if
   * already notified (no action needed).
   */
  markNotified(): boolean {
    if (this.notified) return false;
    this.notified = true;
    return true;
  }

  /** Reset for new session. */
  reset(): void {
    this.notified = false;
  }
}
