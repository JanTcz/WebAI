import { withWebai } from '@jantcz/webai/next';

// webai runs only in `next dev`: the overlay's API beside Next.js, reached through a rewrite.
export default withWebai({
  // No generated AGENTS.md in the example.
  agentRules: false,
  // Only for this repository: @jantcz/webai is linked from ../../packages, outside the project.
  turbopack: { root: new URL('../..', import.meta.url).pathname },
});
