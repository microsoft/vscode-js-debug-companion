/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { SessionManager } from './sessionManager';
import { BrowserSpawner } from './spawn';
import { tmpdir } from 'os';

export interface ILaunchParams {
  type: 'chrome' | 'edge';
  path: string;
  proxyUri: string;
  launchId: number;
  browserArgs: string[];
  attach?: {
    host: string;
    port: number;
  };
  // See IChromiumLaunchConfiguration in js-debug for the full type, a subset of props are here:
  params: {
    env: Readonly<{ [key: string]: string | null }>;
    runtimeExecutable: string;
    userDataDir: boolean | string;
    cwd: string | null;
    webRoot: string | null;
  };
}

let manager: SessionManager | undefined;

export function activate(context: vscode.ExtensionContext) {
  manager = new SessionManager(new BrowserSpawner(context.storagePath ?? tmpdir()));

  context.subscriptions.push(
    vscode.commands.registerCommand('js-debug-companion.launchAndAttach', params => {
      manager?.create(params).catch(err => vscode.window.showErrorMessage(err.message));
    }),
    vscode.commands.registerCommand('js-debug-companion.kill', ({ launchId }) => {
      manager?.destroy(launchId);
    }),
  );
}

export function deactivate() {
  manager?.dispose();
  manager = undefined;
}
