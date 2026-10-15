/** Supported CLIs. Status matches the "Adapter status" table in the README. */
export const agents = [
  { name: 'Claude Code', command: 'claude -p', note: 'verified: edits, resuming the conversation, switching models, skills' },
  { name: 'Codex', command: 'codex exec', note: 'per the docs, not yet verified live' },
  { name: 'Gemini CLI', command: 'gemini -p', note: 'per the docs, not yet verified live' },
  { name: 'Other', command: 'your own command', note: 'prompt on stdin or in {prompt}, output is the reply' },
] as const;
