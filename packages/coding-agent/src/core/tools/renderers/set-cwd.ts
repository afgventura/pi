/**
 * Presentation for the set_cwd tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema.
 */

import { Text } from "@earendil-works/pi-tui";
import { theme } from "../../../modes/interactive/theme/theme.ts";
import { invalidArgText, str } from "../render-utils.ts";

export const setCwdRenderers = {
	renderCall: (args: { path?: string } | undefined) => {
		const path = str(args?.path);
		const display = path === null ? invalidArgText(theme) : path ? path : theme.fg("toolOutput", "...");
		return new Text(theme.fg("toolTitle", theme.bold(`cd ${display}`)), 0, 0);
	},
};
