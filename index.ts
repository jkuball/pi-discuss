import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@mariozechner/pi-coding-agent";

const COMMAND_NAME = "discuss";
const DIFF_CONTEXT_LINES = 2;
const DISCUSSION_FILE_NAME = "assistant-answer.md";

type GitResult =
	| { ok: true; stdout: string; stderr: string; status: number }
	| { ok: false; error: string };

function getLastAssistantText(branch: SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;

		const message = entry.message;
		if (!("role" in message) || message.role !== "assistant") continue;
		if (message.stopReason !== "stop") continue;

		const text = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trimEnd();

		if (text.length > 0) return text;
	}

	return undefined;
}

function ensureTrailingNewline(text: string): string {
	return text.endsWith("\n") ? text : `${text}\n`;
}

function stripDiffHeaders(diffText: string): string {
	const lines = diffText.split("\n");
	const firstHunkIndex = lines.findIndex((line) => line.startsWith("@@"));
	if (firstHunkIndex === -1) return diffText.trim();
	return lines.slice(firstHunkIndex).join("\n").trim();
}

function buildDiscussionPrompt(diffText: string): string {
	return [
		"Continue the discussion about your last answer using this diff.",
		"Added lines are my notes, questions, corrections, or requests. Removed lines are the parts I edited or challenged. Unchanged lines are anchors.",
		"Reply only where needed, and organize the response by diff hunk.",
		"",
		"```diff",
		diffText,
		"```",
	].join("\n");
}

function runGit(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
	});

	if (result.error) {
		return { ok: false, error: result.error.message };
	}

	return {
		ok: true,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status ?? 0,
	};
}

function createDiscussionWorkspace(originalText: string):
	| { ok: true; dir: string; filePath: string }
	| { ok: false; error: string } {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-discuss-"));
	const filePath = path.join(dir, DISCUSSION_FILE_NAME);
	writeFileSync(filePath, ensureTrailingNewline(originalText), "utf8");

	const initResult = runGit(dir, ["init", "-q"]);
	if (!initResult.ok || initResult.status !== 0) {
		rmSync(dir, { recursive: true, force: true });
		return {
			ok: false,
			error: initResult.ok ? initResult.stderr.trim() || "git init failed" : initResult.error,
		};
	}

	const addResult = runGit(dir, ["add", "--", DISCUSSION_FILE_NAME]);
	if (!addResult.ok || addResult.status !== 0) {
		rmSync(dir, { recursive: true, force: true });
		return {
			ok: false,
			error: addResult.ok ? addResult.stderr.trim() || "git add failed" : addResult.error,
		};
	}

	const commitResult = runGit(dir, [
		"-c",
		"user.name=pi-discuss",
		"-c",
		"user.email=pi-discuss@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-q",
		"--no-gpg-sign",
		"-m",
		"baseline",
	]);
	if (!commitResult.ok || commitResult.status !== 0) {
		rmSync(dir, { recursive: true, force: true });
		return {
			ok: false,
			error: commitResult.ok ? commitResult.stderr.trim() || "git commit failed" : commitResult.error,
		};
	}

	return { ok: true, dir, filePath };
}

function createUnifiedDiff(workspaceDir: string): { ok: true; diff: string } | { ok: false; error: string } {
	const result = runGit(workspaceDir, [
		"diff",
		"--no-color",
		`--unified=${DIFF_CONTEXT_LINES}`,
		"--minimal",
		"--exit-code",
		"--",
		DISCUSSION_FILE_NAME,
	]);

	if (!result.ok) {
		return { ok: false, error: result.error };
	}

	if (result.status === 0) {
		return { ok: true, diff: "" };
	}

	if (result.status !== 1) {
		return { ok: false, error: result.stderr.trim() || `git diff exited with code ${result.status}` };
	}

	return { ok: true, diff: stripDiffHeaders(result.stdout) };
}

type ExternalEditorResult = {
	status: number | null;
	error?: string;
};

async function openDiscussionInExternalEditor(
	ctx: ExtensionCommandContext,
	filePath: string,
): Promise<{ ok: true } | { ok: false; error: string; cancelled: boolean }> {
	const editorCmd = process.env.VISUAL || process.env.EDITOR;
	if (!editorCmd || editorCmd.trim().length === 0) {
		return { ok: false, error: "No external editor configured. Set $VISUAL or $EDITOR.", cancelled: false };
	}

	const result = await ctx.ui.custom<ExternalEditorResult>((tui, _theme, _kb, done) => {
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");

		try {
			const [editor, ...editorArgs] = editorCmd.trim().split(/\s+/);
			const spawnResult = spawnSync(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});

			done({
				status: spawnResult.status,
				error: spawnResult.error?.message,
			});
		} finally {
			tui.start();
			tui.requestRender(true);
		}

		return { render: () => [], invalidate: () => {} };
	});

	if (result?.error) {
		return { ok: false, error: `Failed to launch editor: ${result.error}`, cancelled: false };
	}

	if (result?.status !== 0) {
		const code = result?.status ?? "unknown";
		return { ok: false, error: `Editor exited with code ${code}`, cancelled: true };
	}

	return { ok: true };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand(COMMAND_NAME, {
		description: "Open the last assistant answer in your external editor, then send only the diff back as context",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/discuss requires interactive mode", "error");
				return;
			}

			await ctx.waitForIdle();

			const originalText = getLastAssistantText(ctx.sessionManager.getBranch());
			if (!originalText) {
				ctx.ui.notify("No completed assistant answer found on the current branch", "error");
				return;
			}

			const workspace = createDiscussionWorkspace(originalText);
			if (!workspace.ok) {
				ctx.ui.notify(`Failed to prepare git workspace: ${workspace.error}`, "error");
				return;
			}

			try {
				const editorResult = await openDiscussionInExternalEditor(ctx, workspace.filePath);
				if (!editorResult.ok) {
					ctx.ui.notify(editorResult.error, editorResult.cancelled ? "info" : "error");
					return;
				}

				writeFileSync(workspace.filePath, ensureTrailingNewline(readFileSync(workspace.filePath, "utf8")), "utf8");

				const diffResult = createUnifiedDiff(workspace.dir);
				if (!diffResult.ok) {
					ctx.ui.notify(`Failed to build diff: ${diffResult.error}`, "error");
					return;
				}

				if (!diffResult.diff.trim()) {
					ctx.ui.notify("No inline discussion detected", "info");
					return;
				}

				pi.sendUserMessage(buildDiscussionPrompt(diffResult.diff));
			} finally {
				rmSync(workspace.dir, { recursive: true, force: true });
			}
		},
	});
}
