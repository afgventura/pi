/**
 * Capture terminal output written by code that is not the TUI.
 *
 * A running TUI owns the terminal: it positions the cursor itself and repaints only the rows that
 * changed. A stray write from an extension or library (console.log, an SDK printing an auth URL)
 * lands at the cursor position and shifts the screen under the renderer, which then paints its
 * next frame over the wrong rows.
 *
 * captureForeignOutput() takes over process.stdout/stderr writes while the TUI runs and hands the
 * host complete lines to display inside the TUI. TUI-owned writes must go through writeTtyOutput()
 * so frames are never captured as foreign output.
 */

export interface ForeignOutputCapture {
	/** Flush the buffered partial line, restore the original writers, and stop capturing. */
	release(): void;
}

interface ActiveCapture {
	rawStdoutWrite: typeof process.stdout.write;
}

/** A partial line without a newline is still worth showing; flush it after a short delay. */
const PARTIAL_LINE_FLUSH_MS = 100;

/** One escape sequence at the current position. Sticky: the caller sets lastIndex. */
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|(?:\]|_)[^\x07\x1b]*(?:\x07|\x1b\\)?|[\x30-\x7e])/y;

/** Select Graphic Rendition: colors and attributes, the only sequences safe inside a drawn row. */
const SGR_SEQUENCE = /^\x1b\[[0-9;]*m$/;

/** Control characters that would move the real cursor inside a row. Tab is kept: rows measure it. */
function isControlCharacter(character: string): boolean {
	const code = character.charCodeAt(0);
	return code === 0x7f || (code < 0x20 && code !== 0x09);
}

let activeCapture: ActiveCapture | undefined;

/**
 * Keep SGR sequences and drop every other escape or control character. Captured text is composited
 * into rows the renderer already positioned, so anything that moves the cursor corrupts the frame.
 */
export function sanitizeForeignLine(line: string): string {
	let result = "";
	let index = 0;
	while (index < line.length) {
		ESCAPE_SEQUENCE.lastIndex = index;
		const sequence = ESCAPE_SEQUENCE.exec(line)?.[0];
		if (sequence) {
			if (SGR_SEQUENCE.test(sequence)) result += sequence;
			index += sequence.length;
			continue;
		}
		const character = line[index]!;
		if (!isControlCharacter(character)) result += character;
		index += 1;
	}
	return result;
}

/**
 * Write TUI-owned output. Bypasses an active capture (see captureForeignOutput) while honoring any
 * writer that was installed before the capture, such as a host redirecting stdout to stderr.
 */
export function writeTtyOutput(data: string): void {
	if (activeCapture) {
		activeCapture.rawStdoutWrite(data);
		return;
	}
	process.stdout.write(data);
}

/**
 * Route writes to process.stdout/stderr from code other than the TUI into onLine while the TUI owns
 * the terminal. Nested captures are ignored: only one owner can hold the writers.
 */
export function captureForeignOutput(onLine: (line: string) => void): ForeignOutputCapture {
	if (activeCapture) {
		return { release() {} };
	}

	const originalStdoutWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;
	const rawStdoutWrite = originalStdoutWrite.bind(process.stdout);

	let buffer = "";
	let flushTimer: NodeJS.Timeout | undefined;

	const emitLine = (line: string): void => {
		const sanitized = sanitizeForeignLine(line);
		if (sanitized.trim().length === 0) return;
		onLine(sanitized);
	};

	const flushPartialLine = (): void => {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		if (buffer.length === 0) return;
		const line = buffer;
		buffer = "";
		emitLine(line);
	};

	const schedulePartialLineFlush = (): void => {
		if (buffer.length === 0 || flushTimer) return;
		flushTimer = setTimeout(flushPartialLine, PARTIAL_LINE_FLUSH_MS);
		flushTimer.unref();
	};

	const pushText = (text: string): void => {
		buffer += text;
		const segments = buffer.split(/\r\n|\n|\r/);
		buffer = segments.pop() ?? "";
		for (const segment of segments) emitLine(segment);
		schedulePartialLineFlush();
	};

	const captureWrite = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
		pushText(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding));
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		if (done) process.nextTick(done);
		return true;
	}) as typeof process.stdout.write;

	activeCapture = { rawStdoutWrite };
	process.stdout.write = captureWrite;
	process.stderr.write = captureWrite;

	return {
		release(): void {
			flushPartialLine();
			if (activeCapture?.rawStdoutWrite === rawStdoutWrite) {
				activeCapture = undefined;
			}
			// Another owner may have replaced a writer in the meantime; leave theirs in place.
			if (process.stdout.write === captureWrite) {
				process.stdout.write = originalStdoutWrite;
			}
			if (process.stderr.write === captureWrite) {
				process.stderr.write = originalStderrWrite;
			}
		},
	};
}
