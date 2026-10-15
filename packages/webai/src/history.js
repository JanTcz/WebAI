import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_VERSIONS = 200;

/**
 * Versions of the project's files, one per agent answer (and one for your own
 * edits in between), to step back and forward through. Kept in a git repository
 * of its own (`.webai/history.git`, its own index), so the project's repository,
 * its index and its history are never touched. The project's .gitignore applies;
 * `.webai/`, `node_modules/`, `dist/` and `.astro/` are always left out.
 *
 * Going back and then letting the agent change something drops the versions after
 * it, as in an editor's undo; your own edits are never dropped.
 */
export class History {
  constructor(root, stateDir) {
    this.root = root;
    this.dir = path.join(stateDir, 'history.git');
    this.file = path.join(stateDir, 'history.json');
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.state = { versions: [], current: -1 };
    }
    this.enabled = true;
    try {
      if (!fs.existsSync(path.join(this.dir, 'HEAD'))) {
        fs.mkdirSync(this.dir, { recursive: true });
        execFileSync('git', ['init', '--quiet'], { cwd: this.root, stdio: 'ignore', env: { ...process.env, GIT_DIR: this.dir } });
      }
      fs.mkdirSync(path.join(this.dir, 'info'), { recursive: true });
      fs.writeFileSync(path.join(this.dir, 'info', 'exclude'), '.webai/\nnode_modules/\ndist/\n.astro/\n');
    } catch {
      this.enabled = false; // no git: no history, everything else works
    }
  }

  git(args) {
    return execFileSync('git', args, {
      cwd: this.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_DIR: this.dir,
        GIT_WORK_TREE: this.root,
        GIT_INDEX_FILE: path.join(this.dir, 'webai-index'),
        GIT_AUTHOR_NAME: 'webai',
        GIT_AUTHOR_EMAIL: 'webai@localhost',
        GIT_COMMITTER_NAME: 'webai',
        GIT_COMMITTER_EMAIL: 'webai@localhost',
      },
    }).trim();
  }

  /** The tree of the files as they are now. */
  tree() {
    this.git(['add', '-A', '--', '.']);
    return this.git(['write-tree']);
  }

  /**
   * A new version when the files differ from the current one; null when they don't.
   * `keep`: append after the last version instead of dropping the ones after the current.
   */
  snapshot(label, { keep = false } = {}) {
    if (!this.enabled) return null;
    const tree = this.tree();
    const current = this.state.versions[this.state.current];
    if (current?.tree === tree) return null;
    const sha = this.git(['commit-tree', tree, ...(current ? ['-p', current.sha] : []), '-m', label || 'version']);
    const kept = keep ? this.state.versions : this.state.versions.slice(0, this.state.current + 1);
    const versions = [...kept, { sha, tree, label: String(label).slice(0, 200), ts: Date.now() }].slice(-MAX_VERSIONS);
    // A ref per version keeps its objects from git's garbage collection.
    this.git(['update-ref', `refs/webai/${versions.length - 1}`, sha]);
    this.state = { versions, current: versions.length - 1 };
    this.save();
    return this.list();
  }

  /** The files as they were in version `index`; your edits since the current version are kept as a version first. */
  restore(index) {
    if (!this.enabled) throw new Error('No version history: git is not available.');
    const target = this.state.versions[index];
    if (!target) throw new Error(`No version ${index}.`);
    const before = this.state.current;
    // Edits since the current version are kept as a version of their own at the end.
    if (this.state.versions[before]?.tree !== this.tree()) this.snapshot('Your edits', { keep: true });
    this.git(['read-tree', '-u', '--reset', target.tree]);
    this.state.current = index;
    this.save();
    return this.list();
  }

  list() {
    return {
      enabled: this.enabled,
      current: this.state.current,
      versions: this.state.versions.map(({ label, ts }, i) => ({ index: i, label, ts })),
    };
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.state));
  }
}
