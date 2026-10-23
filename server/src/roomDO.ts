import { DurableObject } from 'cloudflare:workers';
import { parseC2S, type S2C } from '../../src/net/protocol';
import type { Env } from './index';
import { EXPIRE_AFTER, REJECT, RoomLogic, type Out, type RoomState } from './room';

const MAX_MESSAGE = 16 * 1024;
const cryptoRand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

interface Attachment {
  seat: number | null;
}

/** One room: a Durable Object holding a RoomLogic, its sockets hibernating between messages. */
export class Room extends DurableObject<Env> {
  private room: RoomLogic | null = null;
  private inited = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.inited = !!(await ctx.storage.get('init'));
      const state = await ctx.storage.get<RoomState>('room');
      if (state) this.room = new RoomLogic(state.code, state, cryptoRand);
    });
  }

  private logic(): RoomLogic {
    if (!this.room) this.room = new RoomLogic('', undefined, cryptoRand);
    return this.room;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/init') {
      if (this.inited) return new Response('in use', { status: 409 });
      this.inited = true;
      this.room = new RoomLogic(url.searchParams.get('code') ?? '', undefined, cryptoRand);
      this.room.state.lastActivity = Date.now();
      await this.ctx.storage.put({ init: true, room: this.room.state });
      await this.ctx.storage.setAlarm(Date.now() + EXPIRE_AFTER);
      return new Response('created', { status: 201 });
    }
    if (url.pathname === '/info') {
      if (!this.inited) return new Response(JSON.stringify({ exists: false }), { status: 404 });
      const r = this.logic();
      return new Response(JSON.stringify({ exists: true, ...r.joinInfo() }));
    }
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (!this.inited) return new Response('no such room', { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ seat: null } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private seatOf(ws: WebSocket): number | null {
    return (ws.deserializeAttachment() as Attachment | null)?.seat ?? null;
  }

  private send(ws: WebSocket, msg: S2C): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* closed */
    }
  }

  private route(outs: Out[], current?: WebSocket): void {
    if (!outs.length) return;
    const socks = this.ctx.getWebSockets().map((ws) => ({ ws, seat: this.seatOf(ws) }));
    for (const o of outs) {
      if (o.to === REJECT) {
        if (current) this.send(current, o.msg);
        continue;
      }
      for (const { ws, seat } of socks) {
        if (seat === null) continue;
        if (o.to === 'all' || (o.to === 'others' ? seat !== o.from : seat === o.to)) this.send(ws, o.msg);
      }
    }
  }

  private async persist(now: number): Promise<void> {
    await this.ctx.storage.put('room', this.logic().state);
    const wake = this.logic().nextWake(now);
    if (wake === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(wake, now + 1));
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string') return;
    if (data.length > MAX_MESSAGE) {
      ws.close(1009, 'too big');
      return;
    }
    const msg = parseC2S(data);
    if (!msg) {
      this.send(ws, { t: 'error', code: 'bad' });
      return;
    }
    const now = Date.now();
    const logic = this.logic();
    const seat = this.seatOf(ws);
    if (seat === null) {
      if (msg.t !== 'hello') {
        this.send(ws, { t: 'error', code: 'bad' });
        return;
      }
      const r = logic.join(msg, now);
      if (r.seat === null) {
        this.route(r.out, ws);
        ws.close(4000, 'rejected');
        return;
      }
      // A seat reclaimed by a new socket: the old socket loses it (detached first so its close
      // does not drop the seat).
      for (const old of this.ctx.getWebSockets()) {
        if (old !== ws && this.seatOf(old) === r.seat) {
          old.serializeAttachment({ seat: null } satisfies Attachment);
          try {
            old.close(4001, 'replaced');
          } catch {
            /* closed */
          }
        }
      }
      ws.serializeAttachment({ seat: r.seat } satisfies Attachment);
      this.route(r.out, ws);
      await this.persist(now);
      return;
    }
    const outs = logic.handle(seat, msg, now);
    this.route(outs, ws);
    if (msg.t !== 'st' && msg.t !== 'bump' && msg.t !== 'ping') await this.persist(now);
  }

  private async dropSocket(ws: WebSocket): Promise<void> {
    const seat = this.seatOf(ws);
    if (seat === null) return;
    ws.serializeAttachment({ seat: null } satisfies Attachment);
    const now = Date.now();
    this.route(this.logic().drop(seat, now));
    await this.persist(now);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
    await this.dropSocket(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.dropSocket(ws);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const logic = this.logic();
    this.route(logic.tick(now));
    if (logic.expired(now)) {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1001, 'expired');
        } catch {
          /* closed */
        }
      }
      await this.ctx.storage.deleteAll();
      this.room = null;
      this.inited = false;
    } else {
      await this.persist(now);
    }
  }
}
