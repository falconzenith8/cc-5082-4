import { createServer } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MatchRoom, TEAMS } from './engine.js';
import { CHARACTER_POOL, MUTEXES, generateRoster } from '../shared/characters.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const SHARED_DIR = join(ROOT, 'shared');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function createApp({ log = console.log, roster = null } = {}) {
  const matches = new Map();
  const connections = new Map(); // matchId -> Set(ws)
  // 默认角色池来自固定种子；指定其他种子时按种子重建（含互斥关系）。
  const rosterCache = new Map();
  const defaultRoster = roster || { characters: CHARACTER_POOL, mutexes: MUTEXES, seed: 'default' };
  function rosterFor(seed) {
    if (!seed) return defaultRoster;
    if (!rosterCache.has(seed)) rosterCache.set(seed, generateRoster(seed));
    return rosterCache.get(seed);
  }

  function createMatch({ rules = {}, meta = {}, chars, mutexes, rosterSeed } = {}) {
    const id = `m-${randomUUID().slice(0, 8)}`;
    const seats = {};
    for (const team of TEAMS) {
      seats[team] = [0, 1].map((seat) => ({
        seat,
        name: `${team === 'A' ? '苍隼' : '赤隼'}·${seat === 0 ? '指挥' : '副手'}`,
        token: randomUUID(),
      }));
    }
    const built = chars ? { characters: chars, mutexes: mutexes || [], seed: 'custom' } : rosterFor(rosterSeed);
    const room = new MatchRoom({
      id, rules, meta, seats,
      pool: built.characters,
      mutexes: built.mutexes,
    });
    room.rosterSeed = built.seed;
    matches.set(id, room);
    room.on('update', () => broadcast(id));
    return room;
  }

  function broadcast(id) {
    const room = matches.get(id);
    const sockets = connections.get(id);
    if (!room || !sockets) return;
    for (const ws of sockets) {
      if (ws.readyState !== 1) continue;
      sendView(ws, room);
    }
  }

  function sendView(ws, room, query = {}) {
    const now = Date.now();
    const role = ws.role || { kind: 'spectator' };
    let view;
    if (role.kind === 'seat') {
      view = room.teamView(role.team, role.seat, now);
      view.you = { team: role.team, seat: role.seat, token: ws.seatToken };
    } else {
      view = room.publicView(now);
    }
    view.protocol = {
      intent: 'seat-intent',
      serverClock: now,
      tokenRequired: true,
      awayGraceMs: room.rules.timers.awayGraceMs,
    };
    view.pool = room.availableCharacters();
    if (role.kind === 'seat') {
      view.joinLinks = joinLinks(room);
    }
    send(ws, { type: 'view', view });
  }

  function joinLinks(room) {
    const links = {};
    for (const team of TEAMS) {
      links[team] = room.seats[team].map((seat) => ({
        seat: seat.seat,
        name: seat.name,
        path: `/table/${room.id}?token=${seat.token}`,
      }));
    }
    links.spectate = `/spectate/${room.id}`;
    links.scene = `/scene/${room.id}`;
    return links;
  }

  function send(ws, payload) {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  }

  function attachSeat(room, token) {
    const found = room.seatForToken(token);
    return found;
  }

  function handleIntent(ws, room, message) {
    const seat = ws.role;
    if (!seat || seat.kind !== 'seat') {
      send(ws, { type: 'rejected', intentId: message.intentId, code: 'not-a-seat', message: '旁观者不能提交意图' });
      return;
    }
    if (!message.intentId) {
      send(ws, { type: 'rejected', intentId: null, code: 'missing-intent-id', message: '意图必须带幂等 ID' });
      return;
    }
    const base = {
      team: seat.team,
      seatIndex: seat.seat,
      intentId: message.intentId,
      roundId: message.roundId,
      receivedAt: Date.now(),
    };
    let result;
    if (message.type === 'intent.ban') {
      result = room.submitBan({ ...base, turnId: message.turnId, characterId: message.characterId });
    } else if (message.type === 'intent.secret') {
      result = room.submitSecret({
        ...base,
        windowId: message.windowId,
        slotId: message.slotId,
        characterId: message.characterId,
      });
    } else {
      send(ws, {
        type: 'rejected',
        intentId: message.intentId,
        code: 'unknown-intent',
        message: '未知意图类型',
      });
      return;
    }
    send(ws, {
      type: 'intent.result',
      intentId: message.intentId,
      ok: result.ok,
      code: result.code || null,
      message: result.message || null,
      detail: result.ok ? {
        action: result.action,
        slotId: result.slotId || null,
        characterId: result.characterId || null,
        revision: Boolean(result.revision),
        conflict: result.conflict || null,
      } : null,
    });
    broadcast(room.id);
  }

  function handlePresence(ws, room, message) {
    const seat = ws.role;
    if (!seat || seat.kind !== 'seat') return;
    room.setPresence(seat.team, seat.seat, Boolean(message.connected), Date.now());
  }

  // ---- HTTP ----

  async function serveStatic(req, res, pathname) {
    try {
      const safe = normalizePath(pathname);
      if (!safe) return false;
      const full = safe;
      const fileStat = await stat(full).catch(() => null);
      if (!fileStat || !fileStat.isFile()) return false;
      const ext = extname(full);
      const body = await readFile(full);
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  }

  function normalizePath(pathname) {
    const raw = pathname.split('?')[0];
    if (raw.startsWith('/shared/')) {
      const rel = raw.slice('/shared/'.length);
      if (rel.includes('..')) return null;
      return join(SHARED_DIR, rel);
    }
    if (raw === '/' || raw.startsWith('/table/') || raw.startsWith('/spectate/') || raw.startsWith('/scene/')) {
      return join(PUBLIC_DIR, 'index.html');
    }
    const rel = raw.replace(/^\/+/, '');
    if (rel.includes('..')) return null;
    const full = join(PUBLIC_DIR, rel);
    if (!full.startsWith(PUBLIC_DIR + sep)) return null;
    return full;
  }

  function json(res, status, payload) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  }

  async function readBody(req) {
    let data = '';
    for await (const chunk of req) {
      data += chunk;
      if (data.length > 1e6) throw new Error('body too large');
    }
    return data ? JSON.parse(data) : {};
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    try {
      if (pathname === '/api/matches' && req.method === 'GET') {
        const list = [...matches.values()].map((room) => ({
          matchId: room.id,
          phase: room.state.phase,
          createdAt: room.state.createdAt,
          joinLinks: joinLinks(room),
        }));
        return json(res, 200, { matches: list });
      }
      if (pathname === '/api/matches' && req.method === 'POST') {
        const body = await readBody(req);
        const room = createMatch({
          rules: body.rules || {},
          meta: body.meta || {},
          rosterSeed: body.rosterSeed || null,
        });
        return json(res, 201, {
          matchId: room.id,
          joinLinks: joinLinks(room),
          tokens: {
            A: room.seats.A.map((seat) => seat.token),
            B: room.seats.B.map((seat) => seat.token),
          },
        });
      }
      const sceneMatch = pathname.match(/^\/api\/matches\/([^/]+)\/scene$/);
      if (sceneMatch && req.method === 'GET') {
        const room = matches.get(sceneMatch[1]);
        if (!room) return json(res, 404, { error: 'match-not-found' });
        if (room.state.phase !== 'revealed') {
          return json(res, 409, { error: 'match-not-revealed', phase: room.state.phase });
        }
        return json(res, 200, room.state.scene);
      }
      const stateMatch = pathname.match(/^\/api\/matches\/([^/]+)$/);
      if (stateMatch && req.method === 'GET') {
        const room = matches.get(stateMatch[1]);
        if (!room) return json(res, 404, { error: 'match-not-found' });
        return json(res, 200, room.publicView(Date.now()));
      }

      if (pathname === '/healthz') return json(res, 200, { ok: true });

      if (await serveStatic(req, res, pathname)) return;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (error) {
      log('[http]', error);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal', message: error.message }));
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    ws.role = { kind: 'spectator' };
    ws.matchId = null;
    ws.seatToken = null;

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: 'error', code: 'bad-json' });
      }
      if (message.type === 'hello') {
        const room = matches.get(message.matchId);
        if (!room) return send(ws, { type: 'error', code: 'match-not-found' });
        if (ws.matchId && ws.matchId !== message.matchId) detach(ws);
        ws.matchId = message.matchId;
        const seat = message.token ? attachSeat(room, message.token) : null;
        if (seat) {
          ws.role = { kind: 'seat', team: seat.team, seat: seat.seat };
          ws.seatToken = message.token;
          room.setPresence(seat.team, seat.seat, true, Date.now());
        } else {
          ws.role = { kind: 'spectator' };
        }
        if (!connections.has(message.matchId)) connections.set(message.matchId, new Set());
        connections.get(message.matchId).add(ws);
        send(ws, { type: 'hello.ok', role: ws.role, matchId: message.matchId });
        sendView(ws, room);
        return;
      }
      const room = matches.get(ws.matchId);
      if (!room) return send(ws, { type: 'error', code: 'not-joined' });
      if (message.type === 'intent.ban' || message.type === 'intent.secret') {
        handleIntent(ws, room, message);
        return;
      }
      if (message.type === 'presence') {
        handlePresence(ws, room, message);
        return;
      }
      if (message.type === 'view.request') {
        sendView(ws, room);
        return;
      }
      if (message.type === 'round.next') {
        const seat = ws.role;
        if (!seat || seat.kind !== 'seat') {
          return send(ws, { type: 'rejected', code: 'not-a-seat', message: '只有座位可以发起下一轮' });
        }
        const result = room.nextRound(Date.now());
        if (!result.ok) {
          return send(ws, { type: 'rejected', code: result.code, message: result.message });
        }
        broadcast(room.id);
        return;
      }
      send(ws, { type: 'error', code: 'unknown-message' });
    });

    ws.on('close', () => {
      if (ws.matchId) detach(ws);
    });
  });

  function detach(ws) {
    const room = matches.get(ws.matchId);
    const set = connections.get(ws.matchId);
    if (set) {
      set.delete(ws);
      if (!set.size) connections.delete(ws.matchId);
    }
    const seat = ws.role;
    if (room && seat && seat.kind === 'seat') {
      const othersStill = [...(connections.get(ws.matchId) || [])]
        .some((other) => other !== ws && other.role?.kind === 'seat' && other.role.team === seat.team && other.role.seat === seat.seat);
      if (!othersStill) room.setPresence(seat.team, seat.seat, false, Date.now());
    }
    ws.matchId = null;
    ws.role = { kind: 'spectator' };
  }

  const ticker = setInterval(() => {
    const now = Date.now();
    for (const room of matches.values()) {
      if (room.state.phase === 'ban' || room.state.phase === 'secret') room.tick(now);
    }
  }, 200);
  ticker.unref?.();

  return {
    server,
    wss,
    matches,
    createMatch,
    close: () => new Promise((resolveClose) => {
      clearInterval(ticker);
      for (const set of connections.values()) {
        for (const ws of set) ws.terminate();
      }
      wss.close(() => server.close(() => resolveClose()));
    }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 4317);
  const app = createApp();
  app.server.listen(port, () => {
    console.log(`arena-draft listening on http://localhost:${port}`);
    const room = app.createMatch({
      meta: { label: '演示对局' },
      rules: {
        timers: {
          banMs: Number(process.env.BAN_MS || 30000),
          secretMs: Number(process.env.SECRET_MS || 45000),
          awayGraceMs: Number(process.env.AWAY_GRACE_MS || 8000),
        },
        factionCap: 2,
        minFactions: 2,
        banTurnsPerTeam: 2,
      },
    });
    console.log(`demo match ${room.id}`);
    console.log(`spectate: http://localhost:${port}/spectate/${room.id}`);
    console.log(`team A:   http://localhost:${port}/table/${room.id}?token=${room.seats.A[0].token}`);
    console.log(`team B:   http://localhost:${port}/table/${room.id}?token=${room.seats.B[0].token}`);
  });
  const shutdown = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
