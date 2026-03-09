import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	truncateTail,
	type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUPPORTED_RUNTIMES = ["julia", "python", "ipython", "r", "bun"] as const;
const DEFAULT_PYTHON_SESSION = "pi-repl-python";
const DEFAULT_CAPTURE_LINES = 20;
const DEFAULT_STARTUP_WAIT_MS = 5_000;
const DEFAULT_STARTUP_POLL_MS = 250;
const DEFAULT_REPL_SEND_TIMEOUT_MS = 20_000;
const MAX_REPL_SEND_TIMEOUT_MS = 120_000;
const REPL_SEND_POLL_MS = 100;
const REPL_SEND_CAPTURE_LINES = 5_000;
const REPL_CONTROL_ROOT = process.platform === "win32" ? tmpdir() : "/tmp";
const REPL_RUNTIME_OPTION = "@pi_repl_runtime";

type SupportedRuntime = (typeof SUPPORTED_RUNTIMES)[number];
type PythonRuntime = "python" | "ipython";

type ReplCommand =
	| { action: "help" }
	| { action: "status" }
	| { action: "env" }
	| { action: "stop" }
	| { action: "attach" }
	| { action: "start"; runtime: SupportedRuntime; name?: string }
	| { action: "error"; message: string };

type SessionInfo = {
	sessionName: string;
	runtime?: string;
	currentCommand: string;
	currentPath: string;
	tail: string;
};

type ReplSendDetails = {
	sessionName: string;
	runtime: PythonRuntime;
	timeoutMs: number;
	submittedCode: string;
	previewComment?: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
};

const REPL_SEND_PARAMS = Type.Object({
	code: Type.String({ description: "Python or IPython code to execute in the shared REPL session." }),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "Maximum time to wait for completion in milliseconds (default 20000).",
			minimum: 1000,
			maximum: MAX_REPL_SEND_TIMEOUT_MS,
		}),
	),
});

function tokenizeArgs(args: string): string[] {
	const parts = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
	if (!parts) return [];

	return parts
		.map((token) => {
			if (
				(token.startsWith('"') && token.endsWith('"') && token.length >= 2) ||
				(token.startsWith("'") && token.endsWith("'") && token.length >= 2)
			) {
				return token.slice(1, -1);
			}
			return token;
		})
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
}

function isSupportedRuntime(value: string): value is SupportedRuntime {
	return SUPPORTED_RUNTIMES.includes(value as SupportedRuntime);
}

function isPythonRuntime(value: SupportedRuntime): value is PythonRuntime {
	return value === "python" || value === "ipython";
}

function sanitizeNamePart(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
}

function buildSessionName(runtime: SupportedRuntime, name?: string): string {
	const base = `pi-repl-${runtime}`;
	if (!name) return base;

	const safeName = sanitizeNamePart(name);
	return safeName ? `${base}-${safeName}` : base;
}

function formatUsage(): string {
	return [
		"Usage:",
		"  /repl python",
		"  /repl ipython",
		"  /repl status",
		"  /repl env",
		"  /repl attach",
		"  /repl stop",
		"",
		"Supported runtimes right now: python, ipython",
		"",
		"Current real implementation:",
		"  - /repl python starts a detached tmux session named pi-repl-python",
		"  - /repl ipython starts the same default session, but asks your shell to run `ipython`",
		"  - the session asks your default shell to run the chosen Python REPL in interactive login mode",
		"  - /repl status, /repl env, /repl stop, and /repl attach operate on that default Python/IPython session",
		"  - the repl_send tool can execute code in that running Python/IPython session",
		"",
		"Examples:",
		"  /repl ipython",
		"  /lab ipython",
		"  /repl env",
		"  /repl attach",
	].join("\n");
}

function parseReplCommand(args: string): ReplCommand {
	const tokens = tokenizeArgs(args);
	if (tokens.length === 0) return { action: "help" };

	const [first, ...rest] = tokens;
	const firstLower = first.toLowerCase();

	if (["help", "-h", "--help", "?"].includes(firstLower)) {
		return { action: "help" };
	}

	if (firstLower === "status" || firstLower === "env" || firstLower === "stop" || firstLower === "attach") {
		if (rest.length > 0) {
			return {
				action: "error",
				message: `Unexpected arguments for /repl ${firstLower}: ${rest.join(" ")}`,
			};
		}
		return { action: firstLower };
	}

	if (!isSupportedRuntime(firstLower)) {
		return {
			action: "error",
			message: `Unknown /repl subcommand or runtime: ${first}`,
		};
	}

	let name: string | undefined;

	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		if (token === "--name" || token === "-n") {
			const value = rest[i + 1];
			if (!value) {
				return {
					action: "error",
					message: "Missing value for --name",
				};
			}
			name = value;
			i += 1;
			continue;
		}

		return {
			action: "error",
			message: `Unknown argument for /repl ${firstLower}: ${token}`,
		};
	}

	if (name !== undefined && sanitizeNamePart(name).length === 0) {
		return {
			action: "error",
			message: `Session name is empty after sanitization: ${name}`,
		};
	}

	return {
		action: "start",
		runtime: firstLower,
		name,
	};
}

async function commandExists(pi: ExtensionAPI, command: string, cwd: string): Promise<boolean> {
	const lookupCommand = process.platform === "win32" ? "where" : "which";
	try {
		const result = await pi.exec(lookupCommand, [command], { cwd, timeout: 2_000 });
		return result.code === 0;
	} catch {
		return false;
	}
}

async function execTmux(
	pi: ExtensionAPI,
	args: string[],
	cwd: string,
	timeout = 5_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const result = await pi.exec("tmux", args, { cwd, timeout });
	return {
		code: result.code ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}

	if (level === "error") {
		console.error(message);
		return;
	}

	console.log(message);
}

function formatAttachCommand(sessionName: string): string {
	return `tmux attach -t ${sessionName}`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildDefaultShellPythonCommand(runtime: PythonRuntime): { shell: string; command: string } {
	const shell = process.env.SHELL?.trim() || "/bin/sh";
	return {
		shell,
		command: `${shellQuote(shell)} -i -l -c ${shellQuote(runtime)}`,
	};
}

function normalizePythonRuntime(info: SessionInfo | null): PythonRuntime {
	if (info?.runtime === "ipython") return "ipython";
	if (info?.tail.includes("IPython") || info?.tail.includes("In [")) return "ipython";
	return "python";
}

function clampReplSendTimeout(timeoutMs: number | undefined): number {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
		return DEFAULT_REPL_SEND_TIMEOUT_MS;
	}

	return Math.max(1_000, Math.min(MAX_REPL_SEND_TIMEOUT_MS, Math.round(timeoutMs)));
}

function getPaneTarget(sessionName: string): string {
	return `${sessionName}:0.0`;
}

async function tmuxSessionExists(pi: ExtensionAPI, sessionName: string, cwd: string): Promise<boolean> {
	try {
		const result = await execTmux(pi, ["has-session", "-t", sessionName], cwd, 3_000);
		return result.code === 0;
	} catch {
		return false;
	}
}

async function setTmuxSessionOption(
	pi: ExtensionAPI,
	sessionName: string,
	optionName: string,
	value: string,
	cwd: string,
): Promise<boolean> {
	const result = await execTmux(pi, ["set-option", "-q", "-t", sessionName, optionName, value], cwd, 3_000);
	return result.code === 0;
}

async function readTmuxSessionOption(
	pi: ExtensionAPI,
	sessionName: string,
	optionName: string,
	cwd: string,
): Promise<string | undefined> {
	const result = await execTmux(pi, ["show-options", "-v", "-t", sessionName, optionName], cwd, 3_000);
	if (result.code !== 0) return undefined;

	const value = result.stdout.trim();
	return value || undefined;
}

async function readSessionInfo(pi: ExtensionAPI, sessionName: string, cwd: string): Promise<SessionInfo | null> {
	if (!(await tmuxSessionExists(pi, sessionName, cwd))) return null;

	const target = getPaneTarget(sessionName);
	const summaryResult = await execTmux(
		pi,
		["display-message", "-p", "-t", target, "#{session_name}\t#{pane_current_command}\t#{pane_current_path}"],
		cwd,
		3_000,
	);
	const [resolvedSessionName = sessionName, currentCommand = "unknown", currentPath = cwd] = summaryResult.stdout
		.trim()
		.split("\t");

	const tailResult = await execTmux(pi, ["capture-pane", "-p", "-t", target, "-S", `-${DEFAULT_CAPTURE_LINES}`], cwd, 3_000);
	const runtime = await readTmuxSessionOption(pi, sessionName, REPL_RUNTIME_OPTION, cwd);

	return {
		sessionName: resolvedSessionName,
		runtime,
		currentCommand: currentCommand || "unknown",
		currentPath: currentPath || cwd,
		tail: tailResult.stdout.trim(),
	};
}

function formatSessionInfo(info: SessionInfo): string {
	const lines = [
		`Session: ${info.sessionName}`,
		...(info.runtime ? [`Runtime: ${info.runtime}`] : []),
		`Current command: ${info.currentCommand}`,
		`Path: ${info.currentPath}`,
		"",
		"To use the REPL directly, open a new terminal window and run:",
		formatAttachCommand(info.sessionName),
	];

	if (info.tail) {
		lines.push("", "Recent pane output:", info.tail);
	}

	return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPythonSessionInfo(
	pi: ExtensionAPI,
	cwd: string,
	shellPath: string,
	runtime: PythonRuntime,
): Promise<SessionInfo | null> {
	const deadline = Date.now() + DEFAULT_STARTUP_WAIT_MS;
	const shellName = shellPath.split("/").pop() ?? shellPath;
	let latestInfo: SessionInfo | null = null;

	while (Date.now() < deadline) {
		latestInfo = await readSessionInfo(pi, DEFAULT_PYTHON_SESSION, cwd);
		if (!latestInfo) return null;
		if (latestInfo.currentCommand !== shellName) return latestInfo;
		if (latestInfo.tail.includes(">>>")) return latestInfo;
		if (runtime === "ipython" && (latestInfo.tail.includes("IPython") || latestInfo.tail.includes("In ["))) {
			return latestInfo;
		}
		await sleep(DEFAULT_STARTUP_POLL_MS);
	}

	return latestInfo;
}

type ReplControlPaths = {
	dir: string;
	sourceFile: string;
	doneFile: string;
};

function getReplControlPaths(sessionName: string): ReplControlPaths {
	if (sessionName === DEFAULT_PYTHON_SESSION) {
		return {
			dir: REPL_CONTROL_ROOT,
			sourceFile: join(REPL_CONTROL_ROOT, "pr.py"),
			doneFile: join(REPL_CONTROL_ROOT, "pr.done"),
		};
	}

	const dir = join(REPL_CONTROL_ROOT, sessionName);
	return {
		dir,
		sourceFile: join(dir, "control.py"),
		doneFile: join(dir, "done.flag"),
	};
}

function buildPythonControlSource(runtime: PythonRuntime, code: string, doneFile: string): string {
	if (runtime === "ipython") {
		return [
			"from pathlib import Path as __pi_repl_path",
			"import traceback as __pi_repl_traceback",
			"try:",
			"    __pi_repl_ip = get_ipython()",
			"    if __pi_repl_ip is None:",
			"        raise RuntimeError('Expected IPython session, but get_ipython() returned None.')",
			`    __pi_repl_result = __pi_repl_ip.run_cell(${JSON.stringify(code)}, store_history=False)`,
			"    if getattr(__pi_repl_result, 'error_in_exec', None) is None and getattr(__pi_repl_result, 'result', None) is not None:",
			"        print(repr(__pi_repl_result.result))",
			"except Exception:",
			"    __pi_repl_traceback.print_exc()",
			"finally:",
			`    __pi_repl_path(${JSON.stringify(doneFile)}).write_text('done\\n', encoding='utf-8')`,
		].join("\n");
	}

	return [
		"from pathlib import Path as __pi_repl_path",
		"import traceback as __pi_repl_traceback",
		"try:",
		`    exec(compile(${JSON.stringify(code)}, '<pi-repl>', 'exec'), globals())`,
		"except Exception:",
		"    __pi_repl_traceback.print_exc()",
		"finally:",
		`    __pi_repl_path(${JSON.stringify(doneFile)}).write_text('done\\n', encoding='utf-8')`,
	].join("\n");
}

function buildPythonSubmissionLine(_runtime: PythonRuntime, sourceFile: string): string {
	const quotedPath = JSON.stringify(sourceFile);
	return `exec(open(${quotedPath}).read(),globals())`;
}

function buildReplPreviewComment(code: string): string | undefined {
	const normalized = code.replace(/\r/g, "").trimEnd();
	const lines = normalized.split("\n");
	if (lines.length === 1) {
		const oneLine = lines[0].trim().replace(/\s+/g, " ");
		if (oneLine.length > 0 && oneLine.length <= 80) {
			return undefined;
		}
	}
	return `# pi-repl: running ${lines.length}-line snippet`;
}

function buildSubmissionText(submissionLine: string, previewComment?: string): string {
	return previewComment ? `${previewComment}\n${submissionLine}` : submissionLine;
}

function prepareReplControlFiles(
	sessionName: string,
	runtime: PythonRuntime,
	code: string,
): { controlPaths: ReplControlPaths; submissionLine: string; previewComment?: string; submissionText: string } {
	const controlPaths = getReplControlPaths(sessionName);
	mkdirSync(controlPaths.dir, { recursive: true });
	try {
		unlinkSync(controlPaths.doneFile);
	} catch {
		// ignore if no previous done file exists
	}

	writeFileSync(controlPaths.sourceFile, buildPythonControlSource(runtime, code, controlPaths.doneFile), "utf-8");
	const submissionLine = buildPythonSubmissionLine(runtime, controlPaths.sourceFile);
	const previewComment = buildReplPreviewComment(code);
	return {
		controlPaths,
		submissionLine,
		previewComment,
		submissionText: buildSubmissionText(submissionLine, previewComment),
	};
}

async function pasteTextToTmuxPane(
	pi: ExtensionAPI,
	sessionName: string,
	cwd: string,
	text: string,
): Promise<void> {
	const bufferName = `pi-repl-${randomUUID()}`;
	const tempFile = join(REPL_CONTROL_ROOT, `${bufferName}.txt`);
	writeFileSync(tempFile, text, "utf-8");

	try {
		const loadResult = await execTmux(pi, ["load-buffer", "-b", bufferName, tempFile], cwd, 5_000);
		if (loadResult.code !== 0) {
			const reason = loadResult.stderr.trim() || loadResult.stdout.trim() || `exit code ${loadResult.code}`;
			throw new Error(`Failed to load tmux buffer: ${reason}`);
		}

		const pasteResult = await execTmux(pi, ["paste-buffer", "-d", "-b", bufferName, "-t", getPaneTarget(sessionName)], cwd, 5_000);
		if (pasteResult.code !== 0) {
			const reason = pasteResult.stderr.trim() || pasteResult.stdout.trim() || `exit code ${pasteResult.code}`;
			throw new Error(`Failed to paste tmux buffer: ${reason}`);
		}

		const enterResult = await execTmux(pi, ["send-keys", "-t", getPaneTarget(sessionName), "C-m"], cwd, 5_000);
		if (enterResult.code !== 0) {
			const reason = enterResult.stderr.trim() || enterResult.stdout.trim() || `exit code ${enterResult.code}`;
			throw new Error(`Failed to send Enter to tmux pane: ${reason}`);
		}
	} finally {
		try {
			unlinkSync(tempFile);
		} catch {
			// ignore cleanup errors
		}
		await execTmux(pi, ["delete-buffer", "-b", bufferName], cwd, 2_000).catch(() => undefined);
	}
}

async function capturePaneOutput(pi: ExtensionAPI, sessionName: string, cwd: string): Promise<string> {
	const result = await execTmux(
		pi,
		["capture-pane", "-p", "-t", getPaneTarget(sessionName), "-S", `-${REPL_SEND_CAPTURE_LINES}`],
		cwd,
		5_000,
	);
	if (result.code !== 0) {
		const reason = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(`Failed to capture tmux pane output: ${reason}`);
	}
	return result.stdout;
}

function stripBoundaryBlankLines(text: string): string {
	const lines = text.replace(/\r/g, "").split("\n");
	while (lines.length > 0 && lines[0] === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

function extractPaneDelta(before: string, after: string): string {
	const normalizedBefore = before.replace(/\r/g, "");
	const normalizedAfter = after.replace(/\r/g, "");

	if (normalizedAfter.startsWith(normalizedBefore)) {
		return normalizedAfter.slice(normalizedBefore.length);
	}

	const beforeLines = normalizedBefore.split("\n");
	const afterLines = normalizedAfter.split("\n");
	let index = 0;
	while (index < beforeLines.length && index < afterLines.length && beforeLines[index] === afterLines[index]) {
		index += 1;
	}
	return afterLines.slice(index).join("\n");
}

function cleanupReplDelta(delta: string, submissionLine: string, previewComment?: string): string {
	const lines = stripBoundaryBlankLines(delta).split("\n");
	const loaderHints = [submissionLine, "exec(open(", "run_cell(open(", "/tmp/pr.py", "/tmp/pi-repl", "control.py"];
	const previewHints = previewComment ? [previewComment, "# pi-repl:"] : ["# pi-repl:"];

	while (lines.length > 0) {
		const first = lines[0]?.trim() ?? "";
		if (!first) {
			lines.shift();
			continue;
		}
		if (loaderHints.some((hint) => first.includes(hint))) {
			lines.shift();
			continue;
		}
		if (previewHints.some((hint) => first.includes(hint))) {
			lines.shift();
			continue;
		}
		if (/^\s*\.\.\.:/.test(first)) {
			lines.shift();
			continue;
		}
		break;
	}

	while (lines.length > 0) {
		const last = lines[lines.length - 1]?.trim() ?? "";
		if (!last || /^>>>\s*$/.test(last) || /^In \[\d+\]:\s*$/.test(last) || /^\s*\.\.\.:\s*$/.test(last)) {
			lines.pop();
			continue;
		}
		break;
	}

	return stripBoundaryBlankLines(lines.join("\n"));
}

async function waitForReplDoneFile(
	pi: ExtensionAPI,
	sessionName: string,
	cwd: string,
	doneFile: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let latestCapture = "";

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("repl_send was aborted.");
		}

		if (!(await tmuxSessionExists(pi, sessionName, cwd))) {
			throw new Error(`REPL session ended while waiting for output: ${sessionName}`);
		}

		if (existsSync(doneFile)) return;

		latestCapture = await capturePaneOutput(pi, sessionName, cwd);
		await sleep(REPL_SEND_POLL_MS);
	}

	const tail = truncateTail(latestCapture, {
		maxLines: 40,
		maxBytes: 8 * 1024,
	}).content.trim();
	const tailNote = tail ? `\n\nLatest pane output:\n${tail}` : "";
	throw new Error(
		`Timed out waiting for REPL output after ${timeoutMs}ms. The session may still be busy; attach with ${formatAttachCommand(sessionName)} or stop it with /repl stop.${tailNote}`,
	);
}

async function runReplCode(
	pi: ExtensionAPI,
	params: { code: string; timeoutMs?: number },
	ctx: ExtensionCommandContext,
	signal?: AbortSignal,
): Promise<{ output: string; details: ReplSendDetails }> {
	const code = params.code ?? "";
	if (!code.trim()) {
		throw new Error("repl_send requires non-empty code.");
	}

	if (!(await tmuxSessionExists(pi, DEFAULT_PYTHON_SESSION, ctx.cwd))) {
		throw new Error(
			`No default Python/IPython REPL session is running (${DEFAULT_PYTHON_SESSION}). Start one with /repl python or /repl ipython first.`,
		);
	}

	const sessionInfo = await readSessionInfo(pi, DEFAULT_PYTHON_SESSION, ctx.cwd);
	if (!sessionInfo) {
		throw new Error(
			`Could not inspect the default Python/IPython REPL session (${DEFAULT_PYTHON_SESSION}). Start it again with /repl python or /repl ipython.`,
		);
	}

	const runtime = normalizePythonRuntime(sessionInfo);
	const timeoutMs = clampReplSendTimeout(params.timeoutMs);
	const beforeCapture = await capturePaneOutput(pi, DEFAULT_PYTHON_SESSION, ctx.cwd);
	const prepared = prepareReplControlFiles(DEFAULT_PYTHON_SESSION, runtime, code);

	await pasteTextToTmuxPane(pi, DEFAULT_PYTHON_SESSION, ctx.cwd, prepared.submissionText);
	await waitForReplDoneFile(
		pi,
		DEFAULT_PYTHON_SESSION,
		ctx.cwd,
		prepared.controlPaths.doneFile,
		timeoutMs,
		signal,
	);
	const afterCapture = await capturePaneOutput(pi, DEFAULT_PYTHON_SESSION, ctx.cwd);
	const delta = extractPaneDelta(beforeCapture, afterCapture);
	const output = cleanupReplDelta(delta, prepared.submissionLine, prepared.previewComment);
	try {
		unlinkSync(prepared.controlPaths.doneFile);
	} catch {
		// ignore cleanup errors
	}

	return {
		output,
		details: {
			sessionName: DEFAULT_PYTHON_SESSION,
			runtime,
			timeoutMs,
			submittedCode: code,
			previewComment: prepared.previewComment,
		},
	};
}

function formatReplSendResult(output: string, details: ReplSendDetails): { text: string; details: ReplSendDetails } {
	const submittedCode = details.submittedCode.trimEnd();
	const outputText = output.trim() ? output : "(no output)";
	const truncation = truncateHead(outputText, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let resultDetails: ReplSendDetails = details;
	let renderedOutput = truncation.content;

	if (truncation.truncated) {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-repl-output-"));
		const tempFile = join(tempDir, "output.txt");
		writeFileSync(tempFile, outputText, "utf-8");

		resultDetails = {
			...details,
			truncation,
			fullOutputPath: tempFile,
		};

		renderedOutput += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
		renderedOutput += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
		renderedOutput += ` Full output saved to: ${tempFile}]`;
	}

	const text = [
		"Submitted code:",
		submittedCode,
		"",
		"Output:",
		renderedOutput,
	].join("\n");

	return {
		text,
		details: resultDetails,
	};
}

async function executeReplSend(
	pi: ExtensionAPI,
	params: { code: string; timeoutMs?: number },
	ctx: ExtensionCommandContext,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ReplSendDetails }> {
	const execution = await runReplCode(pi, params, ctx, signal);
	const formatted = formatReplSendResult(execution.output, execution.details);

	return {
		content: [{ type: "text", text: formatted.text }],
		details: formatted.details,
	};
}

function buildReplEnvInspectionCode(): string {
	return [
		"import os, sys",
		"print(f'sys.executable={sys.executable}')",
		"print(f'sys.prefix={sys.prefix}')",
		"print(f'sys.base_prefix={getattr(sys, \"base_prefix\", sys.prefix)}')",
		"print(f'VIRTUAL_ENV={os.environ.get(\"VIRTUAL_ENV\") or \"\"}')",
		"print(f'CONDA_DEFAULT_ENV={os.environ.get(\"CONDA_DEFAULT_ENV\") or \"\"}')",
		"print(f'CONDA_PREFIX={os.environ.get(\"CONDA_PREFIX\") or \"\"}')",
		"print(f'PYENV_VERSION={os.environ.get(\"PYENV_VERSION\") or \"\"}')",
	].join("\n");
}

async function showDefaultPythonEnv(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	try {
		const execution = await runReplCode(
			pi,
			{
				code: buildReplEnvInspectionCode(),
				timeoutMs: 10_000,
			},
			ctx,
		);

		notify(
			ctx,
			[
				"Python/IPython REPL environment:",
				`Runtime: ${execution.details.runtime}`,
				`Session: ${execution.details.sessionName}`,
				"",
				execution.output.trim() || "(no output)",
			].join("\n"),
			"info",
		);
	} catch (error) {
		notify(ctx, error instanceof Error ? error.message : String(error), "error");
	}
}

async function startDefaultPythonSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: PythonRuntime,
): Promise<void> {
	const exists = await tmuxSessionExists(pi, DEFAULT_PYTHON_SESSION, ctx.cwd);
	if (exists) {
		const info = await readSessionInfo(pi, DEFAULT_PYTHON_SESSION, ctx.cwd);
		const requestedLabel = runtime === "ipython" ? "IPython" : "Python";
		notify(
			ctx,
			info
				? `Default Python/IPython REPL session is already running (requested: ${requestedLabel}).\n\n${formatSessionInfo(info)}`
				: [
					"Default Python/IPython REPL session is already running.",
					"",
					"To use the REPL directly, open a new terminal window and run:",
					formatAttachCommand(DEFAULT_PYTHON_SESSION),
				].join("\n"),
			"info",
		);
		return;
	}

	const shellLaunch = buildDefaultShellPythonCommand(runtime);
	const createResult = await execTmux(
		pi,
		["new-session", "-d", "-s", DEFAULT_PYTHON_SESSION, "-c", ctx.cwd, shellLaunch.command],
		ctx.cwd,
		10_000,
	);
	if (createResult.code !== 0) {
		const reason = createResult.stderr.trim() || createResult.stdout.trim() || `exit code ${createResult.code}`;
		notify(ctx, `Failed to create tmux session ${DEFAULT_PYTHON_SESSION}: ${reason}`, "error");
		return;
	}

	await setTmuxSessionOption(pi, DEFAULT_PYTHON_SESSION, REPL_RUNTIME_OPTION, runtime, ctx.cwd);
	const info = await waitForPythonSessionInfo(pi, ctx.cwd, shellLaunch.shell, runtime);
	const replLabel = runtime === "ipython" ? "IPython" : "Python";

	notify(
		ctx,
		[
			`Started default ${replLabel} REPL session: ${DEFAULT_PYTHON_SESSION}`,
			`Launch method: ${shellLaunch.shell} -i -l -c '${runtime}' inside tmux.`,
			"This is intended to respect your normal shell-level Python setup (aliases, pyenv/virtualenv/conda activation, shell init, etc.).",
			info
				? `\n${formatSessionInfo(info)}`
				: [
					"",
					"To use the REPL directly, open a new terminal window and run:",
					formatAttachCommand(DEFAULT_PYTHON_SESSION),
				].join("\n"),
		].join("\n"),
		"info",
	);
}

async function showDefaultPythonStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const info = await readSessionInfo(pi, DEFAULT_PYTHON_SESSION, ctx.cwd);
	if (!info) {
		notify(
			ctx,
			[
				`No default Python/IPython REPL session is running (${DEFAULT_PYTHON_SESSION}).`,
				"Start one with /repl python, /repl ipython, /lab python, or /lab ipython.",
			].join("\n"),
			"info",
		);
		return;
	}

	notify(ctx, `Default Python/IPython REPL session is running.\n\n${formatSessionInfo(info)}`, "info");
}

async function stopDefaultPythonSession(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const exists = await tmuxSessionExists(pi, DEFAULT_PYTHON_SESSION, ctx.cwd);
	if (!exists) {
		notify(ctx, `No default Python/IPython REPL session is running (${DEFAULT_PYTHON_SESSION}).`, "info");
		return;
	}

	const result = await execTmux(pi, ["kill-session", "-t", DEFAULT_PYTHON_SESSION], ctx.cwd, 5_000);
	if (result.code !== 0) {
		const reason = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		notify(ctx, `Failed to stop ${DEFAULT_PYTHON_SESSION}: ${reason}`, "error");
		return;
	}

	notify(ctx, `Stopped default Python/IPython REPL session: ${DEFAULT_PYTHON_SESSION}`, "info");
}

async function attachDefaultPythonSession(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const exists = await tmuxSessionExists(pi, DEFAULT_PYTHON_SESSION, ctx.cwd);
	if (!exists) {
		notify(
			ctx,
			[
				`No default Python/IPython REPL session is running (${DEFAULT_PYTHON_SESSION}).`,
				"Start one with /repl python, /repl ipython, /lab python, or /lab ipython.",
			].join("\n"),
			"info",
		);
		return;
	}

	notify(
		ctx,
		[
			"To use the REPL directly, open a new terminal window and run:",
			formatAttachCommand(DEFAULT_PYTHON_SESSION),
		].join("\n"),
		"info",
	);
}

async function handleRepl(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseReplCommand(args);

	if (parsed.action === "help") {
		notify(ctx, formatUsage(), "info");
		return;
	}

	if (parsed.action === "error") {
		notify(ctx, `${parsed.message}\n\n${formatUsage()}`, "error");
		return;
	}

	const hasTmux = await commandExists(pi, "tmux", ctx.cwd);
	if (!hasTmux) {
		notify(ctx, "tmux was not found on PATH. pi-repl requires tmux.", "error");
		return;
	}

	switch (parsed.action) {
		case "status":
			await showDefaultPythonStatus(pi, ctx);
			return;
		case "env":
			await showDefaultPythonEnv(pi, ctx);
			return;
		case "stop":
			await stopDefaultPythonSession(pi, ctx);
			return;
		case "attach":
			await attachDefaultPythonSession(pi, ctx);
			return;
		case "start": {
			if (isPythonRuntime(parsed.runtime)) {
				if (parsed.name) {
					notify(
						ctx,
						"Named Python/IPython sessions are not implemented yet. For now, use /repl python or /repl ipython with no --name.",
						"warning",
					);
					return;
				}

				await startDefaultPythonSession(pi, ctx, parsed.runtime);
				return;
			}

			const sessionName = buildSessionName(parsed.runtime, parsed.name);
			const nameNote = parsed.name ? ` (from name: ${parsed.name})` : "";
			notify(
				ctx,
				[
					"Scaffold only: parsed REPL start request.",
					`Runtime: ${parsed.runtime}`,
					`tmux session: ${sessionName}${nameNote}`,
					"Only the default Python/IPython session is implemented so far.",
				].join("\n"),
				"info",
			);
			return;
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("repl", {
		description: "Manage collaborative tmux-backed REPL sessions",
		handler: async (args, ctx) => {
			await handleRepl(pi, args, ctx);
		},
	});

	pi.registerCommand("lab", {
		description: "Alias for /repl",
		handler: async (args, ctx) => {
			await handleRepl(pi, args, ctx);
		},
	});

	pi.registerTool({
		name: "repl_send",
		label: "REPL Send",
		description: `Execute code in the shared default Python/IPython tmux REPL session (${DEFAULT_PYTHON_SESSION}). Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first).`,
		promptSnippet: "Execute a small snippet in the shared Python/IPython REPL and return its output.",
		promptGuidelines: [
			"Use this tool only after a /repl python or /repl ipython session has been started.",
			"This is a shared long-lived session: inspect state before mutating it, and do not assume variables already exist.",
			"Keep snippets small. If you need a value back reliably, print it explicitly.",
			"Avoid blocking interactive input() prompts or long-running code unless the user explicitly wants that.",
		],
		parameters: REPL_SEND_PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeReplSend(pi, params as { code: string; timeoutMs?: number }, ctx, signal);
		},
	});
}
