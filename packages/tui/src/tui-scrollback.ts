import type { Terminal } from "./terminal.ts";
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
 *      ├─ scroll region (rows 1 .. viewportTop)   committed content, owned by the terminal
 *      └─ viewport       (rows viewportTop+1 ..)  owned by this renderer, diffed each frame
 *
 * `commit()` restricts the terminal's scroll region to the rows above the viewport and writes the
 * finished lines there. Because only that region is scrollable, each newline pushes the oldest
 * committed line into the terminal's scrollback and leaves the viewport untouched. Scrollback is
 * then the terminal's problem - Ghostty renders it on the GPU - so scrolling back through history
 * costs this process nothing at all.
 *
 * Per-frame cost is therefore O(viewport) regardless of how long the session is, and history is
 * still scrollable. That is the combination neither existing mode gives: `regular` has terminal
 * scrollback but no pinned bottom region, `fullscreen` has the pinned region but pays O(transcript).
 */
export class TuiScrollback extends TuiBase implements TUI {
	readonly mode = "scrollback" as const;

	private viewportComponent: Component | undefined;
	private viewportHeight = 0;
	private previousViewportLines: string[] = [];
	private previousWidth = 0;
	/** 0-based row where the viewport starts. Everything above it belongs to the terminal. */
	private viewportTop = 0;
	/** Whether the viewport region has been placed at the bottom of the screen yet. */
	private viewportPlaced = false;

	/** Rows this renderer owns at the bottom of the screen. */
	get viewportRows(): number {
		return this.viewportHeight;
	}

	/**
	 * Set the component drawn in the bottom region, and how many rows it may use.
	 *
	 * The viewport is repainted from scratch, because a height change moves every row in it.
	 */
	setViewport(component: Component | undefined, height: number): void {
		this.viewportComponent = component;
		this.viewportHeight = Math.max(0, Math.floor(height));
		this.viewportPlaced = false;
		this.previousViewportLines = [];
		this.requestRender(true);
	}

	/**
	 * Write finished lines above the viewport, scrolling older ones into the terminal's scrollback.
	 *
	 * The caller is responsible for not committing content it still needs to update: once a line
	 * is in the terminal's scrollback this renderer can no longer change or remove it.
	 */
	commit(lines: readonly string[]): void {
		if (lines.length === 0 || this.stopped) return;
		this.placeViewport();
		if (this.viewportTop === 0) {
			// No room above the viewport: nothing can scroll, so drop the lines rather than
			// overwrite the viewport.
			return;
		}

		const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
		output.append("\x1b[?2026h"); // Begin synchronized output
		// Limit scrolling to the rows above the viewport. Writing newlines at the bottom of that
		// region then scrolls only those rows, so committed lines leave through the top and the
		// viewport is left exactly as it was.
		output.append(`\x1b[1;${this.viewportTop}r`);
		output.append(`\x1b[${this.viewportTop};1H`);
		for (const line of lines) {
			output.append("\r\n");
			output.append("\x1b[K");
			output.append(line);
		}
		output.append("\x1b[r"); // Reset the scroll region to the full screen
		output.append("\x1b[?2026l");
		output.flush();

		// The viewport content did not change, but the cursor is now in the scroll region. Repaint
		// so it returns to the viewport; the diff makes that a cursor move and nothing else.
		this.requestRender(true);
	}

	protected doRender(): void {
		if (this.stopped) return;
		const width = Math.max(1, this.terminal.columns);
		this.placeViewport();

		const rendered = this.viewportComponent ? this.viewportComponent.render(width) : [];
		let viewportLines: string[] = [];
		for (let row = 0; row < this.viewportHeight; row++) {
			viewportLines.push(rendered[row] ?? "");
		}
		if (this.hasOverlayEntries) {
			viewportLines = this.compositeOverlays(viewportLines, width, this.viewportHeight);
		}

		const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
		output.append("\x1b[?2026h");
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
	 * Put the cursor on the viewport's first row, scrolling the screen down so the viewport sits at
	 * the bottom. Done once per viewport placement: after this the viewport is anchored and
	 * `commit()` streams into the rows above it.
	 */
	private placeViewport(): void {
		const rows = Math.max(1, this.terminal.rows);
		this.viewportTop = Math.max(0, rows - this.viewportHeight);
		if (this.viewportPlaced) return;
		this.viewportPlaced = true;
		this.previousViewportLines = [];
		// The cursor starts at the top of a blank screen. Scrolling it down by viewportTop rows
		// leaves the cursor exactly at the top of the viewport region.
		if (this.viewportTop > 0) {
			this.terminal.write("\n".repeat(this.viewportTop));
		}
	}
}

/** Re-exported so callers can construct a scrollback renderer without reaching into the class. */
export type TuiScrollbackTerminal = Terminal;
