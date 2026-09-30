import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { resolvePath } from "../../utils/paths.ts";
import type { ExtensionContext, ProjectTrustContext, ToolDefinition } from "../extensions/types.ts";
import type { SessionCwdChange } from "../session-manager.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const setCwdSchema = Type.Object({
	path: Type.String({
		description:
			"Directory to use as the session working directory. Absolute, or relative to the current working directory.",
	}),
});

export const setCwdToolSystemPromptContribution = {
	snippet: "Change the session working directory",
	guidelines: [
		"The working directory persists across tool calls. Use set_cwd to move the session instead of prefixing a command with `cd <dir> &&`.",
	],
} as const;

export type SetCwdToolInput = Static<typeof setCwdSchema>;

export interface SetCwdRequest {
	/** Absolute directory to move the session to. */
	path: string;
	/**
	 * Present when the caller can ask the user to trust the target directory.
	 * Absent when there is no way to ask, which makes an untrusted target fail closed.
	 */
	projectTrustContext?: ProjectTrustContext;
}

export interface SetCwdToolOptions {
	/** Move the session to the requested directory. Provided by the session that owns the tool. */
	changeCwd: (request: SetCwdRequest) => Promise<SessionCwdChange>;
}

/**
 * Change the session working directory.
 *
 * The change applies to the rest of the session: built-in tools resolve paths against the
 * new directory, shell commands spawn there, and project resources are re-read from it.
 */
export function createSetCwdToolDefinition(
	cwd: string,
	options: SetCwdToolOptions,
): ToolDefinition<typeof setCwdSchema, SessionCwdChange> {
	return {
		name: "set_cwd",
		label: "set_cwd",
		description:
			"Change the session working directory. Built-in tools and shell commands use the new directory for the rest of the session, and project resources are re-read from it.",
		promptSnippet: setCwdToolSystemPromptContribution.snippet,
		promptGuidelines: [...setCwdToolSystemPromptContribution.guidelines],
		parameters: setCwdSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		executionMode: "sequential",
		async execute(_toolCallId, { path }: SetCwdToolInput, signal, _onUpdate, ctx?: ExtensionContext) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const target = resolvePath(path, ctx?.cwd || cwd);
			const projectTrustContext: ProjectTrustContext | undefined = ctx
				? { cwd: target, mode: ctx.mode, hasUI: ctx.hasUI, ui: ctx.ui }
				: undefined;
			const change = await options.changeCwd({ path: target, projectTrustContext });

			const text = [`Working directory: ${change.cwd}`];
			if (change.relocated && change.sessionFile) {
				text.push(`Session file: ${change.sessionFile}`);
			}
			return {
				content: [{ type: "text", text: text.join("\n") }],
				details: change,
			};
		},
	};
}

export function createSetCwdTool(cwd: string, options: SetCwdToolOptions): AgentTool<typeof setCwdSchema> {
	const definition = createSetCwdToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
