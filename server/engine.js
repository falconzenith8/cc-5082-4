import { EventEmitter } from 'node:events';
import {
  CHARACTER_POOL,
  TEAM_META,
  FACTIONS,
  ROLES,
  characterById,
  getPool,
} from '../shared/characters.js';
import {
  SLOT_DEFINITIONS,
  banTurns,
  normalizeRules,
  canComplete,
  countFactionsFromIds,
  defaultBanOrder,
  defaultCandidateOrder,
  fitScore,
  slotAccepts,
  validateFinalRosters,
} from '../shared/rules.js';
import { createMatchScene } from '../shared/scene.js';

export const TEAMS = ['A', 'B'];

const fail = (code, message) => ({ ok: false, code, message });
const pass = (extra = {}) => ({ ok: true, ...extra });

function emptySeats() {
  return { 0: {}, 1: {} };
}

function emptyTeamSecret() {
  return { seats: emptySeats(), conflicts: [], revisions: [] };
}

export class MatchRoom extends EventEmitter {
  constructor({ id, rules = {}, pool = CHARACTER_POOL, clock = Date.now, meta = {}, seats } = {}) {
    super();
    this.id = id;
    this.rules = normalizeRules(rules);
    this.pool = getPool(pool);
    this.clock = clock;
    this.meta = meta;
    this.seats = seats || {
      A: [{ seat: 0, name: '指挥席', token: `A0:${id}` }, { seat: 1, name: '副手席', token: `A1:${id}` }],
      B: [{ seat: 0, name: '指挥席', token: `B0:${id}` }, { seat: 1, name: '副手席', token: `B1:${id}` }],
    };
    this.presence = {
      A: this.seats.A.map(() => true),
      B: this.seats.B.map(() => true),
    };
    this.seenIntents = new Set();
    this.state = {
      id,
      roundId: 1,
      phase: 'ban',
      initiative: 'A',
      createdAt: this.clock(),
      revealedAt: null,
      banSequence: banTurns(this.rules),
      banTurnIndex: 0,
      banDeadline: null,
      bans: [],
      secret: null,
      reveal: null,
      failure: null,
      scene: null,
      awaySince: { A: null, B: null },
      allAwaySince: null,
    };
    if (this.state.banSequence.length === 0) {
      this.openSecretWindow(this.clock());
    } else {
      this.state.banDeadline = this.clock() + this.rules.timers.banMs;
    }
  }

  // ---------- identity ----------

  seatForToken(token) {
    if (!token) return null;
    for (const team of TEAMS) {
      for (const seat of this.seats[team]) {
        if (seat.token === token) return { team, seat: seat.seat, name: seat.name };
      }
    }
    return null;
  }

  // ---------- presence & timing ----------

  setPresence(team, seatIndex, connected, at = this.clock()) {
    if (!TEAMS.includes(team) || !this.presence[team] || this.presence[team][seatIndex] === undefined) return;
    this.presence[team][seatIndex] = Boolean(connected);
    const teamAway = this.presence[team].every((v) => !v);
    this.state.awaySince[team] = teamAway ? (this.state.awaySince[team] ?? at) : null;
    const allAway = TEAMS.every((t) => this.presence[t].every((v) => !v));
    this.state.allAwaySince = allAway ? (this.state.allAwaySince ?? at) : null;
    this.tick(at);
    this.emit('update', { reason: 'presence' });
  }

  effectiveBanDeadline() {
    if (this.state.phase !== 'ban') return null;
    const team = this.state.banSequence[this.state.banTurnIndex];
    const awaySince = this.state.awaySince[team];
    const base = this.state.banDeadline;
    return awaySince == null ? base : Math.min(base, awaySince + this.rules.timers.awayGraceMs);
  }

  effectiveSecretDeadline() {
    if (this.state.phase !== 'secret') return null;
    const base = this.state.secret.deadline;
    return this.state.allAwaySince == null
      ? base
      : Math.min(base, this.state.allAwaySince + this.rules.timers.awayGraceMs);
  }

  tick(now = this.clock()) {
    for (let guard = 0; guard < 128; guard += 1) {
      if (this.state.phase === 'ban') {
        const deadline = this.effectiveBanDeadline();
        if (now >= deadline) {
          const ahead = this.state.awaySince[this.state.banSequence[this.state.banTurnIndex]];
          const reason = ahead != null && now >= ahead + this.rules.timers.awayGraceMs ? 'away' : 'deadline';
          this.autoBan(now, reason);
          continue;
        }
        return;
      }
      if (this.state.phase === 'secret') {
        const deadline = this.effectiveSecretDeadline();
        if (now >= deadline) {
          const allAwayExpired = this.state.allAwaySince != null
            && now >= this.state.allAwaySince + this.rules.timers.awayGraceMs;
          this.adjudicate(now, allAwayExpired ? 'both-teams-away' : 'deadline');
          continue;
        }
      }
      return;
    }
  }

  // ---------- phase transitions ----------

  openSecretWindow(now) {    this.state.phase = 'secret';
    this.state.banDeadline = null;
    this.state.secret = {
      windowId: `r${this.state.roundId}-secret`,
      deadline: now + this.rules.timers.secretMs,
      teams: { A: emptyTeamSecret(), B: emptyTeamSecret() },
    };
  }

  advanceBan(now) {
    this.state.banTurnIndex += 1;
    if (this.state.banTurnIndex >= this.state.banSequence.length) {
      this.openSecretWindow(now);
    } else {
      this.state.banDeadline = now + this.rules.timers.banMs;
    }
  }

  autoBan(now, reason) {
    const team = this.state.banSequence[this.state.banTurnIndex];
    const turnId = `r${this.state.roundId}-ban${this.state.banTurnIndex}`;
    const bannedSet = new Set(this.state.bans.map((entry) => entry.characterId));
    const characterId = this.chooseAutoBan(bannedSet);
    this.state.bans.push({
      team, characterId, auto: true, reason, at: now, turnId, roundId: this.state.roundId,
    });
    this.advanceBan(now);
    this.emit('update', { reason: `auto-ban:${reason}` });
  }

  // 默认禁用同样要服从联合约束：逐个试探威胁顺序，只禁掉不会让两队失去互斥阵容的角色。
  chooseAutoBan(bannedSet) {
    const order = defaultBanOrder({ pool: this.pool, banned: bannedSet });
    for (const characterId of order) {
      const trial = new Set(bannedSet);
      trial.add(characterId);
      if (this.hasDisjointLineups(trial)) return characterId;
    }
    return order[0] || null;
  }

  hasDisjointLineups(bannedSet) {
    const lineups = this.enumerateLineups(bannedSet);
    const ids = lineups.map((roster) => new Set(roster.map((entry) => entry.characterId)));
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        let disjoint = true;
        for (const id of ids[i]) {
          if (ids[j].has(id)) { disjoint = false; break; }
        }
        if (disjoint) return true;
      }
    }
    return false;
  }

  // 仅在上一轮已裁决后可用；递增 roundId 使旧轮意图天然失效。
  nextRound(now = this.clock()) {
    if (this.state.phase !== 'revealed' && this.state.phase !== 'failed') {
      return fail('phase-open', '当前轮尚未结束');
    }
    this.state.roundId += 1;
    this.state.phase = 'ban';
    this.state.initiative = this.state.initiative === 'A' ? 'B' : 'A';
    this.state.banSequence = banTurns(this.rules);
    this.state.banTurnIndex = 0;
    this.state.bans = [];
    this.state.secret = null;
    this.state.reveal = null;
    this.state.failure = null;
    this.state.scene = null;
    this.state.revealedAt = null;
    this.state.banDeadline = now + this.rules.timers.banMs;
    this.state.awaySince = { A: null, B: null };
    this.state.allAwaySince = null;
    this.seenIntents.clear();
    this.emit('update', { reason: 'next-round' });
    return pass({ roundId: this.state.roundId });
  }

  // ---------- ban intents ----------

  submitBan({ team, seatIndex, intentId, roundId, turnId, characterId, receivedAt = this.clock() }) {
    const at = receivedAt;
    this.tick(at);
    if (this.state.phase !== 'ban') return fail('phase-closed', '禁用阶段已结束，意图未被采用');
    if (roundId !== this.state.roundId) {
      return fail('stale-round', `轮次 ${roundId} 已过期，当前为第 ${this.state.roundId} 轮`);
    }
    const expectedTurnId = `r${this.state.roundId}-ban${this.state.banTurnIndex}`;
    if (turnId !== expectedTurnId) return fail('stale-turn', `禁用回合 ${turnId} 不在当前截止窗口`);
    const activeTeam = this.state.banSequence[this.state.banTurnIndex];
    if (team !== activeTeam) return fail('not-your-turn', '当前不是本队的禁用回合');
    if (!this.presence[team] || this.presence[team][seatIndex] === false) {
      return fail('seat-away', '座位处于暂离状态，意图未被采用');
    }
    if (this.seenIntents.has(intentId)) return fail('duplicate-intent', '重复的意图 ID 已被忽略');
    const character = this.pool.get(characterId);
    if (!character) return fail('unknown-candidate', '角色不在角色池中');
    if (this.state.bans.some((entry) => entry.characterId === characterId)) {
      return fail('candidate-banned', '该角色已被禁用');
    }

    this.seenIntents.add(intentId);
    this.state.bans.push({
      team, characterId, auto: false, at, seat: seatIndex, turnId, roundId: this.state.roundId, intentId,
    });
    this.advanceBan(at);
    this.emit('update', { reason: 'ban-accepted' });
    return pass({ action: 'ban-accepted', characterId, phase: this.state.phase });
  }

  // ---------- secret intents ----------

  teamEffectives(team) {
    const out = {};
    const seats = this.state.secret.teams[team].seats;
    for (const slotId of this.rules.slotPlan) {
      let winner = null;
      for (const seatIndex of [0, 1]) {
        const intent = seats[seatIndex]?.[slotId];
        if (!intent) continue;
        // 队内冲突：以更晚被采纳的意图为准，同一时刻低座位优先；保证确定性。
        if (
          !winner
          || intent.at > winner.at
          || (intent.at === winner.at && seatIndex < winner.seat)
        ) {
          winner = { ...intent, seat: seatIndex };
        }
      }
      if (winner) out[slotId] = winner;
    }
    return out;
  }

  teamEffectiveIds(team) {
    const effectives = this.teamEffectives(team);
    const ids = [];
    for (const slotId of this.rules.slotPlan) {
      if (effectives[slotId]) ids.push(effectives[slotId].characterId);
    }
    return ids;
  }

  submitSecret({ team, seatIndex, intentId, roundId, windowId, slotId, characterId, receivedAt = this.clock() }) {
    const at = receivedAt;
    this.tick(at);
    if (this.state.phase !== 'secret') return fail('phase-closed', '秘密候选阶段已结束，意图未被采用');
    if (roundId !== this.state.roundId) {
      return fail('stale-round', `轮次 ${roundId} 已过期，当前为第 ${this.state.roundId} 轮`);
    }
    if (windowId !== this.state.secret.windowId) {
      return fail('stale-window', '该秘密候选窗口已关闭');
    }
    if (!this.seats[team] || !this.seats[team][seatIndex]) return fail('unknown-seat', '未知座位');
    if (!this.presence[team] || this.presence[team][seatIndex] === false) {
      return fail('seat-away', '座位处于暂离状态，意图未被采用');
    }
    if (this.seenIntents.has(intentId)) return fail('duplicate-intent', '重复的意图 ID 已被忽略');
    if (!SLOT_DEFINITIONS[slotId] || !this.rules.slotPlan.includes(slotId)) return fail('unknown-slot', '未知阵容位');
    const character = this.pool.get(characterId);
    if (!character) return fail('unknown-candidate', '角色不在角色池中');
    if (this.state.bans.some((entry) => entry.characterId === characterId)) {
      return fail('candidate-banned', '该角色已被禁用');
    }
    if (!slotAccepts(slotId, character.role)) {
      return fail('role-mismatch', `${character.name} 是 ${character.role}，无法放入 ${SLOT_DEFINITIONS[slotId].label}`);
    }

    // 队内秘密冲突：同位置两席不同候选，后到的意图覆盖先到的（可改选），并记录审计日志。
    const theirSeat = seatIndex === 0 ? 1 : 0;
    const otherPick = this.state.secret.teams[team].seats[theirSeat]?.[slotId];
    if (otherPick && otherPick.characterId !== characterId) {
      const loser = otherPick.at > at ? { characterId, seat: seatIndex, at } : { characterId: otherPick.characterId, seat: theirSeat, at: otherPick.at };
      const winner = otherPick.at > at ? { characterId: otherPick.characterId, seat: theirSeat, at: otherPick.at } : { characterId, seat: seatIndex, at };
      this.state.secret.teams[team].conflicts.push({ at, slotId, winner, loser });
    }

    // 队内同队角色重复：跨座位/跨位置均不允许同一角色被本队锁定两次。
    const ownSeatIntents = this.state.secret.teams[team].seats[seatIndex] || {};
    for (const [otherSlot, intent] of Object.entries(ownSeatIntents)) {
      if (otherSlot !== slotId && intent.characterId === characterId) {
        return fail('team-internal-conflict', '同一队伍两个阵容位不能锁定同一角色');
      }
    }
    const otherSeatIntents = otherPick
      ? { ...(this.state.secret.teams[team].seats[theirSeat] || {}) }
      : (this.state.secret.teams[team].seats[theirSeat] || {});
    for (const [otherSlot, intent] of Object.entries(otherSeatIntents)) {
      if (otherSlot !== slotId && intent.characterId === characterId) {
        return fail('team-internal-conflict', '该角色已被同队另一座位用于其他阵容位');
      }
    }

    const candidateTeam = this.rules.slotPlan.map((sid) => {
      if (sid === slotId) return { slotId: sid, characterId };
      const own = ownSeatIntents[sid];
      const other = otherSeatIntents[sid];
      let chosen = own && other
        ? (own.at >= other.at ? own : other)
        : (own || other || null);
      return { slotId: sid, characterId: chosen ? chosen.characterId : null };
    });
    const hypotheticalIds = candidateTeam.map((entry) => entry.characterId);
    const factionCounts = countFactionsFromIds(hypotheticalIds.filter(Boolean), this.pool);
    for (const [faction, count] of Object.entries(factionCounts)) {
      if (count > this.rules.factionCap) {
        return fail('faction-cap', `阵营 ${FACTIONS[faction].name} 已有 ${count} 名，上限 ${this.rules.factionCap}`);
      }
    }
    const bannedSet = new Set(this.state.bans.map((entry) => entry.characterId));
    const remainingSlots = candidateTeam.filter((entry) => !entry.characterId).map((entry) => entry.slotId);
    if (!canComplete({
      rosterIds: hypotheticalIds,
      slotIds: remainingSlots,
      pool: this.pool,
      banned: bannedSet,
      locked: null,
      rules: this.rules,
    })) {
      return fail('infeasible', '该选择会让剩余阵容位无法同时满足角色与阵营约束');
    }

    const previous = this.state.secret.teams[team].seats[seatIndex][slotId] || null;
    this.state.secret.teams[team].seats[seatIndex][slotId] = {
      characterId, intentId, at, roundId, windowId,
    };
    this.seenIntents.add(intentId);
    if (previous) {
      this.state.secret.teams[team].revisions.push({
        at, slotId, seat: seatIndex, from: previous.characterId, to: characterId,
      });
    }
    const conflict = this.teamSeatAgreement(team, slotId);
    this.emit('update', { reason: 'secret-accepted', team });
    return pass({
      action: 'secret-accepted',
      slotId,
      characterId,
      revision: Boolean(previous),
      conflict,
    });
  }

  teamSeatAgreement(team, slotId) {
    const seats = this.state.secret.teams[team].seats;
    const first = seats[0]?.[slotId];
    const second = seats[1]?.[slotId];
    if (!first || !second) return null;
    return {
      slotId,
      agree: first.characterId === second.characterId,
      picks: [first.characterId, second.characterId],
    };
  }

  // ---------- adjudication ----------

  buildDefaultPreferences(bannedSet) {
    const explicit = { A: this.teamEffectives('A'), B: this.teamEffectives('B') };
    const claimed = new Set();
    for (const team of TEAMS) {
      for (const pick of Object.values(explicit[team])) {
        if (!bannedSet.has(pick.characterId) && !claimed.has(pick.characterId)) claimed.add(pick.characterId);
      }
    }
    const preference = { A: {}, B: {} };
    const defaulted = { A: [], B: [] };
    const initiativeOrder = [this.state.initiative, this.state.initiative === 'A' ? 'B' : 'A'];

    for (const team of initiativeOrder) {
      const rosterIds = this.rules.slotPlan.map((sid) => explicit[team][sid]?.characterId || null);
      const lockedMock = new Map([...claimed].map((cid) => [cid, { team: 'claimed', slotId: null }]));
      for (const slotId of this.rules.slotPlan) {
        const picked = explicit[team][slotId];
        if (picked && !bannedSet.has(picked.characterId)) {
          preference[team][slotId] = { characterId: picked.characterId, kind: 'secret' };
          continue;
        }
        const index = this.rules.slotPlan.indexOf(slotId);
        const order = defaultCandidateOrder({
          pool: this.pool,
          banned: bannedSet,
          locked: lockedMock,
          usedIds: new Set(rosterIds.filter(Boolean)),
          slotId,
        });
        const chosen = order[0] || null;
        preference[team][slotId] = chosen ? { characterId: chosen, kind: 'default' } : null;
        if (chosen) {
          rosterIds[index] = chosen;
          claimed.add(chosen);
          lockedMock.set(chosen, { team: 'claimed', slotId: null });
          defaulted[team].push(slotId);
        }
      }
    }
    return { preference, explicit, defaulted };
  }

  enumerateLineups(bannedSet) {
    const { slotPlan, factionCap, minFactions } = this.rules;
    const options = slotPlan.map((slotId) => {
      const list = [...this.pool.values()]
        .filter((c) => !bannedSet.has(c.id) && slotAccepts(slotId, c.role))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { slotId, list };
    });
    const results = [];
    const dfs = (index, chosen, used, factionCounts) => {
      if (index === options.length) {
        if (Object.keys(factionCounts).length < minFactions) return;
        results.push(chosen.slice());
        return;
      }
      const { slotId, list } = options[index];
      for (const character of list) {
        if (used.has(character.id)) continue;
        const next = (factionCounts[character.faction] || 0) + 1;
        if (next > factionCap) continue;
        chosen.push({ slotId, characterId: character.id });
        used.add(character.id);
        dfs(index + 1, chosen, used, { ...factionCounts, [character.faction]: next });
        used.delete(character.id);
        chosen.pop();
      }
    };
    dfs(0, [], new Set(), {});
    return results;
  }

  scoreLineup(roster, preferences) {
    let secret = 0;
    let defaults = 0;
    for (const entry of roster) {
      const pref = preferences[entry.slotId];
      if (!pref || pref.characterId !== entry.characterId) continue;
      if (pref.kind === 'secret') secret += 1;
      else defaults += 1;
    }
    return { secret, defaults };
  }

  adjudicate(now, reason) {
    if (this.state.phase !== 'secret') return;
    const bannedSet = new Set(this.state.bans.map((entry) => entry.characterId));
    const { preference, explicit, defaulted } = this.buildDefaultPreferences(bannedSet);
    const lineupsA = this.enumerateLineups(bannedSet);
    const lineupsB = this.enumerateLineups(bannedSet);
    const diagnostics = {
      candidatesPerSlot: Object.fromEntries(this.rules.slotPlan.map((slotId) => [
        slotId,
        [...this.pool.values()].filter((c) => !bannedSet.has(c.id) && slotAccepts(slotId, c.role)).length,
      ])),
      lineupOptions: { A: lineupsA.length, B: lineupsB.length },
      banned: [...bannedSet],
    };

    if (!lineupsA.length || !lineupsB.length) {
      return this.failAdjudication(now, reason, 'candidate-exhausted', diagnostics);
    }

    let best = null;
    let bestKey = '';
    for (const rosterA of lineupsA) {
      const idsA = new Set(rosterA.map((e) => e.characterId));
      for (const rosterB of lineupsB) {
        if (rosterB.some((e) => idsA.has(e.characterId))) continue;
        const mA = this.scoreLineup(rosterA, preference.A);
        const mB = this.scoreLineup(rosterB, preference.B);
        const initiativeSecret = this.state.initiative === 'A' ? mA.secret : mB.secret;
        const initiativeDefault = this.state.initiative === 'A' ? mA.defaults : mB.defaults;
        const score = (mA.secret + mB.secret) * 10000
          + (mA.defaults + mB.defaults) * 200
          + initiativeSecret * 20
          + initiativeDefault * 5;
        const key = rosterA.map((e) => e.characterId).join('|') + '::' + rosterB.map((e) => e.characterId).join('|');
        if (!best || score > best.score || (score === best.score && key < bestKey)) {
          best = { rosterA, rosterB, score, mA, mB };
          bestKey = key;
        }
      }
    }

    if (!best) return this.failAdjudication(now, reason, 'no-disjoint-lineup', diagnostics);

    const locks = new Map();
    for (const team of TEAMS) {
      for (const entry of (team === 'A' ? best.rosterA : best.rosterB)) {
        locks.set(entry.characterId, { team, slotId: entry.slotId });
      }
    }
    const validation = validateFinalRosters({ pool: this.pool, banned: bannedSet, locked: locks, rules: this.rules });
    if (!validation.ok) {
      return this.failAdjudication(now, reason, 'validation-failed', { ...diagnostics, validation });
    }

    // 只有出现在裁决产物里的信息才会被公开；原始座位秘密仅在裁决后快照。
    const contested = [];
    const allExplicitIds = new Set(
      [...Object.values(explicit.A), ...Object.values(explicit.B)].map((p) => p.characterId),
    );
    for (const characterId of allExplicitIds) {
      const wantedBy = TEAMS.filter((team) =>
        this.rules.slotPlan.some((slotId) => explicit[team][slotId]?.characterId === characterId));
      if (wantedBy.length > 1) {
        const winner = TEAMS.find((team) =>
          (team === 'A' ? best.rosterA : best.rosterB).some((e) => e.characterId === characterId)) || null;
        contested.push({ characterId, wantedBy, winner });
      }
    }

    const overridden = [];
    for (const team of TEAMS) {
      const roster = team === 'A' ? best.rosterA : best.rosterB;
      for (const entry of roster) {
        const desired = explicit[team][entry.slotId];
        if (desired && desired.characterId !== entry.characterId) {
          const wonElsewhere = contested.find((c) => c.characterId === desired.characterId);
          overridden.push({
            team,
            slotId: entry.slotId,
            desired: desired.characterId,
            actual: entry.characterId,
            reason: wonElsewhere && wonElsewhere.winner !== team ? 'contested' : 'constraint',
          });
        }
      }
    }

    const defaultsUsed = {};
    for (const team of TEAMS) {
      const explicitIds = new Set(Object.values(explicit[team]).map((p) => p.characterId));
      const roster = team === 'A' ? best.rosterA : best.rosterB;
      defaultsUsed[team] = roster
        .filter((entry) => !explicitIds.has(entry.characterId))
        .map((entry) => entry.slotId);
    }

    const reveal = {
      at: now,
      reason,
      initiative: this.state.initiative,
      secretTeams: {
        A: this.secretSnapshot('A'),
        B: this.secretSnapshot('B'),
      },
      defaultsUsed,
      computedDefaults: defaulted,
      contested,
      overridden,
      teamConflicts: {
        A: this.state.secret.teams.A.conflicts.slice(),
        B: this.state.secret.teams.B.conflicts.slice(),
      },
      revisions: {
        A: this.state.secret.teams.A.revisions.slice(),
        B: this.state.secret.teams.B.revisions.slice(),
      },
      rosters: { A: best.rosterA, B: best.rosterB },
      factionCounts: validation.factionCounts,
      locks,
    };

    const scene = createMatchScene({
      matchId: this.id,
      roundId: this.state.roundId,
      rules: this.rules,
      bans: this.state.bans,
      rosters: { A: best.rosterA, B: best.rosterB },
      factionCounts: validation.factionCounts,
      initiative: this.state.initiative,
      pool: this.pool,
      meta: this.meta,
      createdAt: now,
      revealReason: reason,
      overrides: overridden,
      contested,
    });

    this.state.reveal = reveal;
    this.state.phase = 'revealed';
    this.state.revealedAt = now;
    this.state.scene = scene;
    this.emit('adjudicated', reveal);
    this.emit('update', { reason: 'adjudicated' });
  }

  failAdjudication(now, reason, code, diagnostics) {
    this.state.phase = 'failed';
    this.state.revealedAt = now;
    this.state.failure = {
      at: now, reason, code, diagnostics,
      secretTeams: { A: this.secretSnapshot('A'), B: this.secretSnapshot('B') },
      bans: this.state.bans.slice(),
    };
    this.emit('failed', this.state.failure);
    this.emit('update', { reason: 'failed' });
  }

  secretSnapshot(team) {
    const picks = {};
    const effectives = this.teamEffectives(team);
    for (const slotId of this.rules.slotPlan) {
      const intent = effectives[slotId];
      picks[slotId] = intent
        ? { characterId: intent.characterId, seat: intent.seat, intentId: intent.intentId }
        : null;
    }
    const seats = this.state.secret.teams[team].seats;
    return {
      picks,
      rawSeats: { 0: { ...seats[0] }, 1: { ...seats[1] } },
    };
  }

  // ---------- views ----------

  presenceView() {
    const out = {};
    for (const team of TEAMS) {
      out[team] = this.seats[team].map((seat) => ({
        seat: seat.seat,
        name: seat.name,
        connected: this.presence[team][seat.seat],
      }));
    }
    return out;
  }

  secretStatus(team) {
    const picks = this.teamEffectives(team);
    return {
      slotsSubmitted: Object.keys(picks).length,
      totalSlots: this.rules.slotPlan.length,
      conflicts: this.state.secret.teams[team].conflicts.length,
    };
  }

  banView() {
    const activeTurnId = this.state.phase === 'ban'
      ? `r${this.state.roundId}-ban${this.state.banTurnIndex}`
      : null;
    return {
      sequence: this.state.banSequence.slice(),
      turnIndex: this.state.banTurnIndex,
      activeTeam: this.state.phase === 'ban'
        ? this.state.banSequence[this.state.banTurnIndex]
        : null,
      activeTurnId,
      deadline: this.effectiveBanDeadline(),
      bans: this.state.bans.map((entry, index) => ({
        order: index,
        team: entry.team,
        characterId: entry.characterId,
        auto: Boolean(entry.auto),
        reason: entry.reason || null,
        turnId: entry.turnId,
      })),
    };
  }

  rosterView() {
    if (!this.state.reveal) return null;
    const out = {};
    for (const team of TEAMS) {
      const defaultsUsed = new Set(this.state.reveal.defaultsUsed[team] || []);
      out[team] = this.state.reveal.rosters[team].map((entry) => {
        const character = characterById(entry.characterId, this.pool);
        const overr = this.state.reveal.overridden.find((o) => o.team === team && o.slotId === entry.slotId);
        let source = 'secret';
        if (overr) source = overr.reason === 'contested' ? 'contested-fallback' : 'constraint-fallback';
        else if (defaultsUsed.has(entry.slotId)) source = 'default';
        return {
          slotId: entry.slotId,
          slotLabel: SLOT_DEFINITIONS[entry.slotId].label,
          characterId: entry.characterId,
          character: character ? {
            ...character,
            roleName: ROLES[character.role].name,
            factionName: FACTIONS[character.faction].name,
          } : null,
          fitScore: character ? fitScore(character, entry.slotId) : null,
          source,
        };
      });
    }
    return out;
  }

  baseView(now) {
    const view = {
      matchId: this.id,
      serverNow: now,
      phase: this.state.phase,
      roundId: this.state.roundId,
      initiative: this.state.initiative,
      rules: {
        banTurnsPerTeam: this.rules.banTurnsPerTeam,
        factionCap: this.rules.factionCap,
        minFactions: this.rules.minFactions,
        slotPlan: this.rules.slotPlan.slice(),
        timers: { ...this.rules.timers },
      },
      teams: {
        A: { ...TEAM_META.A, seats: this.presenceView().A },
        B: { ...TEAM_META.B, seats: this.presenceView().B },
      },
      ban: this.banView(),
      presence: this.presenceView(),
      meta: this.meta,
    };
    if (this.state.phase === 'secret') {
      view.secret = {
        windowId: this.state.secret.windowId,
        deadline: this.effectiveSecretDeadline(),
        status: { A: this.secretStatus('A'), B: this.secretStatus('B') },
        revealed: null,
      };
    }
    if (this.state.phase === 'revealed') {
      view.secret = {
        windowId: `r${this.state.roundId}-secret`,
        deadline: null,
        status: { A: this.secretStatus('A'), B: this.secretStatus('B') },
        revealed: {
          at: this.state.reveal.at,
          reason: this.state.reveal.reason,
          secretTeams: this.state.reveal.secretTeams,
          defaultsUsed: this.state.reveal.defaultsUsed,
          contested: this.state.reveal.contested,
          overridden: this.state.reveal.overridden,
          teamConflicts: this.state.reveal.teamConflicts,
        },
      };
      view.rosters = this.rosterView();
      view.factionCounts = this.state.reveal.factionCounts;
      view.scene = this.state.scene;
    }
    if (this.state.phase === 'failed') {
      view.failure = {
        at: this.state.failure.at,
        reason: this.state.failure.reason,
        code: this.state.failure.code,
        diagnostics: this.state.failure.diagnostics,
      };
      view.secret = {
        windowId: this.state.secret.windowId,
        deadline: null,
        status: { A: this.secretStatus('A'), B: this.secretStatus('B') },
        revealed: null,
      };
    }
    return view;
  }

  publicView(now = this.clock()) {
    this.tick(now);
    return { ...this.baseView(now), seatRole: 'spectator' };
  }

  teamView(team, seatIndex, now = this.clock()) {
    this.tick(now);
    const view = this.baseView(now);
    view.seatRole = { team, seat: seatIndex, teamMeta: TEAM_META[team] };
    if (this.state.phase === 'secret' && this.state.secret) {
      const snapshot = this.secretSnapshot(team);
      view.secret.own = { picks: snapshot.picks, rawSeats: snapshot.rawSeats };
      view.secret.opponent = {
        slotsSubmitted: this.secretStatus(team === 'A' ? 'B' : 'A').slotsSubmitted,
        totalSlots: this.rules.slotPlan.length,
      };
    }
    return view;
  }

  availableCharacters() {
    return [...this.pool.values()];
  }
}
