/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Disposable, EventEmitter } from 'vscode';
import { ChildProcess } from 'child_process';
import { Socket } from 'net';
import { Writable, Readable } from 'stream';

/**
 * The Session manages the lifecycle for a single top-level browser debug sesssion.
 */
export class Session implements Disposable {
  private readonly errorEmitter = new EventEmitter<Error>();
  public readonly onError = this.errorEmitter.event;

  private readonly closeEmitter = new EventEmitter<void>();
  public readonly onClose = this.closeEmitter.event;

  private disposed = false;
  private browserProcess?: ChildProcess;
  private socket?: Socket;

  constructor() {
    this.onClose(() => this.dispose());
    this.onError(() => this.dispose());
  }

  /**
   * Attaches the socket looping back up to js-debug.
   */
  public attachSocket(socket: Socket) {
    if (this.disposed) {
      socket.destroy();
      return;
    }

    this.socket = socket;
    socket.on('close', () => this.closeEmitter.fire());
    socket.on('error', err => this.errorEmitter.fire(err));

    this.tryActivate();
  }

  /**
   * Attaches the browser child process.
   */
  public attachChild(child: ChildProcess) {
    if (this.disposed) {
      child.kill();
      return;
    }

    this.browserProcess = child;
    child.on('close', () => this.closeEmitter.fire());
    child.on('error', err => this.errorEmitter.fire(err));

    this.tryActivate();
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    if (!this.disposed) {
      this.socket?.destroy();
      this.browserProcess?.kill();
      this.disposed = true;
    }
  }

  private tryActivate() {
    if (!this.browserProcess || !this.socket) {
      return;
    }

    const cpIn = this.browserProcess.stdio[3] as Writable;
    const cpOut = this.browserProcess.stdio[4] as Readable;

    cpOut.pipe(this.socket);
    this.socket.pipe(cpIn);
  }
}
