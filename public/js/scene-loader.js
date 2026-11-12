const ROLE_COLORS = {
  vanguard: '#f3a712',
  support: '#3ddc97',
  duelist: '#ff6b8a',
  control: '#a78bfa',
};

export function loadScene(container, scene) {
  const validation = validateScene(scene);
  const canvas = document.createElement('canvas');
  canvas.width = scene.arena.width;
  canvas.height = scene.arena.height;
  container.replaceChildren(canvas);
  const ctx = canvas.getContext('2d');

  const units = [];
  for (const team of ['A', 'B']) {
    for (const unit of scene.teams[team].units) {
      units.push({
        ...unit,
        team,
        x: unit.seat.spawn.x,
        y: unit.seat.spawn.y,
        vx: 0,
        vy: 0,
        target: scene.arena.objectives[0],
        hp: 100,
        alive: true,
        phase: Math.random() * Math.PI * 2,
        color: scene.teams[team].color,
      });
    }
  }

  const state = {
    scene,
    units,
    running: true,
    t: 0,
    validation,
    lastTime: performance.now(),
    objectiveHold: { A: 0, B: 0 },
    winner: null,
  };

  function frame(now) {
    if (!state.running) return;
    const dt = Math.min(0.05, (now - state.lastTime) / 1000);
    state.lastTime = now;
    step(state, dt);
    draw(ctx, state);
    requestAnimationFrame(frame);
  }
  const start = () => requestAnimationFrame(frame);
  if (document.fonts?.load) {
    Promise.all([
      document.fonts.load('400 16px "Noto Sans SC Local"'),
      document.fonts.load('11px "Noto Sans SC Local"'),
      document.fonts.load('bold 13px "Noto Sans SC Local"'),
      document.fonts.load('bold 18px "Noto Sans SC Local"'),
      document.fonts.load('bold 20px "Noto Sans SC Local"'),
      document.fonts.load('14px "Noto Sans SC Local"'),
    ]).then(start, start);
  } else {    start();
  }

  function reload() {
    state.t = 0;
    state.winner = null;
    state.units.forEach((u) => {
      u.x = u.seat.spawn.x;
      u.y = u.seat.spawn.y;
    });
    state.objectiveHold = { A: 0, B: 0 };
    state.lastTime = performance.now();
    state.running = true;
    requestAnimationFrame(frame);
  }

  return { state, canvas, reload, stop: () => { state.running = false; } };
}

function step(state, dt) {
  state.t += dt;
  const objective = state.scene.arena.objectives[0];
  for (const unit of state.units) {
    // 单位向中继核心推进，先锋先抵达，远程角色保持在 170~260 半径。
    const holdRadius = unit.character.role === 'vanguard' ? 24 : unit.character.role === 'support' ? 210 : 140;
    const dx = objective.x - unit.x;
    const dy = objective.y - unit.y;
    const dist = Math.hypot(dx, dy) || 1;
    const speed = unit.character.speed / 42;
    if (dist > holdRadius) {
      unit.x += (dx / dist) * speed * dt * 26;
      unit.y += (dy / dist) * speed * dt * 26;
    } else {
      const orbit = state.t * 0.6 + unit.phase;
      const homeX = objective.x + Math.cos(orbit) * (holdRadius - 10);
      const homeY = objective.y + Math.sin(orbit * 0.8) * (holdRadius - 10);
      unit.x += (homeX - unit.x) * 0.05;
      unit.y += (homeY - unit.y) * 0.05;
    }
  }
  const near = { A: 0, B: 0 };
  for (const unit of state.units) {
    if (Math.hypot(unit.x - objective.x, unit.y - objective.y) < objective.radius) near[unit.team] += 1;
  }
  const lead = near.A === near.B ? null : near.A > near.B ? 'A' : 'B';
  if (lead) {
    state.objectiveHold[lead] += dt;
  }
  for (const team of ['A', 'B']) {
    if (team !== lead) state.objectiveHold[team] = Math.max(0, state.objectiveHold[team] - dt * 1.2);
  }
  if (!state.winner && state.objectiveHold.A >= 3) state.winner = 'A';
  if (!state.winner && state.objectiveHold.B >= 3) state.winner = 'B';
}

function draw(ctx, state) {
  const { scene } = state;
  const w = scene.arena.width;
  const h = scene.arena.height;
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#0a101a');
  bg.addColorStop(0.5, '#0d1624');
  bg.addColorStop(1, '#120f18');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(94, 177, 255, 0.07)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= w; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y <= h; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

  // 阵营生成区
  for (const team of ['A', 'B']) {
    const color = team === 'A' ? 'rgba(94,177,255,' : 'rgba(255,123,114,';
    const cx = team === 'A' ? 190 : 1010;
    const grad = ctx.createRadialGradient(cx, 360, 20, cx, 360, 250);
    grad.addColorStop(0, color + '0.14)');
    grad.addColorStop(1, color + '0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, 360, 250, 0, Math.PI * 2);
    ctx.fill();
  }

  const objective = scene.arena.objectives[0];
  ctx.beginPath();
  ctx.arc(objective.x, objective.y, objective.radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(243, 167, 18, 0.5)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = 'rgba(243, 167, 18, 0.05)';
  ctx.fill();
  const pulse = 0.5 + Math.sin(state.t * 2) * 0.2;
  ctx.beginPath();
  ctx.arc(objective.x, objective.y, objective.radius * pulse, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(243, 167, 18, ${0.25 * pulse})`;
  ctx.stroke();
  ctx.fillStyle = '#d7b56a';
  ctx.font = '16px "Noto Sans SC Local", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(objective.name, objective.x, objective.y + 5);

  // 单位
  for (const unit of state.units) {
    const color = ROLE_COLORS[unit.character.role] || '#93a3bb';
    ctx.beginPath();
    ctx.arc(unit.x, unit.y, 22, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(7, 11, 17, 0.85)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = unit.color;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(unit.x, unit.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#0a0e15';
    ctx.font = 'bold 13px "Noto Sans SC Local", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(unit.character.name.slice(-2), unit.x, unit.y + 1);
    ctx.fillStyle = unit.team === 'A' ? '#9dc9ff' : '#ffb3ad';
    ctx.font = '11px "Noto Sans SC Local", ui-monospace, monospace';
    ctx.fillText(`${unit.character.roleName} · ${unit.slotLabel}`, unit.x, unit.y + 40);
    ctx.fillStyle = '#8296b0';
    ctx.font = '10px "Noto Sans SC Local", ui-monospace, monospace';
    ctx.fillText(unit.character.factionName, unit.x, unit.y + 55);
    ctx.textBaseline = 'alphabetic';
  }

  // 顶部记分
  ctx.fillStyle = 'rgba(10, 15, 23, 0.82)';
  ctx.fillRect(40, 24, w - 80, 62);
  ctx.strokeStyle = 'rgba(38, 50, 72, 0.9)';
  ctx.strokeRect(40, 24, w - 80, 62);
  ctx.textAlign = 'left';
  ctx.fillStyle = scene.teams.A.color;
  ctx.font = 'bold 18px "Noto Sans SC Local", sans-serif';
  ctx.fillText(scene.teams.A.name, 64, 52);
  ctx.fillStyle = '#93a3bb';
  ctx.font = '12px "Noto Sans SC Local", ui-monospace, monospace';
  ctx.fillText(`控制进度 ${state.objectiveHold.A.toFixed(1)}s / 3.0s`, 64, 74);
  ctx.textAlign = 'right';
  ctx.fillStyle = scene.teams.B.color;
  ctx.font = 'bold 18px "Noto Sans SC Local", sans-serif';
  ctx.fillText(scene.teams.B.name, w - 64, 52);
  ctx.fillStyle = '#93a3bb';
  ctx.font = '12px "Noto Sans SC Local", ui-monospace, monospace';
  ctx.fillText(`控制进度 ${state.objectiveHold.B.toFixed(1)}s / 3.0s`, w - 64, 74);
  ctx.textAlign = 'center';
  ctx.fillStyle = state.winner ? '#f3a712' : '#93a3bb';
  ctx.font = `bold ${state.winner ? 20 : 14}px "Noto Sans SC Local", ui-monospace, monospace`;
  ctx.fillText(state.winner ? `${scene.teams[state.winner].name} 已控制核心` : `场景运行中 · ${state.t.toFixed(1)}s`, w / 2, 60);
  ctx.textAlign = 'left';
}

export function validateScene(scene) {
  const errors = [];
  if (!scene || scene.schema !== 'arena-match-scene@1') errors.push('scene schema 不匹配');
  if (!scene?.arena || !scene.arena.objectives?.length) errors.push('缺少目标点');
  for (const team of ['A', 'B']) {
    const units = scene?.teams?.[team]?.units || [];
    if (!units.length) errors.push(`${team} 队没有单位`);
    for (const unit of units) {
      if (!unit.seat?.spawn) errors.push(`${unit.unitId} 缺少出生点`);
      if (!unit.character?.id) errors.push(`${unit.unitId} 缺少角色`);
    }
  }
  const allIds = ['A', 'B'].flatMap((t) => (scene?.teams?.[t]?.units || []).map((u) => u.character.id));
  if (new Set(allIds).size !== allIds.length) errors.push('同一角色出现在两队');
  return { ok: errors.length === 0, errors };
}
