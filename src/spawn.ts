/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { UserError } from './errors';
import {
  EdgeBrowserFinder,
  ChromeBrowserFinder,
  isQuality,
  Quality,
} from 'vscode-js-debug-browsers';
import { promises as fs } from 'fs';
import execa from 'execa';
import { spawn } from 'child_process';
import * as nls from 'vscode-nls';
import { ILaunchParams } from './extension';
import { join } from 'path';

const localize = nls.loadMessageBundle();

export class BrowserSpawner {
  private readonly finders = {
    edge: new EdgeBrowserFinder(process.env, fs, execa),
    chrome: new ChromeBrowserFinder(process.env, fs, execa),
  };

  constructor(private readonly storagePath: string) {}

  private async findBrowserPath(type: 'edge' | 'chrome', runtimeExecutable: string) {
    if (!isQuality(runtimeExecutable)) {
      return runtimeExecutable;
    }

    if (!this.finders.hasOwnProperty(type)) {
      throw new UserError(`Browser type "${type}" is not supported.`);
    }

    const available = await this.finders[type].findAll();
    const resolved = available.find(r => r.quality === runtimeExecutable)?.path;
    if (!resolved) {
      if (runtimeExecutable === Quality.Stable && !available.length) {
        throw new UserError(
          localize(
            'noBrowserInstallFound',
            'Unable to find a {0} installation on your system. Try installing it, or providing an absolute path to the browser in the "runtimeExecutable" in your launch.json.',
            type,
          ),
        );
      } else {
        throw new UserError(
          localize(
            'browserVersionNotFound',
            'Unable to find {0} version {1}. Available auto-discovered versions are: {2}. You can set the "runtimeExecutable" in your launch.json to one of these, or provide an absolute path to the browser executable.',
            type,
            runtimeExecutable,
            JSON.stringify([...new Set(available)]),
          ),
        );
      }
    }

    return resolved;
  }

  private getUserDataDir(params: ILaunchParams) {
    const requested = params.params.userDataDir;
    if (requested === false) {
      return;
    }

    if (requested === true) {
      return join(
        this.storagePath,
        params.browserArgs?.includes('--headless') ? '.headless-profile' : '.profile',
      );
    }

    return requested;
  }

  /**
   * Launches and returns a child process for the browser specified by the
   * given parameters.
   * @throws UserError if the launch fails
   */
  public async launch(params: ILaunchParams) {
    const binary = await this.findBrowserPath(params.type, params.params.runtimeExecutable);

    const args = params.browserArgs.slice();
    const userDataDir = this.getUserDataDir(params);
    // prepend args to not interfere with any positional arguments (e.g. url to open)
    args.unshift('--remote-debugging-pipe');
    if (userDataDir !== undefined) {
      args.unshift(`--user-data-dir=${userDataDir}`);
    }

    // The cwd defaults to the working directory of the remote extension, but
    // this probably won't exist on the local host. If it doesn't just set it
    // to the process' cwd.
    let cwd = params.params.cwd || params.params.webRoot;
    try {
      if (!cwd || !(await fs.stat(cwd)).isDirectory()) {
        cwd = process.cwd();
      }
    } catch {
      cwd = process.cwd(); // catch ENOENT
    }

    return spawn(binary, args, {
      detached: process.platform !== 'win32',
      env: { ELECTRON_RUN_AS_NODE: undefined, ...params.params.env },
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      cwd,
    });
  }
}
