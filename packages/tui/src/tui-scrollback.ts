import { type Component, type TUI, TuiBase } from "./tui.ts";
import { BoundedTerminalWriter } from "./tui-main-screen.ts";

/**
 * Renderer that owns only a bottom viewport and streams everything else into the terminal's own
 * scrollback.
 *
 * Why this exists: `TuiMainScreen` and `TuiAltScreen` both keep the whole transcript in the
 * component tree, so every frame renders every message and every tool result and only then clips
 * to the screen. Cost is O(transcript) per frame, which is why scrolling degrades as a session
 * grows. This renderer follows the model used by codex (`codex-rs/tui/src/insert_history.rs`)
 * instead: the renderer never owns committed content.
 *
 * How it works. The screen is split into two regions:
 *
 *     row 0
 *      |-- scroll region (rows 1 .. viewportTop)   committed content, owned by the terminal
 *      `-- viewport       (viewportTop+1 ..)       owned by this renderer, diffed each frame
 *
 * `commit()` restricts the terminal's scroll region to the rows above the viewport and writes the
 * finished lines there. Because only that region scrolls, each newline pushes the oldest committed
 * line into the terminal's scrollback and leaves the viewport untouched. Scrollback is then the
 * terminal's problem - Ghostty renders it on the GPU - so scrolling back through history costs
 * this process nothing at all.
 *
 * The viewport is sized from its content each frame, capped by `setViewport`'s row budget and by
 * the screen. Growing it takes rows away from the scroll region, so those rows are scrolled into
 * scrollback first; without that, committed lines that had not yet left the screen would be
 * overwritten and lost.
 */
export class TuiScrollback extends TuiBase implements TUI {
	readonly mode = "scrollback" as const;

	/**
	 * Run in the alternate screen, the way codex does by default.
	 *
	 * Not cosmetic. tmux's default wheel binding is:
	 *
	 *   WheelUpPane -> if-shell -F "#{||:#{alternate_on},#{pane_in_mode},#{mouse_any_flag}}" \
	 *       { send-keys -M } { copy-mode -e }
	 *
	 * On the main screen none of those flags hold, so the wheel opens copy-mode and copy-mode owns
	 * the keyboard: typing after a scroll goes to tmux rather than to the application. In the
	 * alternate screen `alternate_on` is true, so the wheel is forwarded to the application instead.
	 * This renderer ignores mouse input, so the wheel does nothing and the keyboard always reaches
	 * the input - which is how codex's default mode behaves, and why it feels smooth.
	 *
	 * The cost, shared with codex: the alternate screen has no scrollback, so committed lines are
	 * gone once they scroll off. codex answers that with its Ctrl+T transcript pager.
	 */
	protected override beforeTerminalStart(): void {
		this.terminal.write("\x1b[?1049h");
	}

	protected override beforeTerminalStop(): void {
		this.terminal.write("\x1b[?1049l");
	}

	private viewportComponent: Component | undefined;
	/** Upper bound on viewport rows, from the last `setViewport`. */
	private maxViewportRows = 0;
	/** Rows the viewport currently occupies. */
	private viewportHeight = 0;
	private previousViewportLines: string[] = [];
	private previousWidth = 0;
	/** 0-based row where the viewport starts. Everything above it belongs to the terminal. */
	private viewportTop = 0;
	/** Set by resetScrollback; the next frame clears the screen before repainting. */
	private needsClear = false;
	/**
	 * Committed lines waiting to be written above the viewport.
	 *
	 * Accumulated rather than written by `commit()`, and flushed once per frame after any clear,
	 * which is how codex does it (`pending_history_lines` in Tui::draw). Writing straight from
	 * commit() meant a rebuild's clear could land after the content it was meant to replace: the
	 * drain runs at the start of the frame, so its lines were already on screen when the clear fired,
	 * and the transcript ended up written twice.
	 */
	private pendingHistoryLines: string[] = [];
	/** Rows the scroll region must give up before the history flush, set by resizeViewport. */
	private pendingScroll = 0;
	private beforeRender: (() => void) | undefined;

	/** Rows this renderer currently owns at the bottom of the screen. */
	get viewportRows(): number {
		return this.viewportHeight;
	}

	/**
	 * Called at the start of every frame, before the viewport is measured.
	 *
	 * The presentation uses this to move finished content out of its component tree and into
	 * scrollback, which is what keeps a frame O(viewport). Running it here rather than at each
	 * mutation site means the presentation does not need a call on every path that changes content.
	 */
	setBeforeRender(callback: (() => void) | undefined): void {
		this.beforeRender = callback;
	}

	/**
	 * Set the component drawn in the bottom region, and the maximum rows it may use.
	 *
	 * The actual height is measured from the component every frame and clamped to `maxRows`, so a
	 * caller can pass the live tail plus its dock and let the viewport grow and shrink with it.
	 */
	setViewport(component: Component | undefined, maxRows: number): void {
		this.viewportComponent = component;
		this.maxViewportRows = Math.max(0, Math.floor(maxRows));
		this.previousViewportLines = [];
		this.requestRender(true);
	}

	/**
	 * Discard the committed history and the viewport, for a caller that is about to re-render the
	 * whole transcript.
	 *
	 * Rebuild paths (initial load, compaction, tree navigation, settings change, session switch)
	 * re-create every item from the session entries. Without this they would be committed on top of
	 * the previous copy and the transcript would appear twice.
	 *
	 * Only records the intent: the screen is cleared at the start of the next frame, inside the same
	 * synchronized update as the viewport repaint. Clearing here instead leaves the terminal showing
	 * an empty screen until that frame lands, and a rebuild runs several times during startup, so the
	 * display flickered - the input appeared to jump in and out of place.
	 */
	resetScrollback(): void {
		if (this.stopped) return;
		this.viewportTop = 0;
		this.viewportHeight = 0;
		this.previousViewportLines = [];
		this.previousWidth = 0;
		this.needsClear = true;
	}

	/**
	 * Queue finished lines to be written above the viewport on the next frame.
	 *
	 * The caller is responsible for not committing content it still needs to update: once written,
	 * this renderer can no longer change or remove it.
	 */
	commit(lines: readonly string[]): void {
		if (lines.length === 0 || this.stopped) return;
		for (const line of lines) this.pendingHistoryLines.push(line);
	}

	protected doRender(): void {
		if (this.stopped) return;
		this.beforeRender?.();
		const width = Math.max(1, this.terminal.columns);
		const rows = Math.max(1, this.terminal.rows);

		const rendered = this.viewportComponent ? this.viewportComponent.render(width) : [];
		const desired = Math.min(rendered.length, this.maxViewportRows, Math.max(0, rows - 1));
		this.resizeViewport(rows, desired);

		// Follow the end: a live tail taller than the viewport shows its newest lines, which are the
		// ones the user is watching.
		const offset = Math.max(0, rendered.length - this.viewportHeight);
		let viewportLines: string[] = [];
		for (let row = 0; row < this.viewportHeight; row++) {
			viewportLines.push(rendered[offset + row] ?? "");
		}
		if (this.hasOverlayEntries) {
			viewportLines = this.compositeOverlays(viewportLines, width, this.viewportHeight);
		}

		const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
		output.append("\x1b[?2026h");
		if (this.needsClear) {
			// Clear the screen and the scrollback above it in the same synchronized update as the
			// repaint below, so the terminal never displays the cleared state.
			this.needsClear = false;
			this.pendingHistoryLines = [];
			output.append("\x1b[2J\x1b[H\x1b[3J");
		}
		// Give the viewport its new rows first, then write the queued history into what is left.
		// Both are inside this one synchronized update, so the screen never shows an intermediate
		// state - and a clear, if any, has already happened above.
		if (this.pendingScroll > 0 && this.viewportTop > 0) {
			output.append(`\x1b[1;${this.viewportTop}r`);
			output.append(`\x1b[${this.viewportTop};1H`);
			for (let i = 0; i < Math.min(this.pendingScroll, this.viewportTop); i++) output.append("\r\n");
			output.append("\x1b[r");
		}
		this.pendingScroll = 0;
		if (this.pendingHistoryLines.length > 0 && this.viewportTop > 0) {
			// Limit scrolling to the rows above the viewport, so writing newlines there scrolls only
			// those rows and leaves the viewport exactly as it was.
			output.append(`\x1b[1;${this.viewportTop}r`);
			output.append(`\x1b[${this.viewportTop};1H`);
			for (const line of this.pendingHistoryLines) {
				output.append("\r\n");
				output.append("\x1b[K");
				output.append(line);
			}
			output.append("\x1b[r"); // Reset the scroll region to the full screen
		}
		this.pendingHistoryLines = [];
		const widthChanged = this.previousWidth !== width;
		for (let row = 0; row < viewportLines.length; row++) {
			const line = viewportLines[row] ?? "";
			if (!widthChanged && this.previousViewportLines[row] === line) continue;
			output.append(`\x1b[${this.viewportTop + row + 1};1H`);
			output.append("\x1b[K");
			output.append(line);
		}
		// Park the cursor on the last viewport row so it never sits in the scroll region.
		if (this.viewportHeight > 0) {
			output.append(`\x1b[${this.viewportTop + this.viewportHeight};1H`);
		}
		output.append("\x1b[?2026l");
		output.flush();

		this.previousViewportLines = viewportLines;
		this.previousWidth = width;
		this.fullRedrawCount += 1;
	}

	/**
	 * Move the viewport's top edge and repaint it.
	 *
	 * Growing the viewport takes rows that the scroll region was using. Those rows may hold
	 * committed lines that have not scrolled off yet, so scroll the region up by the same amount
	 * first: the lines leave for scrollback instead of being painted over.
	 */
	private resizeViewport(rows: number, desired: number): void {
		const grow = desired - this.viewportHeight;
		if (grow > 0) this.pendingScroll = Math.min(grow, this.viewportTop);
		this.viewportHeight = desired;
		this.viewportTop = Math.max(0, rows - desired);
		if (grow !== 0) this.previousViewportLines = [];
	}
}
