# Agents and skills for webai

A single source for all CLIs. Skills use the Agent Skills standard
(`skills/<name>/SKILL.md` with `name` and `description` frontmatter); subagents
are Markdown files with frontmatter (`agents/<name>.md`).

| CLI | How it picks them up |
|---|---|
| Claude Code | `--plugin-dir` pointing at this folder, names `webai:<skill>` |
| Codex | symlinks in `<project>/.agents/skills/`, subagents generated into `.codex/agents/*.toml` |
| Gemini CLI | symlinks in `<project>/.agents/skills/` and `<project>/.gemini/agents/` |

The overlay creates the symlinks the first time a given agent is used and never
overwrites an existing file of the same name.

Subagents have no `tools` field: tool names differ between CLIs, so the
read-only restriction lives in the instruction text.
