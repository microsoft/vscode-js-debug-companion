/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Disposable } from 'vscode';
import { Session } from './session';
import { ILaunchParams } from './extension';
import { BrowserSpawner } from './spawn';
import { Socket } from 'net';
import * as vscode from 'vscode';

export class SessionManager implements Disposable {
  private readonly sessions = new Map<number, Session>();

  constructor(private readonly spawn: BrowserSpawner) {}

  /**
   * Creates a session with the set of launch parameters.
   */
  public async create(params: ILaunchParams) {
    const session = new Session();
    this.sessions.set(params.launchId, session);
    session.onClose(() => this.sessions.delete(params.launchId));
    session.onError(err => {
      vscode.window.showErrorMessage(`Error running browser: ${err.message || err.stack}`);
      this.sessions.delete(params.launchId);
    });

    await Promise.all([
      this.addChildSocket(session, params),
      this.addChildBrowser(session, params),
    ]);
  }

  /**
   * Destroys a session with the given launch ID.
   */
  public destroy(launchId: number) {
    const session = this.sessions.get(launchId);
    session?.dispose();
    this.sessions.delete(launchId);
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    for (const session of this.sessions.values()) {
      session.dispose();
    }

    this.sessions.clear();
  }

  private addChildSocket(session: Session, params: ILaunchParams) {
    const socket = new Socket();
    const [host, port] = params.proxyUri.split(':');
    socket.connect({ port: Number(port), host });
    session.attachSocket(socket);
  }

  private async addChildBrowser(session: Session, params: ILaunchParams) {
    const browser = await this.spawn.launch(params);
    session.attachChild(browser);
  }
}
