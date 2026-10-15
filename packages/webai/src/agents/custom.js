/**
 * "Other": an arbitrary command from the config (`custom.command`), or from the
 * panel with `editable: true`. Runs via /bin/sh in the project
 * root. The prompt goes to stdin, or in place of `{prompt}`. `{session}` is a
 * stable conversation ID (new after "New") so the command can resume.
 * Output is treated as plain text.
 */
export function customAgent(opts = {}) {
  // Off by default: any script on the dev page can read the overlay token, and an
  // editable command would let it run anything on this machine.
  const editable = opts.editable ?? false;
  return {
    name: 'custom',
    label: 'Other',
    bin: null, // nothing to detect
    presetSessionId: true,
    raw: true,

    settings: {
      command: {
        type: 'text',
        label: 'Command',
        placeholder: 'e.g. aider --yes --message {prompt}',
        hint: editable
          ? 'Runs via /bin/sh in the project root. The prompt goes to stdin, or in place of {prompt}; {session} is the conversation ID. Both are substituted already quoted, don\'t wrap them in more quotes.'
          : 'Set in the config (custom.command); custom: { editable: true } allows changing it here.',
        default: opts.command ?? '',
        readonly: !editable,
      },
    },

    command({ sessionId, settings = {}, prompt }) {
      const template = ((editable && settings.command) || opts.command || '').trim();
      if (!template) {
        throw new Error(editable ? 'Enter a command for "Other" in the settings (⚙).' : 'The command for "Other" is not set in the config (custom.command).');
      }
      const usesPrompt = template.includes('{prompt}');
      const line = template
        .replaceAll('{prompt}', shellQuote(prompt))
        .replaceAll('{session}', shellQuote(sessionId));
      // Always POSIX sh: with fish or nushell the template and quotes would mean something else.
      return { cmd: '/bin/sh', args: ['-c', line], stdin: !usesPrompt, promptInArgs: usesPrompt };
    },

    parse(line, ctx) {
      ctx.text = (ctx.text ?? '') + line + '\n';
      return [{ type: 'delta', text: line + '\n', plain: true }];
    },

    onExit({ code, signal }, ctx) {
      const text = ctx.text?.trim();
      return [
        ...(text ? [{ type: 'text', text, plain: true }] : []),
        signal
          ? { type: 'done', ok: false, error: 'Stopped.' }
          : { type: 'done', ok: code === 0, error: code === 0 ? undefined : `Command exited with code ${code}.${ctx.stderr ? `\n${ctx.stderr.trim().slice(-600)}` : ''}` },
      ];
    },
  };
}

function shellQuote(s) {
  return `'${String(s).replaceAll("'", `'\\''`)}'`;
}
