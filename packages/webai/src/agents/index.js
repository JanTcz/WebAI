import { claudeAgent } from './claude.js';
import { codexAgent } from './codex.js';
import { customAgent } from './custom.js';
import { geminiAgent } from './gemini.js';
import { opencodeAgent } from './opencode.js';
import { piAgent } from './pi.js';
import { webaiAgent } from './webai.js';

export { claudeAgent, codexAgent, customAgent, geminiAgent, opencodeAgent, piAgent, webaiAgent };

/** Built-in agents + custom ones from options, "Other" always last in the menu. */
export function resolveAgents(options = {}) {
  const agents = {
    claude: claudeAgent(options.claude),
    codex: codexAgent(options.codex),
    gemini: geminiAgent(options.gemini),
    opencode: opencodeAgent(options.opencode),
    pi: piAgent(options.pi),
    webai: webaiAgent(options.webai),
  };
  for (const agent of options.agents ?? []) agents[agent.name] = agent;
  agents.custom = customAgent(options.custom);
  for (const [name, agent] of Object.entries(agents)) agent.label ??= name;
  return agents;
}
