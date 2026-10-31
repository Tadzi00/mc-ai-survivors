import rconPkg from 'rcon-client';
import { log } from '../util/log.js';

const { Rcon } = rconPkg;
type RconConn = InstanceType<typeof Rcon>;

/** Anything that can run a server command and return its text output (mockable in tests). */
export interface CommandRunner {
  send(command: string): Promise<string>;
}

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  timeoutMs: number;
}

/** Lazily-connected, auto-reconnecting RCON client. Commands are serialized (maxPending 1). */
export class RconClient implements CommandRunner {
  private conn: RconConn | undefined;
  private connecting: Promise<RconConn> | undefined;

  constructor(private readonly opts: RconOptions) {}

  private async connection(): Promise<RconConn> {
    if (this.conn?.authenticated) return this.conn;
    if (!this.connecting) {
      // Listeners go on BEFORE connect(): during a server restart Docker's port proxy accepts the TCP
      // connection and then resets it mid-auth; an 'error' with no listener would crash the process.
      const c = new Rcon({
        host: this.opts.host,
        port: this.opts.port,
        password: this.opts.password,
        timeout: this.opts.timeoutMs,
        maxPending: 1,
      });
      c.emitter.setMaxListeners(10);
      c.on('error', (e: unknown) => log('warn', 'rcon', `error: ${String(e)}`));
      c.on('end', () => {
        if (this.conn === c) this.conn = undefined;
      });
      this.connecting = c
        .connect()
        .then(() => {
          this.conn = c;
          return c;
        })
        .finally(() => {
          this.connecting = undefined;
        });
    }
    return this.connecting;
  }

  async send(command: string): Promise<string> {
    // Strip a leading slash: RCON expects bare commands.
    const cmd = command.replace(/^\//, '');
    try {
      const c = await this.connection();
      return await c.send(cmd);
    } catch (e) {
      // One reconnect attempt.
      this.conn = undefined;
      log('debug', 'rcon', `retrying "${cmd}" after ${String(e)}`);
      const c = await this.connection();
      return await c.send(cmd);
    }
  }

  async close(): Promise<void> {
    await this.conn?.end().catch(() => undefined);
    this.conn = undefined;
  }
}
