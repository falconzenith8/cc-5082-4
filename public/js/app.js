const ROUTE = parseRoute(location.pathname);

const state = {
  ws: null,
  view: null,
  clockOffset: 0,
  selected: null, // { characterId, slotId? }
  filter: 'all',
  away: false,
  intentSeq: 0,
  sceneLoaded: false,
  lastRejection: null,
  sceneBoundScene: null,
};

const el = {
  title: document.getElementById('page-title'),
  subtitle: document.getElementById('page-subtitle'),
  roleBadge: document.getElementById('role-badge'),
  phaseBadge: document.getElementById('phase-badge'),
  clockBadge: document.getElementById('clock-badge'),
  phaseSummary: document.getElementById('phase-summary'),
  presenceRow: document.getElementById('presence-row'),
  notice: document.getElementById('notice'),
  poolCount: document.getElementById('pool-count'),
  filterRow: document.getElementById('filter-row'),
  poolList: document.getElementById('pool-list'),
  boardTitle: document.getElementById('board-title'),
  turnTrack: document.getElementById('turn-track'),
  teamA: document.getElementById('team-A'),
  teamB: document.getElementById('team-B'),
  revealPanel: document.getElementById('reveal-panel'),
  sceneArea: document.getElementById('scene-area'),
  sceneCanvas: document.getElementById('scene-canvas'),
  sceneJson: document.getElementById('scene-json'),
  sceneDownload: document.getElementById('scene-download'),
  sceneSend: document.getElementById('scene-send'),
  draftArea: document.getElementById('draft-area'),
  toast: document.getElementById('toast'),
};

function parseRoute(pathname) {
  const table = pathname.match(/^\/table\/([^/]+)$/);
  const spectate = pathname.match(/^\/spectate\/([^/]+)$/);
  const scene = pathname.match(/^\/scene\/([^/]+)$/);
  const params = new URLSearchParams(location.search);
  if (table) return { kind: 'table', matchId: table[1], token: params.get('token') };
  if (spectate) return { kind: 'spectate', matchId: spectate[1] };
  if (scene) return { kind: 'scene', matchId: scene[1] };
  return { kind: 'lobby', matchId: null };
}

function nextIntentId(kind) {
  state.intentSeq += 1;
  return `${kind}-${Date.now()}-${state.intentSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

function toast(message, tone = '') {
  el.toast.textContent = message;
  el.toast.className = `toast ${tone}`.trim();
  el.toast.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

function setNotice(message, isError = false) {
  if (!message) { el.notice.hidden = true; return; }
  el.notice.textContent = message;
  el.notice.className = `notice ${isError ? 'error' : ''}`.trim();
  el.notice.hidden = false;
}

function characterOf(view, id) {
  return (view.pool || []).find((c) => c.id === id) || null;
}

function roleMeta(c) {
  const map = {
    vanguard: { label: '先锋', color: '#f3a712', short: '锋' },
    support: { label: '支援', color: '#3ddc97', short: '援' },
    duelist: { label: '决斗', color: '#ff6b8a', short: '斗' },
    control: { label: '控制', color: '#a78bfa', short: '控' },
  };
  return map[c.role] || map.control;
}

function factionMeta(c) {
  const map = {
    iron: { label: '铁盟', color: '#9aa8bf' },
    tide: { label: '潮汐', color: '#38bdf8' },
    ember: { label: '焰庭', color: '#fb923c' },
    wild: { label: '荒野', color: '#a3e635' },
  };
  return map[c.faction] || map.iron;
}

function isSeat() {
  return state.view && state.view.you;
}

function myTeam() {
  return state.view?.you?.team || null;
}

function mySeat() {
  return state.view?.you?.seat ?? null;
}

async function createAndJoin() {
  const res = await fetch('/api/matches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ meta: { label: '手动创建' }, rules: { timers: { banMs: 45000, secretMs: 60000, awayGraceMs: 8000 } } }),
  });
  if (!res.ok) { toast('创建对局失败', 'error'); return; }
  const data = await res.json();
  renderLobbyLinks(data);
  toast('对局已创建，使用下方座位链接进入', 'ok');
}

function renderLobbyLinks(data) {
  const wrap = document.createElement('div');
  wrap.className = 'link-grid';
  const cards = [
    ['座位 A·0', `/table/${data.matchId}?token=${data.tokens.A[0]}`],
    ['座位 A·1', `/table/${data.matchId}?token=${data.tokens.A[1]}`],
    ['座位 B·0', `/table/${data.matchId}?token=${data.tokens.B[0]}`],
    ['座位 B·1', `/table/${data.matchId}?token=${data.tokens.B[1]}`],
    ['旁观席', `/spectate/${data.matchId}`],
    ['比赛场景', `/scene/${data.matchId}`],
  ];
  for (const [label, href] of cards) {
    const card = document.createElement('div');
    card.className = 'link-card';
    const h = document.createElement('div');
    h.textContent = label;
    const a = document.createElement('a');
    a.href = href;
    a.textContent = location.origin + href;
    card.append(h, a);
    wrap.append(card);
  }
  const holder = document.getElementById('lobby-links');
  if (holder) holder.replaceChildren(wrap);
}

async function boot() {
  if (ROUTE.kind === 'scene') {
    el.draftArea.hidden = true;
    el.sceneArea.hidden = false;
    document.getElementById('lobby-only')?.remove();
    await bootSceneRoute();
    return;
  }
  if (ROUTE.kind === 'lobby') {
    el.draftArea.hidden = true;
    el.title.textContent = '竞技选角协议';
    el.phaseSummary.innerHTML = '<div class="phase-callout"><p class="headline">服务端权威的双队选角：轮流禁用 → 队内秘密候选 → 到期一次性公开裁决。</p></div>';
    const createBtn = document.createElement('button');
    createBtn.className = 'primary-btn';
    createBtn.textContent = '创建新对局';
    createBtn.addEventListener('click', createAndJoin);
    const tools = document.createElement('div');
    tools.className = 'lobby';
    const links = document.createElement('div');
    links.id = 'lobby-links';
    tools.append(createBtn, links);
    document.getElementById('main').prepend(tools);
    return;
  }
  el.sceneArea.hidden = true;
  connect();
}

// ---------------- WebSocket ----------------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      type: 'hello',
      matchId: ROUTE.matchId,
      token: ROUTE.token || null,
    }));
  });
  ws.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'hello.ok') {
      if (message.role?.kind === 'seat') {
        el.roleBadge.textContent = `${message.role.team === 'A' ? '苍隼' : '赤隼'} · 座位 ${message.role.seat}`;
        el.roleBadge.className = `badge seat-${message.role.team}`;
      } else {
        el.roleBadge.textContent = '旁观席';
        el.roleBadge.className = 'badge';
      }
      return;
    }
    if (message.type === 'view') {
      applyView(message.view);
      return;
    }
    if (message.type === 'intent.result') {
      if (message.ok) {
        toast('意图已被服务端采用', 'ok');
      } else {
        state.lastRejection = message;
        toast(`意图未被采用：${message.message}`, 'error');
        setNotice(`服务端拒绝（${message.code}）：${message.message}`, true);
      }
      return;
    }
    if (message.type === 'rejected' || message.type === 'error') {
      toast(`服务端拒绝：${message.message || message.code}`, 'error');
    }
  });
  ws.addEventListener('close', () => {
    setNotice('连接已断开，正在重连…', true);
    setTimeout(connect, 1500);
  });
}

function applyView(view) {
  state.view = view;
  state.clockOffset = view.serverNow - Date.now();
  render();
}

// ---------------- Render ----------------

function phaseName(phase) {
  return { ban: '禁用阶段', secret: '秘密候选', revealed: '已公开裁决', failed: '裁决失败' }[phase] || phase;
}

function countdown(deadline) {
  if (!deadline) return '--:--';
  const remaining = Math.max(0, deadline - (Date.now() + state.clockOffset));
  const sec = Math.ceil(remaining / 1000);
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

function render() {
  const view = state.view;
  if (!view) return;
  el.phaseBadge.textContent = phaseName(view.phase);
  el.phaseBadge.className = `badge phase ${view.phase}`;
  el.title.textContent = view.phase === 'revealed' ? '正式阵容 · 对局已裁决' : '竞技选角台';
  el.subtitle.textContent = ROUTE.kind === 'spectate' ? '旁观视角：秘密候选不可见' : '座位视角';

  renderSummary(view);
  renderPresence(view);
  renderPool(view);
  renderTurnTrack(view);
  renderTeams(view);
  renderReveal(view);
  updateClock();
  if (view.scene) {
    el.sceneArea.hidden = false;
    el.sceneJson.textContent = JSON.stringify(view.scene, null, 2);
    const blob = new Blob([JSON.stringify(view.scene, null, 2)], { type: 'application/json' });
    el.sceneDownload.href = URL.createObjectURL(blob);
    bindSceneButton(view.scene);
  } else {
    el.sceneArea.hidden = true;
  }
}

function renderSummary(view) {
  const callout = document.createElement('div');
  callout.className = `phase-callout ${view.phase}`;
  const headline = document.createElement('p');
  headline.className = 'headline';
  const hint = document.createElement('p');
  hint.className = 'hint';
  if (view.phase === 'ban') {
    const team = view.teams[view.ban.activeTeam];
    headline.innerHTML = `轮到 <strong>${team.name}</strong> 禁用 · 剩余 <span class="mono">${countdown(view.ban.deadline)}</span>`;
    hint.textContent = `${view.ban.sequence.filter((t) => t === 'A').length} 次禁用/队；同一角色不可重复禁用。截止瞬间服务端将执行默认禁用。`;
  } else if (view.phase === 'secret') {
    headline.innerHTML = `队内秘密候选进行中 · 公开倒计时 <span class="mono">${countdown(view.secret.deadline)}</span>`;
    hint.textContent = isSeat()
      ? '只有本队两席看得见本队候选；敌方只显示已提交位置数。截止时两队的秘密在同一裁决中同时公开。'
      : '当前为旁观视图：服务端不下发任何队伍的秘密候选，裁决前无法从页面提取。';
  } else if (view.phase === 'revealed') {
    headline.innerHTML = `裁决完成 · 触发方式：<strong>${reasonText(view.secret.revealed.reason)}</strong>`;
    hint.textContent = '最终阵容与双方秘密候选由同一次裁决产生，可直接送达比赛场景。';
  } else if (view.phase === 'failed') {
    headline.innerHTML = `裁决失败：<strong>${view.failure.code}</strong>`;
    hint.textContent = '候选耗尽或约束不可满足，未产生任何阵容锁。';
  }
  callout.append(headline, hint);
  el.phaseSummary.replaceChildren(callout);
}

function reasonText(reason) {
  return { deadline: '正常到期', away: '座位暂离触发', 'both-teams-away': '双方暂离超时', 'next-round': '新一轮' }[reason] || reason;
}

function renderPresence(view) {
  const row = document.createElement('div');
  row.className = 'presence-row';
  for (const team of ['A', 'B']) {
    const group = document.createElement('div');
    group.className = 'presence-team';
    const name = document.createElement('span');
    name.textContent = view.teams[team].name;
    name.style.color = view.teams[team].color;
    group.append(name);
    for (const seat of view.teams[team].seats) {
      const chip = document.createElement('span');
      const you = state.view?.you && state.view.you.team === team && state.view.you.seat === seat.seat;
      chip.className = `seat-chip ${seat.connected ? '' : 'away'} ${you ? 'you' : ''}`.trim();
      const dot = document.createElement('span');
      dot.className = `presence-dot ${seat.connected ? 'on' : 'away'}`;
      chip.append(dot, document.createTextNode(`${seat.name}${seat.connected ? '' : '（暂离）'}`));
      group.append(chip);
    }
    row.append(group);
  }
  const controls = document.createElement('div');
  controls.className = 'presence-team';
  if (isSeat() && view.phase === 'secret') {
    const awayBtn = document.createElement('button');
    awayBtn.className = 'ghost-btn';
    awayBtn.textContent = state.away ? '恢复在场' : '模拟暂离';
    awayBtn.addEventListener('click', () => {
      state.away = !state.away;
      state.ws.send(JSON.stringify({ type: 'presence', connected: !state.away }));
      awayBtn.textContent = state.away ? '恢复在场' : '模拟暂离';
    });
    controls.append(awayBtn);
  }
  row.append(controls);
  el.presenceRow.replaceChildren(row);
}

function availableForSlot(view, slotId) {
  const banned = new Set(view.ban.bans.map((b) => b.characterId));
  const accept = { vanguard: ['vanguard'], support: ['support'], flex: ['duelist', 'control'] }[slotId] || [];
  return (view.pool || []).filter((c) => !banned.has(c.id) && accept.includes(c.role));
}

const ROLE_FILTERS = [['all', '全部'], ['vanguard', '先锋'], ['support', '支援'], ['duelist', '决斗'], ['control', '控制']];

function renderPool(view) {
  el.poolCount.textContent = `${view.pool.length} 名`;
  const filters = document.createElement('div');
  filters.className = 'filter-row';
  for (const [key, label] of ROLE_FILTERS) {
    const btn = document.createElement('button');
    btn.className = `filter-btn ${state.filter === key ? 'active' : ''}`.trim();
    btn.textContent = label;
    btn.addEventListener('click', () => { state.filter = key; renderPool(state.view); });
    filters.append(btn);
  }
  el.filterRow.replaceChildren(filters);

  const banned = new Set(view.ban.bans.map((b) => b.characterId));
  const lockedBy = new Map();
  if (view.rosters) {
    for (const team of ['A', 'B']) {
      for (const entry of view.rosters[team]) lockedBy.set(entry.characterId, team);
    }
  }
  const bannedBy = new Map(view.ban.bans.map((b) => [b.characterId, b.team]));
  const list = document.createElement('div');
  list.className = 'pool-list';
  const chars = (view.pool || [])
    .filter((c) => state.filter === 'all' || c.role === state.filter)
    .slice()
    .sort((a, b) => (a.role === b.role ? b.power - a.power : a.role.localeCompare(b.role)));
  for (const c of chars) {
    const isBanned = banned.has(c.id);
    const lockedTeam = lockedBy.get(c.id);
    const btn = document.createElement('button');
    btn.className = `pool-item ${isBanned ? 'gone' : ''} ${state.selected?.characterId === c.id ? 'selected' : ''}`.trim();
    btn.disabled = isBanned || Boolean(lockedTeam) || view.phase === 'revealed' || view.phase === 'failed';
    const r = roleMeta(c);
    const f = factionMeta(c);
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.style.background = f.color;
    glyph.textContent = r.short;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = c.name;
    const tags = document.createElement('span');
    tags.className = 'tags';
    tags.innerHTML = `<span style="color:${r.color}">${r.label}</span><span>${f.label}</span>`;
    meta.append(name, tags);
    const stats = document.createElement('span');
    stats.className = 'stats';
    if (lockedTeam) stats.textContent = `${lockedTeam} 已锁`;
    else if (isBanned) stats.textContent = `${bannedBy.get(c.id) || '?'} 禁用`;
    else stats.innerHTML = `力${c.power} 守${c.guard}<br>速${c.speed} 用${c.utility}`;
    btn.append(glyph, meta, stats);
    if (!btn.disabled) btn.addEventListener('click', () => selectCharacter(c.id));
    list.append(btn);
  }
  el.poolList.replaceChildren(list);
}

function selectCharacter(characterId) {
  const view = state.view;
  const c = characterOf(view, characterId);
  if (!c) return;
  if (view.phase === 'ban') {
    if (!canActInBan(view)) return;
    state.selected = { characterId };
    confirmBan(characterId);
    return;
  }
  if (view.phase === 'secret') {
    const slots = eligibleSlots(view, characterId);
    if (!slots.length) {
      toast('该角色无法放入任何剩余阵容位', 'error');
      return;
    }
    state.selected = { characterId, slotId: slots[0].slotId };
    render();
    toast(`已选中 ${c.name}，请在右侧选择位置提交`, '');
    return;
  }
  state.selected = { characterId };
  render();
}

function canActInBan(view) {
  return isSeat() && view.ban.activeTeam === myTeam() && view.phase === 'ban';
}

function eligibleSlots(view, characterId) {
  const c = characterOf(view, characterId);
  if (!c) return [];
  const picks = view.secret?.own?.picks || {};
  return (view.rules.slotPlan || [])
    .filter((slotId) => {
      const accept = { vanguard: ['vanguard'], support: ['support'], flex: ['duelist', 'control'] }[slotId] || [];
      if (!accept.includes(c.role)) return false;
      const own = picks[slotId];
      return !own || own.characterId === characterId;
    })
    .map((slotId) => ({ slotId, label: slotLabel(slotId) }));
}

function slotLabel(slotId) {
  return { vanguard: '先锋位', support: '支援位', flex: '自由位' }[slotId] || slotId;
}

function confirmBan(characterId) {
  const view = state.view;
  const c = characterOf(view, characterId);
  if (!c) return;
  state.ws.send(JSON.stringify({
    type: 'intent.ban',
    intentId: nextIntentId('ban'),
    roundId: view.roundId,
    turnId: view.ban.activeTurnId,
    characterId,
  }));
  state.selected = null;
  setNotice(`已向服务端提交禁用意图：${c.name}（是否采用由服务端裁决）`);
}

function renderTurnTrack(view) {
  const track = document.createElement('div');
  track.className = 'turn-track';
  view.ban.sequence.forEach((team, index) => {
    const pip = document.createElement('span');
    const done = view.ban.bans[index];
    const active = view.phase === 'ban' && view.ban.turnIndex === index;
    pip.className = `turn-pip ${team} ${done ? 'done' : ''} ${active ? 'active' : ''}`.trim();
    pip.textContent = `${index + 1}. ${team} 禁`;
    track.append(pip);
  });
  const stage = document.createElement('span');
  stage.className = 'turn-pip';
  stage.textContent = view.phase === 'secret' ? '秘密候选' : view.phase === 'revealed' ? '公开裁决' : '—';
  track.append(stage);
  el.turnTrack.replaceChildren(track);
}

function renderTeams(view) {
  const renderTeam = (container, team, view) => {
    const meta = view.teams[team];
    const isMine = myTeam() === team;
    const active = view.phase === 'ban' && view.ban.activeTeam === team;
    container.className = `team-card ${active ? 'turn-active' : ''}`.trim();
    container.dataset.team = team;
    const head = document.createElement('div');
    head.className = 'team-head';
    const h3 = document.createElement('h3');
    h3.textContent = meta.name;
    h3.style.color = meta.color;
    const sub = document.createElement('span');
    sub.className = 'team-sub';
    sub.textContent = active ? '本轮禁用中' : view.phase === 'secret' ? '秘密候选' : '';
    const badge = document.createElement('span');
    badge.className = `team-badge ${isMine ? 'you' : ''}`.trim();
    badge.textContent = isMine ? '你的队伍' : team === 'A' ? '先行方' : '后行方';
    head.append(h3, sub, badge);

    const banTeam = view.ban.bans.filter((b) => b.team === team);
    const strip = document.createElement('div');
    strip.className = 'ban-strip';
    for (const ban of banTeam) {
      const c = characterOf(view, ban.characterId);
      const chip = document.createElement('span');
      chip.className = `ban-chip ${ban.auto ? 'auto' : ''}`.trim();
      chip.textContent = `${ban.auto ? '默认禁' : '禁'} ${c ? c.name : ban.characterId}`;
      strip.append(chip);
    }
    if (!banTeam.length) {
      const empty = document.createElement('span');
      empty.className = 'pick-empty';
      empty.textContent = '尚无禁用';
      strip.append(empty);
    }

    const slotList = document.createElement('div');
    slotList.className = 'slot-list';
    const picks = (isMine && view.secret?.own?.picks) || {};
    const finalRoster = view.rosters?.[team];
    for (const slotId of view.rules.slotPlan) {
      const row = document.createElement('div');
      const own = picks[slotId];
      const finalEntry = finalRoster?.find((e) => e.slotId === slotId);
      row.className = `slot-row ${own ? 'own-pick acted' : ''}`.trim();
      const slotHead = document.createElement('div');
      slotHead.className = 'slot-head';
      const title = document.createElement('span');
      title.className = 'slot-title';
      title.textContent = slotLabel(slotId);
      const roleTag = document.createElement('span');
      roleTag.className = 'role-tag';
      roleTag.textContent = { vanguard: '仅先锋', support: '仅支援', flex: '决斗/控制' }[slotId] || '';
      title.append(roleTag);
      const stateLabel = document.createElement('span');
      stateLabel.className = 'slot-state';
      if (finalEntry) stateLabel.textContent = finalEntry.source === 'secret' ? '已锁定' : finalEntry.source === 'default' ? '默认补位' : '裁决回退';
      else if (own) stateLabel.textContent = '已提交（截止前可改选）';
      else if (isMine) stateLabel.textContent = view.phase === 'secret' ? '待提交' : '';
      else stateLabel.textContent = view.phase === 'secret' ? '敌方保密中' : '';
      slotHead.append(title, stateLabel);
      row.append(slotHead);

      const pill = document.createElement('div');
      if (finalEntry?.character) {
        pill.append(pickPill(finalEntry.character, finalEntry.source));
      } else if (own) {
        const c = characterOf(view, own.characterId);
        pill.append(pickPill(c, 'secret'));
      } else {
        const blank = document.createElement('span');
        blank.className = 'pick-empty';
        blank.textContent = view.phase === 'secret' && !isMine ? '秘密候选（不可见）' : '未选择';
        pill.append(blank);
      }
      row.append(pill);

      if (isMine && view.phase === 'secret') {
        const actions = document.createElement('div');
        actions.className = 'slot-actions';
        const chose = state.selected && eligibleSlots(view, state.selected.characterId).some((s) => s.slotId === slotId);
        const submitBtn = document.createElement('button');
        submitBtn.className = 'primary';
        submitBtn.textContent = own ? '改选为已选角色' : '提交已选角色';
        submitBtn.disabled = !chose;
        submitBtn.addEventListener('click', () => submitSecret(slotId));
        const suggestBtn = document.createElement('button');
        suggestBtn.textContent = '推荐候选';
        suggestBtn.addEventListener('click', () => suggestForSlot(slotId));
        actions.append(submitBtn, suggestBtn);
        row.append(actions);
      }
      slotList.append(row);
    }

    const foot = document.createElement('div');
    foot.className = 'action-foot';
    if (view.phase === 'secret') {
      const status = view.secret.status[team];
      const mine = isMine ? `本队已提交 ${status.slotsSubmitted}/${status.totalSlots}` : `提交进度 ${status.slotsSubmitted}/${status.totalSlots}`;
      foot.textContent = mine;
      if (status.conflicts) foot.textContent += ` · 队内冲突 ${status.conflicts} 次`;
    } else if (view.phase === 'ban' && active) {
      foot.textContent = isMine ? '点击角色池中的角色提交禁用意图' : '对方正在禁用…';
    } else if (view.phase === 'revealed') {
      foot.textContent = `阵营：${Object.entries(view.factionCounts[team]).map(([f, n]) => `${factionLabel(f)}×${n}`).join(' · ')}`;
    }
    container.replaceChildren(head, strip, slotList, foot);
  };
  renderTeam(el.teamA, 'A', view);
  renderTeam(el.teamB, 'B', view);
}

function factionLabel(faction) {
  return { iron: '铁盟', tide: '潮汐', ember: '焰庭', wild: '荒野' }[faction] || faction;
}

function pickPill(character, source) {
  const box = document.createElement('span');
  box.className = 'pick-pill';
  if (!character) { box.textContent = '数据缺失'; return box; }
  const glyph = document.createElement('span');
  glyph.className = 'glyph';
  glyph.style.background = factionMeta(character).color;
  glyph.textContent = roleMeta(character).short;
  const text = document.createElement('span');
  text.textContent = `${character.name} · ${roleMeta(character).label}`;
  box.append(glyph, text);
  if (source) {
    const tag = document.createElement('span');
    tag.className = `tag ${source === 'secret' ? 'secret' : source === 'default' ? 'default' : 'override'}`;
    tag.textContent = {
      secret: '秘密采用',
      default: '默认补位',
      'contested-fallback': '争抢回退',
      'constraint-fallback': '约束回退',
    }[source] || source;
    box.append(tag);
  }
  return box;
}

function submitSecret(slotId) {
  const view = state.view;
  if (!state.selected) { toast('请先在角色池选择角色', 'error'); return; }
  const eligible = eligibleSlots(view, state.selected.characterId).some((s) => s.slotId === slotId);
  if (!eligible) { toast('该角色不适用于此位置', 'error'); return; }
  state.ws.send(JSON.stringify({
    type: 'intent.secret',
    intentId: nextIntentId('secret'),
    roundId: view.roundId,
    windowId: view.secret.windowId,
    slotId,
    characterId: state.selected.characterId,
  }));
  state.selected = null;
  setNotice('已提交秘密候选意图；截止前可再次提交改选。');
}

function suggestForSlot(slotId) {
  const view = state.view;
  const banned = new Set(view.ban.bans.map((b) => b.characterId));
  const picks = view.secret?.own?.picks || {};
  const usedElsewhere = new Set(Object.entries(picks)
    .filter(([sid, pick]) => sid !== slotId && pick)
    .map(([, pick]) => pick.characterId));
  const candidates = availableForSlot(view, slotId)
    .filter((c) => !usedElsewhere.has(c.id) && !banned.has(c.id));
  const weights = {
    vanguard: (c) => c.guard * 0.55 + c.utility * 0.25 + c.power * 0.12 + c.speed * 0.08,
    support: (c) => c.utility * 0.58 + c.guard * 0.18 + c.speed * 0.14 + c.power * 0.1,
    flex: (c) => c.power * 0.5 + c.utility * 0.2 + c.speed * 0.18 + c.guard * 0.12,
  };
  const best = candidates.sort((a, b) => weights[slotId](b) - weights[slotId](a))[0];
  if (!best) { toast('无可用候选', 'error'); return; }
  state.selected = { characterId: best.id, slotId };
  render();
  toast(`推荐 ${best.name}，可直接提交到 ${slotLabel(slotId)}`, '');
}

function renderReveal(view) {
  if (view.phase !== 'revealed' || !view.secret?.revealed) {
    el.revealPanel.hidden = true;
    return;
  }
  el.revealPanel.hidden = false;
  const revealed = view.secret.revealed;
  const wrap = document.createElement('div');
  wrap.className = 'reveal-panel';
  const title = document.createElement('h3');
  title.textContent = '裁决记录（同一次裁决产出）';
  wrap.append(title);

  const grid = document.createElement('div');
  grid.className = 'reveal-grid';
  for (const team of ['A', 'B']) {
    const card = document.createElement('div');
    card.className = 'reveal-team';
    const h = document.createElement('h4');
    h.innerHTML = `<span style="color:${view.teams[team].color}">${view.teams[team].name}</span><span class="muted">${revealed.defaultsUsed[team].length} 个位置由默认选择补足</span>`;
    card.append(h);
    for (const slotId of view.rules.slotPlan) {
      const pick = revealed.secretTeams[team].picks[slotId];
      const finalEntry = view.rosters[team].find((e) => e.slotId === slotId);
      const line = document.createElement('div');
      line.className = 'reveal-line';
      const left = document.createElement('span');
      const ownChar = pick ? characterOf(view, pick.characterId) : null;
      left.innerHTML = `${slotLabel(slotId)}：${ownChar ? ownChar.name : '<span class="muted">未提交</span>'}`;
      const right = document.createElement('span');
      const finalChar = finalEntry.character;
      const isSame = pick && finalChar && pick.characterId === finalChar.id;
      right.innerHTML = `→ ${finalChar ? finalChar.name : '—'} <span class="tag ${isSame ? 'secret' : revealed.defaultsUsed[team].includes(slotId) ? 'default' : 'override'}">${isSame ? '采用' : revealed.defaultsUsed[team].includes(slotId) ? '默认补位' : '回退'}</span>`;
      line.append(left, right);
      card.append(line);
    }
    if (revealed.overridden.filter((o) => o.team === team).length) {
      const notes = document.createElement('div');
      notes.className = 'note-line';
      notes.textContent = revealed.overridden
        .filter((o) => o.team === team)
        .map((o) => `${slotLabel(o.slotId)} ${characterOf(view, o.desired)?.name || o.desired} → ${characterOf(view, o.actual)?.name || o.actual}（${o.reason === 'contested' ? '被敌方争抢' : '受约束'}）`)
        .join('；');
      card.append(notes);
    }
    grid.append(card);
  }
  wrap.append(grid);

  if (revealed.contested.length) {
    const c = document.createElement('div');
    c.className = 'conflict-list';
    c.textContent = '跨阵营争抢：' + revealed.contested.map((item) => {
      const ch = characterOf(view, item.characterId);
      return `${ch?.name || item.characterId}（${item.wantedBy.join('/')} 想要，归 ${item.winner}）`;
    }).join('；');
    wrap.append(c);
  }
  const conflicts = [...revealed.teamConflicts.A, ...revealed.teamConflicts.B];
  if (conflicts.length) {
    const c = document.createElement('div');
    c.className = 'conflict-list';
    c.textContent = '队内冲突记录：' + conflicts.map((item) => `${slotLabel(item.slotId)} 采纳 ${characterOf(view, item.winner.characterId)?.name}，逆位 ${characterOf(view, item.loser.characterId)?.name}`).join('；');
    wrap.append(c);
  }
  const note = document.createElement('p');
  note.className = 'note-line';
  note.textContent = `裁决原因：${reasonText(revealed.reason)} · 两阵营最终阵容互不重复，且均通过位置角色、阵营上限与阵营多样性校验。`;
  wrap.append(note);

  const nextRow = document.createElement('div');
  nextRow.className = 'action-foot';
  const nextBtn = document.createElement('button');
  nextBtn.className = 'ghost-btn';
  nextBtn.textContent = '开始下一轮';
  nextBtn.addEventListener('click', () => {
    state.ws.send(JSON.stringify({ type: 'round.next' }));
    toast('下一轮由服务端裁定先行权后开启');
  });
  nextRow.append(nextBtn);
  wrap.append(nextRow);

  el.revealPanel.replaceChildren(wrap);
}

function updateClock() {
  const view = state.view;
  if (!view) return;
  const deadline = view.phase === 'ban' ? view.ban.deadline : view.phase === 'secret' ? view.secret?.deadline : null;
  el.clockBadge.textContent = deadline ? countdown(deadline) : '—';
  el.clockBadge.className = `badge mono ${deadline && deadline - (Date.now() + state.clockOffset) < 5000 ? 'phase failed' : ''}`.trim();
}

setInterval(() => { if (state.view) updateClock(); }, 250);
setInterval(() => { if (state.view && (state.view.phase === 'ban' || state.view.phase === 'secret')) renderSummary(state.view); }, 500);

// 内置中文字体加载完成后重绘一次，避免先渲染的文字停留在回退字体/缺字形状态。
if (document.fonts?.ready) {
  document.fonts.ready.then(() => { if (state.view) render(); });
}

// ---------------- Scene ----------------

function bindSceneButton(scene) {
  if (state.sceneBoundScene === scene.sceneId) return;
  state.sceneBoundScene = scene.sceneId;
  el.sceneSend.onclick = async () => {
    const runtime = await import('/js/scene-loader.js');
    runtime.loadScene(el.sceneCanvas, scene);
    state.sceneLoaded = true;
    toast('场景已载入比赛画面（2 队 / 6 单位 / 中继核心）', 'ok');
  };
  el.sceneSend.textContent = '送入比赛场景';
}

async function bootSceneRoute() {
  el.title.textContent = '比赛场景';
  el.subtitle.textContent = '由选角裁决直接生成的 scene 载荷';
  try {
    const res = await fetch(`/api/matches/${ROUTE.matchId}/scene`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      el.phaseSummary.innerHTML = `<div class="phase-callout failed"><p class="headline">场景尚未可用</p><p class="hint">${data.error === 'match-not-revealed' ? '对局仍在禁选/保密阶段，裁决完成后才能生成正式阵容。' : '未找到该对局。'}</p></div>`;
      return;
    }
    const scene = await res.json();
    const runtime = await import('/js/scene-loader.js');
    const controller = runtime.loadScene(el.sceneCanvas, scene);
    el.sceneJson.textContent = JSON.stringify(scene, null, 2);
    const blob = new Blob([JSON.stringify(scene, null, 2)], { type: 'application/json' });
    el.sceneDownload.href = URL.createObjectURL(blob);
    el.sceneSend.textContent = '重新载入场景';
    el.sceneSend.onclick = () => controller.reload();
    el.phaseSummary.innerHTML = `<div class="phase-callout revealed"><p class="headline">场景 <span class="mono">${scene.sceneId}</span> 已载入</p><p class="hint">${scene.teams.A.name} vs ${scene.teams.B.name} · 共 ${scene.teams.A.units.length + scene.teams.B.units.length} 个单位 · 载入时读取单位槽位、出生点与目标点，不依赖任何展示卡片。</p></div>`;
  } catch (error) {
    el.phaseSummary.innerHTML = `<div class="phase-callout failed"><p class="headline">载入失败</p><p class="hint">${error.message}</p></div>`;
  }
}

// handle next-round intents sent as raw messages
boot();
