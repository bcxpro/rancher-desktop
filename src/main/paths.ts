/**
 * This handles migrating from the old path layout to the new one.
 * See https://github.com/rancher-sandbox/rancher-desktop/issues/298
 */

import { execFileSync } from 'child_process';
import { Console } from 'console';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Electron from 'electron';

import Logging from '@/utils/logging';
import paths, { Paths } from '@/utils/paths';

const console = new Console(Logging.background.stream);
const APP_NAME = 'rancher-desktop';

/**
 * DarwinObsoletePaths describes the paths we're migrating from.
 */
class DarwinObsoletePaths implements Paths {
  config = path.join(os.homedir(), 'Library', 'Preferences', APP_NAME);
  electron = path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  logs = path.join(os.homedir(), 'Library', 'State', APP_NAME, 'logs');
  cache = path.join(os.homedir(), 'Library', 'Caches', APP_NAME);
  lima = path.join(os.homedir(), 'Library', 'State', APP_NAME, 'lima');
  hyperkit = path.join(os.homedir(), 'Library', 'State', APP_NAME, 'driver');
  get wslDistro(): string {
    throw new Error('wslDistro not available for darwin');
  }
}

/**
 * Win32ObsoletePaths describes the paths we're migrating from.
 */
class Win32ObsoletePaths implements Paths {
  protected appData = process.env['APPDATA'] || path.join(os.homedir(), 'AppData', 'Roaming');
  protected localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
  get config() {
    return path.join(this.appData, 'xdg.config', APP_NAME);
  }

  get electron() {
    return path.join(this.appData, APP_NAME);
  }

  get logs() {
    return path.join(this.localAppData, 'xdg.state', APP_NAME, 'logs');
  }

  get cache() {
    return path.join(this.localAppData, 'xdg.cache', APP_NAME);
  }

  get wslDistro() {
    return path.join(this.localAppData, 'xdg.state', APP_NAME, 'distro');
  }

  get lima(): string {
    throw new Error('lima not available for win32');
  }

  get hyperkit(): string {
    throw new Error('hyperkit not available for win32');
  }
}
/**
 * Remove the given directory if it is empty, and also any parent directories
 * that become empty.  Any `.DS_Store` files are ignored (and directories that
 * only contain `.DS_Store` are also reomved).
 */
function removeEmptyParents(directory: string) {
  const expectedErrors = ['ENOTEMPTY', 'EACCES', 'EBUSY', 'ENOENT', 'EPERM'];
  const isDarwin = os.platform() === 'darwin';
  const seen = new Set();
  let parent = directory;

  while (!seen.has(parent)) {
    seen.add(parent);
    if (isDarwin) {
      const items = fs.readdirSync(parent);

      if (items.length === 1 && items[0] === '.DS_Store') {
        // on macOS, we _may_ have directories with just .DS_Store
        const DSStorePath = path.join(parent, '.DS_Store');

        try {
          fs.rmSync(DSStorePath);
        } catch (ex) {
          console.error(`Error removing ${ DSStorePath }: ${ ex }`);
          break;
        }
      }
    }
    try {
      fs.rmdirSync(parent);
    } catch (ex) {
      if (expectedErrors.includes(ex.code)) {
        break;
      }
      throw ex;
    }
    parent = path.dirname(parent);
  }
}

/**
 * Recursively remove a directory and its contents.  Also remove any empty
 * parent directories.  If the given path does not exist, no exception is raised.
 * @param target The path to remove.
 */
function recursiveRemoveSync(target: string) {
  try {
    fs.rmSync(target, { recursive: true });
  } catch (ex) {
    if (ex.code === 'ENOENT') {
      return;
    }
    throw ex;
  }
  removeEmptyParents(path.dirname(target));
}

type renameResult = 'succeeded' | 'failed' | 'skipped';

/**
 * Try to rename an old directory name to a new one.  If the move failed,
 * delete the old directory.
 */
function tryRename(oldPath: string, newPath: string, info: string, deleteOnFailure = true): renameResult {
  if (oldPath === newPath) {
    return 'skipped';
  }
  if (newPath.startsWith(oldPath)) {
    // If the old path looks like a prefix of the new path, rename it out of the way first.
    fs.renameSync(oldPath, `${ oldPath }.tmp`);
    oldPath = `${ oldPath }.tmp`;
  }
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  try {
    fs.renameSync(oldPath, newPath);
    console.log(`Migrated ${ info } data from ${ oldPath } to ${ newPath }`);
    try {
      removeEmptyParents(path.dirname(oldPath));
    } catch (ex) {
      console.log(`Failed to remove empty parent directories, ignoring: ${ ex }`);
    }

    return 'succeeded';
  } catch (ex) {
    if (['ENOENT', 'EEXIST'].includes(ex.code)) {
      console.error(`Error moving ${ info }: ${ ex }`);

      return 'failed';
    }
    console.error(`Error moving ${ info }: fatal: ${ ex }`);
    if (deleteOnFailure) {
      recursiveRemoveSync(oldPath);
    }
  }

  return 'failed';
}

/**
 * Migrate the WSL distribution.
 */
function migrateWSLDistro(oldPath: string, newPath: string) {
  if (os.platform() !== 'win32') {
    throw new Error('Unexpectedly migrating WSL on non-Windows!');
  }

  const fd = fs.openSync(Logging.background.path, 'a+');
  const stream = fs.createWriteStream(Logging.background.path, { fd });

  try {
    const regPath = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';
    let stdout = execFileSync(
      'reg.exe',
      ['query', regPath, '/s', '/f', 'rancher-desktop', '/d', '/c', '/e'],
      { stdio: ['ignore', 'pipe', stream], encoding: 'utf-8' });
    const guid = stdout
      .split(/\r?\n/)
      .find(line => line.includes('HKEY_CURRENT_USER'))
      ?.split(/\\/)
      ?.pop()
      ?.trim();

    if (!guid) {
      console.error('Could not find GUID for WSL distribution');

      return;
    }

    stdout = execFileSync(
      'reg.exe',
      ['query', `${ regPath }\\${ guid }`, '/v', 'BasePath', '/t', 'REG_SZ'],
      { stdio: ['ignore', 'pipe', stream], encoding: 'utf-8' });
    const existingPath = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => /^BasePath\s+/.test(line))
      ?.replace(/^BasePath\s+REG_SZ\s+/, '')
      ?.replace(/^\\\\\?\\/, ''); // Strip `\\?\` prefix if needed
    // See https://docs.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation

    if (existingPath !== oldPath) {
      console.log(`Warning: old WSL path ${ existingPath } does not match expected ${ oldPath }`);

      return;
    }

    console.log(`Updating WSL distribution ID ${ guid }`);
    // Move the disks only, as moving the whole directory will fail if the WSL2
    // VM is running.
    execFileSync('wsl.exe', ['--terminate', 'rancher-desktop'],
      { stdio: ['ignore', stream, stream] });
    const result = tryRename(
      path.join(oldPath, 'ext4.vhdx'),
      path.join(newPath, 'ext4.vhdx'),
      'WSL distribution',
      false);

    if (result === 'succeeded') {
      execFileSync(
        'reg.exe',
        ['add', `${ regPath }\\${ guid }`, '/v', 'BasePath', '/t', 'REG_SZ', '/d', newPath, '/f'],
        { stdio: ['ignore', stream, stream] });
    }
  } catch (ex) {
    console.error('Error migrating WSL distribution:', ex);
  }
}

/**
 * Migrate old data.  This must run synchronously to ensure Electron doesn't
 * use any paths before we're done.
 */
function migratePaths() {
  const platform = os.platform();
  let obsoletePaths: Paths;

  switch (platform) {
  case 'darwin':
    obsoletePaths = new DarwinObsoletePaths();
    break;
  case 'win32':
    obsoletePaths = new Win32ObsoletePaths();
    break;
  default:
    console.error(`No paths migration available for platform ${ os.platform() }`);

    return;
  }

  // Move electron data.  This needs to be the first thing, since on Windows
  // the old directory is the container for all other data.  However, we need to
  // do this item-by-item there, as otherwise there's a permission error.
  // It's fine to delete this on failure - we don't have anything useful there.
  if (platform === 'win32') {
    const children = fs.readdirSync(obsoletePaths.electron);

    // Don't do this if we've already migrated.
    if (!children.includes('settings.json')) {
      for (const child of fs.readdirSync(obsoletePaths.electron)) {
        tryRename(
          path.join(obsoletePaths.electron, child),
          path.join(paths.electron, child),
          'Electron');
      }
    }
  } else {
    tryRename(obsoletePaths.electron, paths.electron, 'Electron');
  }

  // Move the settings over
  // Attempting to move the whole directory will cause EPERM on Windows; so we
  // can only move the file itself.
  tryRename(
    path.join(obsoletePaths.config, 'settings.json'),
    path.join(paths.config, 'settings.json'),
    'config');

  // Delete old logs.
  recursiveRemoveSync(obsoletePaths.logs);

  // Move cache.
  tryRename(obsoletePaths.cache, paths.cache, 'cache');

  switch (platform) {
  case 'win32':
    migrateWSLDistro(obsoletePaths.wslDistro, paths.wslDistro);
    break;
  case 'darwin':
    // Delete any hyperkit VMs.
    // eslint-disable-next-line deprecation/deprecation -- needed for migration
    recursiveRemoveSync(obsoletePaths.hyperkit);

    // Move Lima state
    if (tryRename(obsoletePaths.lima, paths.lima, 'Lima state') === 'succeeded') {
      // We also changed the VM name.
      const oldVM = path.join(paths.lima, 'rancher-desktop');
      const newVM = path.join(paths.lima, 'rd');

      tryRename(oldVM, newVM, 'Lima VM');
    }
    break;
  }
}

export default function setupPaths() {
  try {
    migratePaths();
  } catch (ex) {
    console.error(ex);
  }
  Electron.app.setPath('userData', paths.electron);
  Electron.app.setPath('cache', paths.cache);
  Electron.app.setAppLogsPath(paths.logs);
}
