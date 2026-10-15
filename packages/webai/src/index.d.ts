import type { IncomingMessage, ServerResponse } from 'node:http';

export type Trigger = 'shift-click' | 'alt-click' | 'contextmenu';

export interface ClaudeOptions {
  /** Executable, default `claude`. */
  bin?: string;
  model?: string;
  /** Default `acceptEdits`: the agent may edit files, but not run shell commands. */
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | (string & {});
  /** Extra allowed tools, e.g. `['Bash(npm run check)']`. Without a Bash entry, Bash isn't offered to the agent at all. */
  allowedTools?: string[];
  /** Load skills and subagents from `@jantcz/webai/agents` (`--plugin-dir`). Default `true`. */
  skills?: boolean;
  /**
   * Load settings and MCP servers from the project (`.claude/`, `.mcp.json`).
   * Default `true`, bridge `false`: the container can write to the project too.
   */
  projectSettings?: boolean;
  extraArgs?: string[];
}

export interface CodexOptions {
  bin?: string;
  model?: string;
  /** Models offered in the panel. */
  models?: string[];
  /** Default `workspace-write`. */
  sandbox?: 'read-only' | 'workspace-write' | (string & {});
  extraArgs?: string[];
}

export interface GeminiOptions {
  bin?: string;
  model?: string;
  /** Default `auto_edit`. */
  approvalMode?: 'default' | 'auto_edit' | 'plan' | (string & {});
  extraArgs?: string[];
}

/** Agent in a container: `docker compose run --rm <service> <cli> …` per message. */
export interface DockerTarget {
  /** Service in docker-compose.yml. */
  service: string;
  /** Project root in the container, e.g. `/workspace/examples/astro`. */
  workdir: string;
}

type ModelChoice = { value: string; label: string };

export interface OpenCodeOptions {
  bin?: string;
  docker?: DockerTarget;
  /** Default `opencode/deepseek-v4.1-flash-free` (free, no account). */
  model?: string;
  models?: ModelChoice[];
  /** OpenCode permissions. Default `{ edit: 'allow', bash: 'deny', webfetch: 'deny' }`. */
  permission?: Record<string, string>;
  extraArgs?: string[];
}

export interface PiOptions {
  bin?: string;
  docker?: DockerTarget;
  /** `provider/id`, e.g. `openrouter/poolside/laguna-s-2.1:free`. */
  model?: string;
  models?: ModelChoice[];
  /** Default `read, edit, write, grep, find, ls` (no `bash`). */
  tools?: string[];
  /** Load skills from `@jantcz/webai/agents`. Default `true`. */
  skills?: boolean;
  extraArgs?: string[];
}

export interface CustomOptions {
  /** Command for the "Other" option. Supports `{prompt}` and `{session}`. */
  command?: string;
  /**
   * Whether the command can be changed in the panel. Default `false`: any script
   * on the dev page can read the overlay's token, so an editable command means
   * that script can run anything on this machine. Ignored with `allowRemote`.
   */
  editable?: boolean;
}

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export type SettingSpec =
  | { value: string; label: string; disabled?: boolean }[]
  | { type: 'text'; label?: string; placeholder?: string; hint?: string; default?: string; readonly?: boolean }
  /** A button; the overlay sends `POST /action { agent, action }`. */
  | { type: 'action'; label: string; action: string; hint?: string };

export interface AgentAdapter {
  name: string;
  /** Name shown in the panel, default `name`. */
  label?: string;
  /** Executable for detection (`<bin> --version`). `null` = always available. */
  bin: string | null;
  versionArgs?: string[];
  /** `true`: the overlay generates the conversation ID. `false`: the agent sends it in a `{ type: 'session', id }` event. */
  presetSessionId: boolean;
  /** Stdout is plain lines of text, not JSON. */
  raw?: boolean;
  /** Options switchable in the panel (⚙). */
  settings?: Record<string, SettingSpec>;
  /** Once per server run before first use, returns the created paths. */
  prepare?(ctx: { root: string }): string[];
  wrapPrompt?(prompt: string, ctx: { systemPrompt: string; resume: boolean }): string;
  command(ctx: {
    sessionId: string | null;
    resume: boolean;
    systemPrompt: string;
    settings: Record<string, string>;
    prompt: string;
    root: string;
  }): {
    cmd: string;
    args: string[];
    stdin?: boolean;
    promptInArgs?: boolean;
    env?: Record<string, string>;
    /** Runs after the agent is stopped, e.g. `docker rm -f` of the container. */
    cleanup?: { cmd: string; args: string[] };
  };
  /** `ctx` lives for one run, the adapter can keep state in it. */
  parse(line: any, ctx: { root: string; [key: string]: unknown }): AgentEvent[];
  onExit?(exit: { code: number | null; signal: string | null }, ctx: { root: string; stderr?: string }): AgentEvent[];
  isMissingSession?(stderr: string): boolean;
}

export interface BuiltInAgentOptions {
  /**
   * Where requests go. `kilo` (default): Kilo Gateway's free models, no key.
   * `openrouter`: needs OPENROUTER_API_KEY (or WEBAI_API_KEY) where the dev server runs.
   * `custom`: any OpenAI-compatible endpoint (`baseUrl`), e.g. a local Ollama.
   */
  provider?: 'kilo' | 'openrouter' | 'custom';
  /** A model ID; without it the provider's default, switching to the next free model when busy. */
  model?: string;
  /** For `custom`, e.g. `http://localhost:11434/v1`. */
  baseUrl?: string;
}

export interface WebAiOptions {
  /** How to open the chat on an element. Default `['shift-click']`. */
  triggers?: Trigger[];
  /** Show the floating button. Default `true`. */
  fab?: boolean;
  /**
   * Allow the overlay from other machines too (`--host`). Default `false`:
   * the endpoints accept only loopback and Host `localhost`/`127.0.0.1`.
   * With `true` the command for "Other" can't be changed in the panel.
   */
  allowRemote?: boolean;
  /** Additional adapters besides the built-in ones (claude, codex, gemini, opencode, pi, webai, custom). */
  agents?: AgentAdapter[];
  claude?: ClaudeOptions;
  codex?: CodexOptions;
  gemini?: GeminiOptions;
  opencode?: OpenCodeOptions;
  pi?: PiOptions;
  custom?: CustomOptions;
  /**
   * URL of the bridge on the host (`webai-bridge`) when the dev server runs in a container.
   * Defaults to env `WEBAI_BRIDGE`. Agents then run on the host and agent options
   * come from the bridge config, not from here.
   */
  bridge?: string;
  /** Where to store sessions and history, relative to the project root. Default `.webai`. */
  stateDir?: string;
}

export function claudeAgent(options?: ClaudeOptions): AgentAdapter;
export function codexAgent(options?: CodexOptions): AgentAdapter;
export function geminiAgent(options?: GeminiOptions): AgentAdapter;
export function customAgent(options?: CustomOptions): AgentAdapter;
export function opencodeAgent(options?: OpenCodeOptions): AgentAdapter;
export function piAgent(options?: PiOptions): AgentAdapter;
export function webaiAgent(options?: BuiltInAgentOptions): AgentAdapter;
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error?(message: string): void;
}

export interface CreateWebaiOptions extends WebAiOptions {
  /** The project the agent edits. Default: the current directory. */
  root?: string;
  logger?: Logger;
  /** Reload the page after the agent's changes, for servers without hot reload. Default `false`. */
  reload?: boolean;
  /** Requests come through a reverse proxy on this machine (X-Forwarded-For/-Host). Default `false`. */
  trustProxy?: boolean;
}

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

export interface Webai {
  root: string;
  token: string;
  /** What the overlay's `start()` gets. */
  client: Record<string, unknown>;
  /** The overlay's API and scripts under `/__webai/`. */
  middleware: Middleware;
  /** Adds the overlay's script to every HTML page the next handlers send. */
  injector: Middleware;
  setLogger(logger: Logger): void;
  /** Detects the agents; resolves to a line for the terminal. */
  ready(): Promise<string>;
  dispose(): void;
}

/** webai for any Node dev server, as connect middleware. */
export function createWebai(options?: CreateWebaiOptions): Webai;
/** `<script type="module" src="/__webai/boot.js"></script>` */
export const BOOT_TAG: string;
export const BASE: string;
export const SRC_ATTR: string;
/** Adds `data-webai-src="file:line:col"` to the elements of a static HTML file. */
export function annotateHtml(html: string, file?: string): string;
/** `snippet` before `</body>`. */
export function injectHtml(html: string, snippet: string): string;
export function htmlTransformer(transform: (html: string, req: IncomingMessage) => string): Middleware;
export function loadConfig(root: string, config?: string, logger?: Logger): Promise<WebAiOptions>;
