import { Container, Text } from "@earendil-works/pi-tui";
import { theme } from "./theme/theme.ts";

/**
 * Transcript container that keeps only the tail of its children.
 *
 * The interactive transcript mounts every item it has ever rendered, so a long session makes one
 * frame cost the whole history: at 3,200 messages the transcript holds about 1.4M lines and a full
 * layout pass takes roughly 137 ms. Dropping items from the top once the rendered transcript
 * exceeds the line budget bounds a frame by the window instead of by the session.
 *
 * Trimming measures children from the end and stops as soon as the budget is exceeded, so a burst
 * of additions (resuming a long session, or a compaction re-render) does not measure the whole
 * history.
 */
export class TranscriptWindow extends Container {
	private readonly getLineBudget: () => number;
	private dropped = 0;
	private notice?: Text;
	private noticeText = "";

	constructor(getLineBudget: () => number) {
		super();
		this.getLineBudget = getLineBudget;
	}

	/** Items dropped from the top since the last `clear()`. */
	get droppedItems(): number {
		return this.dropped;
	}

	override clear(): void {
		super.clear();
		this.dropped = 0;
		this.notice = undefined;
		this.noticeText = "";
	}

	override render(width: number): string[] {
		this.trim(width);
		return super.render(width);
	}

	private trim(width: number): void {
		// The notice is re-inserted after trimming so it never counts against the budget.
		if (this.notice !== undefined) {
			const index = this.children.indexOf(this.notice);
			if (index !== -1) {
				this.children.splice(index, 1);
			}
		}

		const budget = Math.floor(this.getLineBudget());
		const children = this.children;
		if (budget > 0 && children.length > 1) {
			let kept = 0;
			let start = children.length;
			for (let index = children.length - 1; index >= 0; index--) {
				const height = children[index].render(width).length;
				// Always keep the last child, even when it alone exceeds the budget.
				if (kept > 0 && kept + height > budget) {
					break;
				}
				kept += height;
				start = index;
			}
			if (start > 0) {
				this.dropped += children.splice(0, start).length;
			}
		}

		this.syncNotice();
	}

	private syncNotice(): void {
		if (this.dropped === 0) {
			return;
		}
		const text = theme.fg("dim", `… ${this.dropped.toLocaleString()} earlier transcript items hidden`);
		if (this.notice === undefined) {
			this.notice = new Text(text, 0, 0);
		} else if (text !== this.noticeText) {
			this.notice.setText(text);
		}
		this.noticeText = text;
		this.children.unshift(this.notice);
	}
}
