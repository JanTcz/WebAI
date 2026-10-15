import { randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * Agent in a container: each message = `docker compose run --rm <service> <cli> …`.
 * The container exits with the process; state (sessions) lives in the service's volumes.
 *
 * @param {{ service: string, workdir: string }} docker compose service and the project root inside it
 */
export function inDocker(docker) {
  return {
    /**
     * Command for `spawn`: `docker` and its arguments, including `-e KEY=…` variables.
     * The container gets its own name: killing the `docker compose run` client
     * does not stop it, so Stop removes it via `cleanup` (`docker rm -f`).
     */
    command(bin, args, env = {}) {
      const name = `webai-${docker.service}-${randomBytes(4).toString('hex')}`;
      const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      return {
        cmd: 'docker',
        args: ['compose', 'run', '--rm', '-T', '--no-deps', '--name', name, ...envArgs, docker.service, bin, ...args],
        cleanup: { cmd: 'docker', args: ['rm', '-f', name] },
      };
    },
    /** Host path (inside the project or repo) → path in the container. */
    path(hostPath, root) {
      return path.posix.join(docker.workdir, path.relative(root, hostPath).split(path.sep).join('/'));
    },
  };
}

/** Stderr without `docker compose` messages about containers and volumes. */
export function cleanStderr(stderr = '') {
  return stderr
    .split('\n')
    .filter((l) => !/^\s*(Container|Volume|Network) \S+ (Creating|Created|Starting|Started|Removing|Removed)\s*$/.test(l))
    .join('\n')
    .trim();
}

/** Shortens an absolute path from an agent tool to one relative to the project root. */
export function relPath(file, base) {
  if (typeof file !== 'string') return '';
  return path.posix.isAbsolute(file) ? path.posix.relative(base, file) || file : file;
}
