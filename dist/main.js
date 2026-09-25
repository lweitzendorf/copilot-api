#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import consola from "consola";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import clipboard from "clipboardy";
import { serve } from "srvx";
import invariant from "tiny-invariant";
import { getProxyForUrl } from "proxy-from-env";
import { Agent, ProxyAgent, setGlobalDispatcher } from "undici";
import { execSync } from "node:child_process";
import process$1 from "node:process";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import { events } from "fetch-event-stream";

//#region src/lib/paths.ts
const APP_DIR = path.join(os.homedir(), ".local", "share", "copilot-api");
const GITHUB_TOKEN_PATH = path.join(APP_DIR, "github_token");
const PATHS = {
	APP_DIR,
	GITHUB_TOKEN_PATH
};
async function ensurePaths() {
	await fs.mkdir(PATHS.APP_DIR, { recursive: true });
	await ensureFile(PATHS.GITHUB_TOKEN_PATH);
}
async function ensureFile(filePath) {
	try {
		await fs.access(filePath, fs.constants.W_OK);
	} catch {
		await fs.writeFile(filePath, "");
		await fs.chmod(filePath, 384);
	}
}

//#endregion
//#region src/lib/state.ts
const state = {
	accountType: "individual",
	manualApprove: false,
	rateLimitWait: false,
	showToken: false
};

//#endregion
//#region src/lib/api-config.ts
const standardHeaders = () => ({
	"content-type": "application/json",
	accept: "application/json"
});
const COPILOT_VERSION = "0.26.7";
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`;
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`;
const API_VERSION = "2025-04-01";
const copilotBaseUrl = (state$1) => state$1.accountType === "individual" ? "https://api.githubcopilot.com" : `https://api.${state$1.accountType}.githubcopilot.com`;
const copilotHeaders = (state$1, vision = false) => {
	const headers = {
		Authorization: `Bearer ${state$1.copilotToken}`,
		"content-type": standardHeaders()["content-type"],
		"copilot-integration-id": "vscode-chat",
		"editor-version": `vscode/${state$1.vsCodeVersion}`,
		"editor-plugin-version": EDITOR_PLUGIN_VERSION,
		"user-agent": USER_AGENT,
		"openai-intent": "conversation-panel",
		"x-github-api-version": API_VERSION,
		"x-request-id": randomUUID(),
		"x-vscode-user-agent-library-version": "electron-fetch"
	};
	if (vision) headers["copilot-vision-request"] = "true";
	return headers;
};
const GITHUB_API_BASE_URL = "https://api.github.com";
const githubHeaders = (state$1) => ({
	...standardHeaders(),
	authorization: `token ${state$1.githubToken}`,
	"editor-version": `vscode/${state$1.vsCodeVersion}`,
	"editor-plugin-version": EDITOR_PLUGIN_VERSION,
	"user-agent": USER_AGENT,
	"x-github-api-version": API_VERSION,
	"x-vscode-user-agent-library-version": "electron-fetch"
});
const GITHUB_BASE_URL = "https://github.com";
const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_APP_SCOPES = ["read:user"].join(" ");

//#endregion
//#region src/lib/error.ts
var HTTPError = class extends Error {
	response;
	constructor(message, response) {
		super(message);
		this.response = response;
	}
};
async function forwardError(c, error) {
	consola.error("Error occurred:", error);
	if (error instanceof HTTPError) {
		const errorText = await error.response.text();
		let errorJson;
		try {
			errorJson = JSON.parse(errorText);
		} catch {
			errorJson = errorText;
		}
		consola.error("HTTP error:", errorJson);
		return c.json({ error: {
			message: errorText,
			type: "error"
		} }, error.response.status);
	}
	return c.json({ error: {
		message: error.message,
		type: "error"
	} }, 500);
}

//#endregion
//#region src/services/github/get-copilot-token.ts
const getCopilotToken = async () => {
	const response = await fetch(`${GITHUB_API_BASE_URL}/copilot_internal/v2/token`, { headers: githubHeaders(state) });
	if (!response.ok) throw new HTTPError("Failed to get Copilot token", response);
	return await response.json();
};

//#endregion
//#region src/services/github/get-device-code.ts
async function getDeviceCode() {
	const response = await fetch(`${GITHUB_BASE_URL}/login/device/code`, {
		method: "POST",
		headers: standardHeaders(),
		body: JSON.stringify({
			client_id: GITHUB_CLIENT_ID,
			scope: GITHUB_APP_SCOPES
		})
	});
	if (!response.ok) throw new HTTPError("Failed to get device code", response);
	return await response.json();
}

//#endregion
//#region src/services/github/get-user.ts
async function getGitHubUser() {
	const response = await fetch(`${GITHUB_API_BASE_URL}/user`, { headers: {
		authorization: `token ${state.githubToken}`,
		...standardHeaders()
	} });
	if (!response.ok) throw new HTTPError("Failed to get GitHub user", response);
	return await response.json();
}

//#endregion
//#region src/services/copilot/get-models.ts
const getModels = async () => {
	const response = await fetch(`${copilotBaseUrl(state)}/models`, { headers: copilotHeaders(state) });
	if (!response.ok) throw new HTTPError("Failed to get models", response);
	return await response.json();
};

//#endregion
//#region src/services/get-vscode-version.ts
const FALLBACK = "1.104.3";
async function getVSCodeVersion() {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort();
	}, 5e3);
	try {
		const match = (await (await fetch("https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h=visual-studio-code-bin", { signal: controller.signal })).text()).match(/pkgver=([0-9.]+)/);
		if (match) return match[1];
		return FALLBACK;
	} catch {
		return FALLBACK;
	} finally {
		clearTimeout(timeout);
	}
}
await getVSCodeVersion();

//#endregion
//#region src/lib/utils.ts
const sleep = (ms) => new Promise((resolve) => {
	setTimeout(resolve, ms);
});
const isNullish = (value) => value === null || value === void 0;
async function cacheModels() {
	state.models = await getModels();
}
const cacheVSCodeVersion = async () => {
	const response = await getVSCodeVersion();
	state.vsCodeVersion = response;
	consola.info(`Using VSCode version: ${response}`);
};

//#endregion
//#region src/services/github/poll-access-token.ts
async function pollAccessToken(deviceCode) {
	const sleepDuration = (deviceCode.interval + 1) * 1e3;
	consola.debug(`Polling access token with interval of ${sleepDuration}ms`);
	while (true) {
		const response = await fetch(`${GITHUB_BASE_URL}/login/oauth/access_token`, {
			method: "POST",
			headers: standardHeaders(),
			body: JSON.stringify({
				client_id: GITHUB_CLIENT_ID,
				device_code: deviceCode.device_code,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code"
			})
		});
		if (!response.ok) {
			await sleep(sleepDuration);
			consola.error("Failed to poll access token:", await response.text());
			continue;
		}
		const json = await response.json();
		consola.debug("Polling access token response:", json);
		const { access_token } = json;
		if (access_token) return access_token;
		else await sleep(sleepDuration);
	}
}

//#endregion
//#region src/lib/token.ts
const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8");
const writeGithubToken = (token) => fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token);
const setupCopilotToken = async () => {
	const { token, refresh_in } = await getCopilotToken();
	state.copilotToken = token;
	consola.debug("GitHub Copilot Token fetched successfully!");
	if (state.showToken) consola.info("Copilot token:", token);
	const refreshInterval = (refresh_in - 60) * 1e3;
	setInterval(async () => {
		consola.debug("Refreshing Copilot token");
		try {
			const { token: token$1 } = await getCopilotToken();
			state.copilotToken = token$1;
			consola.debug("Copilot token refreshed");
			if (state.showToken) consola.info("Refreshed Copilot token:", token$1);
		} catch (error) {
			consola.error("Failed to refresh Copilot token:", error);
			throw error;
		}
	}, refreshInterval);
};
async function setupGitHubToken(options) {
	try {
		const githubToken = await readGithubToken();
		if (githubToken && !options?.force) {
			state.githubToken = githubToken;
			if (state.showToken) consola.info("GitHub token:", githubToken);
			await logUser();
			return;
		}
		consola.info("Not logged in, getting new access token");
		const response = await getDeviceCode();
		consola.debug("Device code response:", response);
		consola.info(`Please enter the code "${response.user_code}" in ${response.verification_uri}`);
		const token = await pollAccessToken(response);
		await writeGithubToken(token);
		state.githubToken = token;
		if (state.showToken) consola.info("GitHub token:", token);
		await logUser();
	} catch (error) {
		if (error instanceof HTTPError) {
			consola.error("Failed to get GitHub token:", await error.response.json());
			throw error;
		}
		consola.error("Failed to get GitHub token:", error);
		throw error;
	}
}
async function logUser() {
	const user = await getGitHubUser();
	consola.info(`Logged in as ${user.login}`);
}

//#endregion
//#region src/auth.ts
async function runAuth(options) {
	if (options.verbose) {
		consola.level = 5;
		consola.info("Verbose logging enabled");
	}
	state.showToken = options.showToken;
	await ensurePaths();
	await setupGitHubToken({ force: true });
	consola.success("GitHub token written to", PATHS.GITHUB_TOKEN_PATH);
}
const auth = defineCommand({
	meta: {
		name: "auth",
		description: "Run GitHub auth flow without running the server"
	},
	args: {
		verbose: {
			alias: "v",
			type: "boolean",
			default: false,
			description: "Enable verbose logging"
		},
		"show-token": {
			type: "boolean",
			default: false,
			description: "Show GitHub token on auth"
		}
	},
	run({ args }) {
		return runAuth({
			verbose: args.verbose,
			showToken: args["show-token"]
		});
	}
});

//#endregion
//#region src/services/github/get-copilot-usage.ts
const getCopilotUsage = async () => {
	const response = await fetch(`${GITHUB_API_BASE_URL}/copilot_internal/user`, { headers: githubHeaders(state) });
	if (!response.ok) throw new HTTPError("Failed to get Copilot usage", response);
	return await response.json();
};

//#endregion
//#region src/check-usage.ts
const checkUsage = defineCommand({
	meta: {
		name: "check-usage",
		description: "Show current GitHub Copilot usage/quota information"
	},
	async run() {
		await ensurePaths();
		await setupGitHubToken();
		try {
			const usage = await getCopilotUsage();
			const premium = usage.quota_snapshots.premium_interactions;
			const premiumTotal = premium.entitlement;
			const premiumUsed = premiumTotal - premium.remaining;
			const premiumPercentUsed = premiumTotal > 0 ? premiumUsed / premiumTotal * 100 : 0;
			const premiumPercentRemaining = premium.percent_remaining;
			function summarizeQuota(name, snap) {
				if (!snap) return `${name}: N/A`;
				const total = snap.entitlement;
				const used = total - snap.remaining;
				const percentUsed = total > 0 ? used / total * 100 : 0;
				const percentRemaining = snap.percent_remaining;
				return `${name}: ${used}/${total} used (${percentUsed.toFixed(1)}% used, ${percentRemaining.toFixed(1)}% remaining)`;
			}
			const premiumLine = `Premium: ${premiumUsed}/${premiumTotal} used (${premiumPercentUsed.toFixed(1)}% used, ${premiumPercentRemaining.toFixed(1)}% remaining)`;
			const chatLine = summarizeQuota("Chat", usage.quota_snapshots.chat);
			const completionsLine = summarizeQuota("Completions", usage.quota_snapshots.completions);
			consola.box(`Copilot Usage (plan: ${usage.copilot_plan})\nQuota resets: ${usage.quota_reset_date}\n\nQuotas:\n  ${premiumLine}\n  ${chatLine}\n  ${completionsLine}`);
		} catch (err) {
			consola.error("Failed to fetch Copilot usage:", err);
			process.exit(1);
		}
	}
});

//#endregion
//#region src/debug.ts
async function getPackageVersion() {
	try {
		const packageJsonPath = new URL("../package.json", import.meta.url).pathname;
		return JSON.parse(await fs.readFile(packageJsonPath)).version;
	} catch {
		return "unknown";
	}
}
function getRuntimeInfo() {
	const isBun = typeof Bun !== "undefined";
	return {
		name: isBun ? "bun" : "node",
		version: isBun ? Bun.version : process.version.slice(1),
		platform: os.platform(),
		arch: os.arch()
	};
}
async function checkTokenExists() {
	try {
		if (!(await fs.stat(PATHS.GITHUB_TOKEN_PATH)).isFile()) return false;
		return (await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")).trim().length > 0;
	} catch {
		return false;
	}
}
async function getDebugInfo() {
	const [version, tokenExists] = await Promise.all([getPackageVersion(), checkTokenExists()]);
	return {
		version,
		runtime: getRuntimeInfo(),
		paths: {
			APP_DIR: PATHS.APP_DIR,
			GITHUB_TOKEN_PATH: PATHS.GITHUB_TOKEN_PATH
		},
		tokenExists
	};
}
function printDebugInfoPlain(info) {
	consola.info(`copilot-api debug

Version: ${info.version}
Runtime: ${info.runtime.name} ${info.runtime.version} (${info.runtime.platform} ${info.runtime.arch})

Paths:
- APP_DIR: ${info.paths.APP_DIR}
- GITHUB_TOKEN_PATH: ${info.paths.GITHUB_TOKEN_PATH}

Token exists: ${info.tokenExists ? "Yes" : "No"}`);
}
function printDebugInfoJson(info) {
	console.log(JSON.stringify(info, null, 2));
}
async function runDebug(options) {
	const debugInfo = await getDebugInfo();
	if (options.json) printDebugInfoJson(debugInfo);
	else printDebugInfoPlain(debugInfo);
}
const debug = defineCommand({
	meta: {
		name: "debug",
		description: "Print debug information about the application"
	},
	args: { json: {
		type: "boolean",
		default: false,
		description: "Output debug information as JSON"
	} },
	run({ args }) {
		return runDebug({ json: args.json });
	}
});

//#endregion
//#region src/lib/proxy.ts
function initProxyFromEnv() {
	if (typeof Bun !== "undefined") return;
	try {
		const direct = new Agent();
		const proxies = /* @__PURE__ */ new Map();
		setGlobalDispatcher({
			dispatch(options, handler) {
				try {
					const origin = typeof options.origin === "string" ? new URL(options.origin) : options.origin;
					const raw = getProxyForUrl(origin.toString());
					const proxyUrl = raw && raw.length > 0 ? raw : void 0;
					if (!proxyUrl) {
						consola.debug(`HTTP proxy bypass: ${origin.hostname}`);
						return direct.dispatch(options, handler);
					}
					let agent = proxies.get(proxyUrl);
					if (!agent) {
						agent = new ProxyAgent(proxyUrl);
						proxies.set(proxyUrl, agent);
					}
					let label = proxyUrl;
					try {
						const u = new URL(proxyUrl);
						label = `${u.protocol}//${u.host}`;
					} catch {}
					consola.debug(`HTTP proxy route: ${origin.hostname} via ${label}`);
					return agent.dispatch(options, handler);
				} catch {
					return direct.dispatch(options, handler);
				}
			},
			close() {
				return direct.close();
			},
			destroy() {
				return direct.destroy();
			}
		});
		consola.debug("HTTP proxy configured from environment (per-URL)");
	} catch (err) {
		consola.debug("Proxy setup skipped:", err);
	}
}

//#endregion
//#region src/lib/shell.ts
function getShell() {
	const { platform, ppid, env } = process$1;
	if (platform === "win32") {
		try {
			if (execSync(`wmic process get ParentProcessId,Name | findstr "${ppid}"`, { stdio: "pipe" }).toString().toLowerCase().includes("powershell.exe")) return "powershell";
		} catch {
			return "cmd";
		}
		return "cmd";
	} else {
		const shellPath = env.SHELL;
		if (shellPath) {
			if (shellPath.endsWith("zsh")) return "zsh";
			if (shellPath.endsWith("fish")) return "fish";
			if (shellPath.endsWith("bash")) return "bash";
		}
		return "sh";
	}
}
/**
* Generates a copy-pasteable script to set multiple environment variables
* and run a subsequent command.
* @param {EnvVars} envVars - An object of environment variables to set.
* @param {string} commandToRun - The command to run after setting the variables.
* @returns {string} The formatted script string.
*/
function generateEnvScript(envVars, commandToRun = "") {
	const shell = getShell();
	const filteredEnvVars = Object.entries(envVars).filter(([, value]) => value !== void 0);
	let commandBlock;
	switch (shell) {
		case "powershell":
			commandBlock = filteredEnvVars.map(([key, value]) => `$env:${key} = ${value}`).join("; ");
			break;
		case "cmd":
			commandBlock = filteredEnvVars.map(([key, value]) => `set ${key}=${value}`).join(" & ");
			break;
		case "fish":
			commandBlock = filteredEnvVars.map(([key, value]) => `set -gx ${key} ${value}`).join("; ");
			break;
		default: {
			const assignments = filteredEnvVars.map(([key, value]) => `${key}=${value}`).join(" ");
			commandBlock = filteredEnvVars.length > 0 ? `export ${assignments}` : "";
			break;
		}
	}
	if (commandBlock && commandToRun) return `${commandBlock}${shell === "cmd" ? " & " : " && "}${commandToRun}`;
	return commandBlock || commandToRun;
}

//#endregion
//#region src/lib/approval.ts
const awaitApproval = async () => {
	if (!await consola.prompt(`Accept incoming request?`, { type: "confirm" })) throw new HTTPError("Request rejected", Response.json({ message: "Request rejected" }, { status: 403 }));
};

//#endregion
//#region src/lib/rate-limit.ts
async function checkRateLimit(state$1) {
	if (state$1.rateLimitSeconds === void 0) return;
	const now = Date.now();
	if (!state$1.lastRequestTimestamp) {
		state$1.lastRequestTimestamp = now;
		return;
	}
	const elapsedSeconds = (now - state$1.lastRequestTimestamp) / 1e3;
	if (elapsedSeconds > state$1.rateLimitSeconds) {
		state$1.lastRequestTimestamp = now;
		return;
	}
	const waitTimeSeconds = Math.ceil(state$1.rateLimitSeconds - elapsedSeconds);
	if (!state$1.rateLimitWait) {
		consola.warn(`Rate limit exceeded. Need to wait ${waitTimeSeconds} more seconds.`);
		throw new HTTPError("Rate limit exceeded", Response.json({ message: "Rate limit exceeded" }, { status: 429 }));
	}
	const waitTimeMs = waitTimeSeconds * 1e3;
	consola.warn(`Rate limit reached. Waiting ${waitTimeSeconds} seconds before proceeding...`);
	await sleep(waitTimeMs);
	state$1.lastRequestTimestamp = now;
	consola.info("Rate limit wait completed, proceeding with request");
}

//#endregion
//#region src/lib/tokenizer.ts
const ENCODING_MAP = {
	o200k_base: () => import("gpt-tokenizer/encoding/o200k_base"),
	cl100k_base: () => import("gpt-tokenizer/encoding/cl100k_base"),
	p50k_base: () => import("gpt-tokenizer/encoding/p50k_base"),
	p50k_edit: () => import("gpt-tokenizer/encoding/p50k_edit"),
	r50k_base: () => import("gpt-tokenizer/encoding/r50k_base")
};
const encodingCache = /* @__PURE__ */ new Map();
/**
* Calculate tokens for tool calls
*/
const calculateToolCallsTokens = (toolCalls, encoder, constants) => {
	let tokens = 0;
	for (const toolCall of toolCalls) {
		tokens += constants.funcInit;
		tokens += encoder.encode(JSON.stringify(toolCall)).length;
	}
	tokens += constants.funcEnd;
	return tokens;
};
/**
* Calculate tokens for content parts
*/
const calculateContentPartsTokens = (contentParts, encoder) => {
	let tokens = 0;
	for (const part of contentParts) if (part.type === "image_url") tokens += encoder.encode(part.image_url.url).length + 85;
	else if (part.text) tokens += encoder.encode(part.text).length;
	return tokens;
};
/**
* Calculate tokens for a single message
*/
const calculateMessageTokens = (message, encoder, constants) => {
	const tokensPerMessage = 3;
	const tokensPerName = 1;
	let tokens = tokensPerMessage;
	for (const [key, value] of Object.entries(message)) {
		if (typeof value === "string") tokens += encoder.encode(value).length;
		if (key === "name") tokens += tokensPerName;
		if (key === "tool_calls") tokens += calculateToolCallsTokens(value, encoder, constants);
		if (key === "content" && Array.isArray(value)) tokens += calculateContentPartsTokens(value, encoder);
	}
	return tokens;
};
/**
* Calculate tokens using custom algorithm
*/
const calculateTokens = (messages, encoder, constants) => {
	if (messages.length === 0) return 0;
	let numTokens = 0;
	for (const message of messages) numTokens += calculateMessageTokens(message, encoder, constants);
	numTokens += 3;
	return numTokens;
};
/**
* Get the corresponding encoder module based on encoding type
*/
const getEncodeChatFunction = async (encoding) => {
	if (encodingCache.has(encoding)) {
		const cached = encodingCache.get(encoding);
		if (cached) return cached;
	}
	const supportedEncoding = encoding;
	if (!(supportedEncoding in ENCODING_MAP)) {
		const fallbackModule = await ENCODING_MAP.o200k_base();
		encodingCache.set(encoding, fallbackModule);
		return fallbackModule;
	}
	const encodingModule = await ENCODING_MAP[supportedEncoding]();
	encodingCache.set(encoding, encodingModule);
	return encodingModule;
};
/**
* Get tokenizer type from model information
*/
const getTokenizerFromModel = (model) => {
	return model.capabilities.tokenizer || "o200k_base";
};
/**
* Get model-specific constants for token calculation
*/
const getModelConstants = (model) => {
	return model.id === "gpt-3.5-turbo" || model.id === "gpt-4" ? {
		funcInit: 10,
		propInit: 3,
		propKey: 3,
		enumInit: -3,
		enumItem: 3,
		funcEnd: 12
	} : {
		funcInit: 7,
		propInit: 3,
		propKey: 3,
		enumInit: -3,
		enumItem: 3,
		funcEnd: 12
	};
};
/**
* Calculate tokens for a single parameter
*/
const calculateParameterTokens = (key, prop, context) => {
	const { encoder, constants } = context;
	let tokens = constants.propKey;
	if (typeof prop !== "object" || prop === null) return tokens;
	const param = prop;
	const paramName = key;
	const paramType = param.type || "string";
	let paramDesc = param.description || "";
	if (param.enum && Array.isArray(param.enum)) {
		tokens += constants.enumInit;
		for (const item of param.enum) {
			tokens += constants.enumItem;
			tokens += encoder.encode(String(item)).length;
		}
	}
	if (paramDesc.endsWith(".")) paramDesc = paramDesc.slice(0, -1);
	const line = `${paramName}:${paramType}:${paramDesc}`;
	tokens += encoder.encode(line).length;
	const excludedKeys = new Set([
		"type",
		"description",
		"enum"
	]);
	for (const propertyName of Object.keys(param)) if (!excludedKeys.has(propertyName)) {
		const propertyValue = param[propertyName];
		const propertyText = typeof propertyValue === "string" ? propertyValue : JSON.stringify(propertyValue);
		tokens += encoder.encode(`${propertyName}:${propertyText}`).length;
	}
	return tokens;
};
/**
* Calculate tokens for function parameters
*/
const calculateParametersTokens = (parameters, encoder, constants) => {
	if (!parameters || typeof parameters !== "object") return 0;
	const params = parameters;
	let tokens = 0;
	for (const [key, value] of Object.entries(params)) if (key === "properties") {
		const properties = value;
		if (Object.keys(properties).length > 0) {
			tokens += constants.propInit;
			for (const propKey of Object.keys(properties)) tokens += calculateParameterTokens(propKey, properties[propKey], {
				encoder,
				constants
			});
		}
	} else {
		const paramText = typeof value === "string" ? value : JSON.stringify(value);
		tokens += encoder.encode(`${key}:${paramText}`).length;
	}
	return tokens;
};
/**
* Calculate tokens for a single tool
*/
const calculateToolTokens = (tool, encoder, constants) => {
	let tokens = constants.funcInit;
	const func = tool.function;
	const fName = func.name;
	let fDesc = func.description || "";
	if (fDesc.endsWith(".")) fDesc = fDesc.slice(0, -1);
	const line = fName + ":" + fDesc;
	tokens += encoder.encode(line).length;
	if (typeof func.parameters === "object" && func.parameters !== null) tokens += calculateParametersTokens(func.parameters, encoder, constants);
	return tokens;
};
/**
* Calculate token count for tools based on model
*/
const numTokensForTools = (tools, encoder, constants) => {
	let funcTokenCount = 0;
	for (const tool of tools) funcTokenCount += calculateToolTokens(tool, encoder, constants);
	funcTokenCount += constants.funcEnd;
	return funcTokenCount;
};
/**
* Calculate the token count of messages, supporting multiple GPT encoders
*/
const getTokenCount = async (payload, model) => {
	const encoder = await getEncodeChatFunction(getTokenizerFromModel(model));
	const simplifiedMessages = payload.messages;
	const inputMessages = simplifiedMessages.filter((msg) => msg.role !== "assistant");
	const outputMessages = simplifiedMessages.filter((msg) => msg.role === "assistant");
	const constants = getModelConstants(model);
	let inputTokens = calculateTokens(inputMessages, encoder, constants);
	if (payload.tools && payload.tools.length > 0) inputTokens += numTokensForTools(payload.tools, encoder, constants);
	const outputTokens = calculateTokens(outputMessages, encoder, constants);
	return {
		input: inputTokens,
		output: outputTokens
	};
};

//#endregion
//#region src/services/copilot/create-chat-completions.ts
const createChatCompletions = async (payload) => {
	if (!state.copilotToken) throw new Error("Copilot token not found");
	const enableVision = payload.messages.some((x) => typeof x.content !== "string" && x.content?.some((x$1) => x$1.type === "image_url"));
	const isAgentCall = payload.messages.some((msg) => ["assistant", "tool"].includes(msg.role));
	const headers = {
		...copilotHeaders(state, enableVision),
		"X-Initiator": isAgentCall ? "agent" : "user"
	};
	const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
		method: "POST",
		headers,
		body: JSON.stringify(payload)
	});
	if (!response.ok) {
		consola.error("Failed to create chat completions", response);
		throw new HTTPError("Failed to create chat completions", response);
	}
	if (payload.stream) return events(response);
	return await response.json();
};

//#endregion
//#region src/routes/chat-completions/handler.ts
async function handleCompletion$1(c) {
	await checkRateLimit(state);
	let payload = await c.req.json();
	consola.debug("Request payload:", JSON.stringify(payload).slice(-400));
	const selectedModel = state.models?.data.find((model) => model.id === payload.model);
	try {
		if (selectedModel) {
			const tokenCount = await getTokenCount(payload, selectedModel);
			consola.info("Current token count:", tokenCount);
		} else consola.warn("No model selected, skipping token count calculation");
	} catch (error) {
		consola.warn("Failed to calculate token count:", error);
	}
	if (state.manualApprove) await awaitApproval();
	if (isNullish(payload.max_tokens)) {
		payload = {
			...payload,
			max_tokens: selectedModel?.capabilities.limits.max_output_tokens
		};
		consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens));
	}
	const response = await createChatCompletions(payload);
	if (isNonStreaming$1(response)) {
		consola.debug("Non-streaming response:", JSON.stringify(response));
		return c.json(response);
	}
	consola.debug("Streaming response");
	return streamSSE(c, async (stream) => {
		for await (const chunk of response) {
			consola.debug("Streaming chunk:", JSON.stringify(chunk));
			await stream.writeSSE(chunk);
		}
	});
}
const isNonStreaming$1 = (response) => Object.hasOwn(response, "choices");

//#endregion
//#region src/routes/chat-completions/route.ts
const completionRoutes = new Hono();
completionRoutes.post("/", async (c) => {
	try {
		return await handleCompletion$1(c);
	} catch (error) {
		return await forwardError(c, error);
	}
});

//#endregion
//#region src/services/copilot/create-embeddings.ts
const createEmbeddings = async (payload) => {
	if (!state.copilotToken) throw new Error("Copilot token not found");
	const response = await fetch(`${copilotBaseUrl(state)}/embeddings`, {
		method: "POST",
		headers: copilotHeaders(state),
		body: JSON.stringify(payload)
	});
	if (!response.ok) throw new HTTPError("Failed to create embeddings", response);
	return await response.json();
};

//#endregion
//#region src/routes/embeddings/route.ts
const embeddingRoutes = new Hono();
embeddingRoutes.post("/", async (c) => {
	try {
		const response = await createEmbeddings(await c.req.json());
		return c.json(response);
	} catch (error) {
		return await forwardError(c, error);
	}
});

//#endregion
//#region src/routes/messages/utils.ts
function mapOpenAIStopReasonToAnthropic(finishReason) {
	if (finishReason === null) return null;
	return {
		stop: "end_turn",
		length: "max_tokens",
		tool_calls: "tool_use",
		content_filter: "end_turn"
	}[finishReason];
}

//#endregion
//#region src/routes/messages/non-stream-translation.ts
function translateToOpenAI(payload) {
	return {
		model: translateModelName(payload.model),
		messages: translateAnthropicMessagesToOpenAI(payload.messages, payload.system),
		max_tokens: payload.max_tokens,
		stop: payload.stop_sequences,
		stream: payload.stream,
		temperature: payload.temperature,
		top_p: payload.top_p,
		user: payload.metadata?.user_id,
		tools: translateAnthropicToolsToOpenAI(payload.tools),
		tool_choice: translateAnthropicToolChoiceToOpenAI(payload.tool_choice)
	};
}
function translateModelName(model) {
	const availableModels = state.models?.data.map((m) => m.id) ?? [];
	if (availableModels.length === 0) return model;
	const stripped = model.replace(/\[.*\]$/, "");
	if (availableModels.includes(stripped)) return stripped;
	const match = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/.exec(stripped);
	if (match) {
		const [, family, major, minor] = match;
		const dotted = `claude-${family}-${major}.${minor}`;
		if (availableModels.includes(dotted)) return dotted;
		const bare = `claude-${family}-${major}`;
		if (availableModels.includes(bare)) return bare;
		const familyModels = availableModels.filter((id) => id.startsWith(`claude-${family}-`) || id === `claude-${family}`);
		if (familyModels.length > 0) return [...familyModels].sort().reverse()[0];
	}
	return stripped;
}
function translateAnthropicMessagesToOpenAI(anthropicMessages, system) {
	const systemMessages = handleSystemPrompt(system);
	const otherMessages = anthropicMessages.flatMap((message) => message.role === "user" ? handleUserMessage(message) : handleAssistantMessage(message));
	const lastMessage = otherMessages.at(-1);
	if (lastMessage?.role === "assistant" && !lastMessage.tool_calls) otherMessages.push({
		role: "user",
		content: "Continue exactly where you left off. Do not repeat any previously written text."
	});
	return [...systemMessages, ...otherMessages];
}
function handleSystemPrompt(system) {
	if (!system) return [];
	if (typeof system === "string") return [{
		role: "system",
		content: system
	}];
	else return [{
		role: "system",
		content: system.map((block) => block.text).join("\n\n")
	}];
}
function handleUserMessage(message) {
	const newMessages = [];
	if (Array.isArray(message.content)) {
		const toolResultBlocks = message.content.filter((block) => block.type === "tool_result");
		const otherBlocks = message.content.filter((block) => block.type !== "tool_result");
		for (const block of toolResultBlocks) newMessages.push({
			role: "tool",
			tool_call_id: block.tool_use_id,
			content: mapContent(block.content)
		});
		if (otherBlocks.length > 0) newMessages.push({
			role: "user",
			content: mapContent(otherBlocks)
		});
	} else newMessages.push({
		role: "user",
		content: mapContent(message.content)
	});
	return newMessages;
}
function handleAssistantMessage(message) {
	if (!Array.isArray(message.content)) return [{
		role: "assistant",
		content: mapContent(message.content)
	}];
	const toolUseBlocks = message.content.filter((block) => block.type === "tool_use");
	const textBlocks = message.content.filter((block) => block.type === "text");
	const thinkingBlocks = message.content.filter((block) => block.type === "thinking");
	const allTextContent = [...textBlocks.map((b) => b.text), ...thinkingBlocks.map((b) => b.thinking)].join("\n\n");
	return toolUseBlocks.length > 0 ? [{
		role: "assistant",
		content: allTextContent || null,
		tool_calls: toolUseBlocks.map((toolUse) => ({
			id: toolUse.id,
			type: "function",
			function: {
				name: toolUse.name,
				arguments: JSON.stringify(toolUse.input)
			}
		}))
	}] : [{
		role: "assistant",
		content: mapContent(message.content)
	}];
}
function mapContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	if (!content.some((block) => block.type === "image")) return content.filter((block) => block.type === "text" || block.type === "thinking").map((block) => block.type === "text" ? block.text : block.thinking).join("\n\n");
	const contentParts = [];
	for (const block of content) switch (block.type) {
		case "text":
			contentParts.push({
				type: "text",
				text: block.text
			});
			break;
		case "thinking":
			contentParts.push({
				type: "text",
				text: block.thinking
			});
			break;
		case "image":
			contentParts.push({
				type: "image_url",
				image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` }
			});
			break;
	}
	return contentParts;
}
function translateAnthropicToolsToOpenAI(anthropicTools) {
	if (!anthropicTools) return;
	return anthropicTools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.input_schema
		}
	}));
}
function translateAnthropicToolChoiceToOpenAI(anthropicToolChoice) {
	if (!anthropicToolChoice) return;
	switch (anthropicToolChoice.type) {
		case "auto": return "auto";
		case "any": return "required";
		case "tool":
			if (anthropicToolChoice.name) return {
				type: "function",
				function: { name: anthropicToolChoice.name }
			};
			return;
		case "none": return "none";
		default: return;
	}
}
function translateToAnthropic(response) {
	const allTextBlocks = [];
	const allToolUseBlocks = [];
	let stopReason = null;
	stopReason = response.choices[0]?.finish_reason ?? stopReason;
	for (const choice of response.choices) {
		const textBlocks = getAnthropicTextBlocks(choice.message.content);
		const toolUseBlocks = getAnthropicToolUseBlocks(choice.message.tool_calls);
		allTextBlocks.push(...textBlocks);
		allToolUseBlocks.push(...toolUseBlocks);
		if (choice.finish_reason === "tool_calls" || stopReason === "stop") stopReason = choice.finish_reason;
	}
	return {
		id: response.id,
		type: "message",
		role: "assistant",
		model: response.model,
		content: [...allTextBlocks, ...allToolUseBlocks],
		stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
		stop_sequence: null,
		usage: {
			input_tokens: (response.usage?.prompt_tokens ?? 0) - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
			output_tokens: response.usage?.completion_tokens ?? 0,
			...response.usage?.prompt_tokens_details?.cached_tokens !== void 0 && { cache_read_input_tokens: response.usage.prompt_tokens_details.cached_tokens }
		}
	};
}
function getAnthropicTextBlocks(messageContent) {
	if (typeof messageContent === "string") return [{
		type: "text",
		text: messageContent
	}];
	if (Array.isArray(messageContent)) return messageContent.filter((part) => part.type === "text").map((part) => ({
		type: "text",
		text: part.text
	}));
	return [];
}
function getAnthropicToolUseBlocks(toolCalls) {
	if (!toolCalls) return [];
	return toolCalls.map((toolCall) => ({
		type: "tool_use",
		id: toolCall.id,
		name: toolCall.function.name,
		input: JSON.parse(toolCall.function.arguments)
	}));
}

//#endregion
//#region src/routes/messages/count-tokens-handler.ts
/**
* Handles token counting for Anthropic messages
*/
async function handleCountTokens(c) {
	try {
		const anthropicBeta = c.req.header("anthropic-beta");
		const anthropicPayload = await c.req.json();
		const openAIPayload = translateToOpenAI(anthropicPayload);
		const selectedModel = state.models?.data.find((model) => model.id === anthropicPayload.model);
		if (!selectedModel) {
			consola.warn("Model not found, returning default token count");
			return c.json({ input_tokens: 1 });
		}
		const tokenCount = await getTokenCount(openAIPayload, selectedModel);
		if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
			let mcpToolExist = false;
			if (anthropicBeta?.startsWith("claude-code")) mcpToolExist = anthropicPayload.tools.some((tool) => tool.name.startsWith("mcp__"));
			if (!mcpToolExist) {
				if (anthropicPayload.model.startsWith("claude")) tokenCount.input = tokenCount.input + 346;
				else if (anthropicPayload.model.startsWith("grok")) tokenCount.input = tokenCount.input + 480;
			}
		}
		let finalTokenCount = tokenCount.input + tokenCount.output;
		if (anthropicPayload.model.startsWith("claude")) finalTokenCount = Math.round(finalTokenCount * 1.15);
		else if (anthropicPayload.model.startsWith("grok")) finalTokenCount = Math.round(finalTokenCount * 1.03);
		consola.info("Token count:", finalTokenCount);
		return c.json({ input_tokens: finalTokenCount });
	} catch (error) {
		consola.error("Error counting tokens:", error);
		return c.json({ input_tokens: 1 });
	}
}

//#endregion
//#region src/routes/messages/stream-translation.ts
function isToolBlockOpen(state$1) {
	if (!state$1.contentBlockOpen) return false;
	return Object.values(state$1.toolCalls).some((tc) => tc.anthropicBlockIndex === state$1.contentBlockIndex);
}
function translateChunkToAnthropicEvents(chunk, state$1) {
	const events$1 = [];
	if (chunk.choices.length === 0) return events$1;
	const choice = chunk.choices[0];
	const { delta } = choice;
	if (!state$1.messageStartSent) {
		events$1.push({
			type: "message_start",
			message: {
				id: chunk.id,
				type: "message",
				role: "assistant",
				content: [],
				model: chunk.model,
				stop_reason: null,
				stop_sequence: null,
				usage: {
					input_tokens: (chunk.usage?.prompt_tokens ?? 0) - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
					output_tokens: 0,
					...chunk.usage?.prompt_tokens_details?.cached_tokens !== void 0 && { cache_read_input_tokens: chunk.usage.prompt_tokens_details.cached_tokens }
				}
			}
		});
		state$1.messageStartSent = true;
	}
	if (delta.content) {
		if (isToolBlockOpen(state$1)) {
			events$1.push({
				type: "content_block_stop",
				index: state$1.contentBlockIndex
			});
			state$1.contentBlockIndex++;
			state$1.contentBlockOpen = false;
		}
		if (!state$1.contentBlockOpen) {
			events$1.push({
				type: "content_block_start",
				index: state$1.contentBlockIndex,
				content_block: {
					type: "text",
					text: ""
				}
			});
			state$1.contentBlockOpen = true;
		}
		events$1.push({
			type: "content_block_delta",
			index: state$1.contentBlockIndex,
			delta: {
				type: "text_delta",
				text: delta.content
			}
		});
	}
	if (delta.tool_calls) for (const toolCall of delta.tool_calls) {
		if (toolCall.id && toolCall.function?.name) {
			if (state$1.contentBlockOpen) {
				events$1.push({
					type: "content_block_stop",
					index: state$1.contentBlockIndex
				});
				state$1.contentBlockIndex++;
				state$1.contentBlockOpen = false;
			}
			const anthropicBlockIndex = state$1.contentBlockIndex;
			state$1.toolCalls[toolCall.index] = {
				id: toolCall.id,
				name: toolCall.function.name,
				anthropicBlockIndex
			};
			events$1.push({
				type: "content_block_start",
				index: anthropicBlockIndex,
				content_block: {
					type: "tool_use",
					id: toolCall.id,
					name: toolCall.function.name,
					input: {}
				}
			});
			state$1.contentBlockOpen = true;
		}
		if (toolCall.function?.arguments) {
			const toolCallInfo = state$1.toolCalls[toolCall.index];
			if (toolCallInfo) events$1.push({
				type: "content_block_delta",
				index: toolCallInfo.anthropicBlockIndex,
				delta: {
					type: "input_json_delta",
					partial_json: toolCall.function.arguments
				}
			});
		}
	}
	if (choice.finish_reason) {
		if (state$1.contentBlockOpen) {
			events$1.push({
				type: "content_block_stop",
				index: state$1.contentBlockIndex
			});
			state$1.contentBlockOpen = false;
		}
		events$1.push({
			type: "message_delta",
			delta: {
				stop_reason: mapOpenAIStopReasonToAnthropic(choice.finish_reason),
				stop_sequence: null
			},
			usage: {
				input_tokens: (chunk.usage?.prompt_tokens ?? 0) - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
				output_tokens: chunk.usage?.completion_tokens ?? 0,
				...chunk.usage?.prompt_tokens_details?.cached_tokens !== void 0 && { cache_read_input_tokens: chunk.usage.prompt_tokens_details.cached_tokens }
			}
		}, { type: "message_stop" });
	}
	return events$1;
}

//#endregion
//#region src/routes/messages/handler.ts
async function handleCompletion(c) {
	await checkRateLimit(state);
	const anthropicPayload = await c.req.json();
	consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload));
	const openAIPayload = translateToOpenAI(anthropicPayload);
	consola.debug("Translated OpenAI request payload:", JSON.stringify(openAIPayload));
	if (state.manualApprove) await awaitApproval();
	const response = await createChatCompletions(openAIPayload);
	if (isNonStreaming(response)) {
		consola.debug("Non-streaming response from Copilot:", JSON.stringify(response).slice(-400));
		const anthropicResponse = translateToAnthropic(response);
		consola.debug("Translated Anthropic response:", JSON.stringify(anthropicResponse));
		return c.json(anthropicResponse);
	}
	consola.debug("Streaming response from Copilot");
	return streamSSE(c, async (stream) => {
		const streamState = {
			messageStartSent: false,
			contentBlockIndex: 0,
			contentBlockOpen: false,
			toolCalls: {}
		};
		for await (const rawEvent of response) {
			consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent));
			if (rawEvent.data === "[DONE]") break;
			if (!rawEvent.data) continue;
			const events$1 = translateChunkToAnthropicEvents(JSON.parse(rawEvent.data), streamState);
			for (const event of events$1) {
				consola.debug("Translated Anthropic event:", JSON.stringify(event));
				await stream.writeSSE({
					event: event.type,
					data: JSON.stringify(event)
				});
			}
		}
	});
}
const isNonStreaming = (response) => Object.hasOwn(response, "choices");

//#endregion
//#region src/routes/messages/route.ts
const messageRoutes = new Hono();
messageRoutes.post("/", async (c) => {
	try {
		return await handleCompletion(c);
	} catch (error) {
		return await forwardError(c, error);
	}
});
messageRoutes.post("/count_tokens", async (c) => {
	try {
		return await handleCountTokens(c);
	} catch (error) {
		return await forwardError(c, error);
	}
});

//#endregion
//#region src/routes/models/route.ts
const modelRoutes = new Hono();
modelRoutes.get("/", async (c) => {
	try {
		if (!state.models) await cacheModels();
		const models = state.models?.data.map((model) => ({
			id: model.id,
			object: "model",
			type: "model",
			created: 0,
			created_at: (/* @__PURE__ */ new Date(0)).toISOString(),
			owned_by: model.vendor,
			display_name: model.name
		}));
		return c.json({
			object: "list",
			data: models,
			has_more: false
		});
	} catch (error) {
		return await forwardError(c, error);
	}
});

//#endregion
//#region src/routes/token/route.ts
const tokenRoute = new Hono();
tokenRoute.get("/", (c) => {
	try {
		return c.json({ token: state.copilotToken });
	} catch (error) {
		console.error("Error fetching token:", error);
		return c.json({
			error: "Failed to fetch token",
			token: null
		}, 500);
	}
});

//#endregion
//#region src/routes/usage/route.ts
const usageRoute = new Hono();
usageRoute.get("/", async (c) => {
	try {
		const usage = await getCopilotUsage();
		return c.json(usage);
	} catch (error) {
		console.error("Error fetching Copilot usage:", error);
		return c.json({ error: "Failed to fetch Copilot usage" }, 500);
	}
});

//#endregion
//#region src/server.ts
const server = new Hono();
server.use(logger());
server.use(cors());
server.get("/", (c) => c.text("Server running"));
server.route("/chat/completions", completionRoutes);
server.route("/models", modelRoutes);
server.route("/embeddings", embeddingRoutes);
server.route("/usage", usageRoute);
server.route("/token", tokenRoute);
server.route("/v1/chat/completions", completionRoutes);
server.route("/v1/models", modelRoutes);
server.route("/v1/embeddings", embeddingRoutes);
server.route("/v1/messages", messageRoutes);

//#endregion
//#region src/start.ts
async function runServer(options) {
	if (options.proxyEnv) initProxyFromEnv();
	if (options.verbose) {
		consola.level = 5;
		consola.info("Verbose logging enabled");
	}
	state.accountType = options.accountType;
	if (options.accountType !== "individual") consola.info(`Using ${options.accountType} plan GitHub account`);
	state.manualApprove = options.manual;
	state.rateLimitSeconds = options.rateLimit;
	state.rateLimitWait = options.rateLimitWait;
	state.showToken = options.showToken;
	await ensurePaths();
	await cacheVSCodeVersion();
	if (options.githubToken) {
		state.githubToken = options.githubToken;
		consola.info("Using provided GitHub token");
	} else await setupGitHubToken();
	await setupCopilotToken();
	await cacheModels();
	consola.info(`Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`);
	const serverUrl = `http://localhost:${options.port}`;
	if (options.claudeCode) {
		invariant(state.models, "Models should be loaded by now");
		const selectedModel = await consola.prompt("Select a model to use with Claude Code", {
			type: "select",
			options: state.models.data.map((model) => model.id)
		});
		const selectedSmallModel = await consola.prompt("Select a small model to use with Claude Code", {
			type: "select",
			options: state.models.data.map((model) => model.id)
		});
		const command = generateEnvScript({
			ANTHROPIC_BASE_URL: serverUrl,
			ANTHROPIC_AUTH_TOKEN: "dummy",
			ANTHROPIC_MODEL: selectedModel,
			ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
			ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
			ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
			DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
		}, "claude");
		try {
			clipboard.writeSync(command);
			consola.success("Copied Claude Code command to clipboard!");
		} catch {
			consola.warn("Failed to copy to clipboard. Here is the Claude Code command:");
			consola.log(command);
		}
	}
	consola.box(`🌐 Usage Viewer: https://ericc-ch.github.io/copilot-api?endpoint=${serverUrl}/usage`);
	serve({
		fetch: server.fetch,
		port: options.port
	});
}
const start = defineCommand({
	meta: {
		name: "start",
		description: "Start the Copilot API server"
	},
	args: {
		port: {
			alias: "p",
			type: "string",
			default: "4141",
			description: "Port to listen on"
		},
		verbose: {
			alias: "v",
			type: "boolean",
			default: false,
			description: "Enable verbose logging"
		},
		"account-type": {
			alias: "a",
			type: "string",
			default: "individual",
			description: "Account type to use (individual, business, enterprise)"
		},
		manual: {
			type: "boolean",
			default: false,
			description: "Enable manual request approval"
		},
		"rate-limit": {
			alias: "r",
			type: "string",
			description: "Rate limit in seconds between requests"
		},
		wait: {
			alias: "w",
			type: "boolean",
			default: false,
			description: "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set"
		},
		"github-token": {
			alias: "g",
			type: "string",
			description: "Provide GitHub token directly (must be generated using the `auth` subcommand)"
		},
		"claude-code": {
			alias: "c",
			type: "boolean",
			default: false,
			description: "Generate a command to launch Claude Code with Copilot API config"
		},
		"show-token": {
			type: "boolean",
			default: false,
			description: "Show GitHub and Copilot tokens on fetch and refresh"
		},
		"proxy-env": {
			type: "boolean",
			default: false,
			description: "Initialize proxy from environment variables"
		}
	},
	run({ args }) {
		const rateLimitRaw = args["rate-limit"];
		const rateLimit = rateLimitRaw === void 0 ? void 0 : Number.parseInt(rateLimitRaw, 10);
		return runServer({
			port: Number.parseInt(args.port, 10),
			verbose: args.verbose,
			accountType: args["account-type"],
			manual: args.manual,
			rateLimit,
			rateLimitWait: args.wait,
			githubToken: args["github-token"],
			claudeCode: args["claude-code"],
			showToken: args["show-token"],
			proxyEnv: args["proxy-env"]
		});
	}
});

//#endregion
//#region src/main.ts
await runMain(defineCommand({
	meta: {
		name: "copilot-api",
		description: "A wrapper around GitHub Copilot API to make it OpenAI compatible, making it usable for other tools."
	},
	subCommands: {
		auth,
		start,
		"check-usage": checkUsage,
		debug
	}
}));

//#endregion
export {  };
//# sourceMappingURL=main.js.map