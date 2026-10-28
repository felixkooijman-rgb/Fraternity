'use strict';
// Football-data checks that must pass before a poster is rendered.
// Returns { errors: [], warnings: [] }. Errors block rendering unless --force is used.

const MINUTE_MAX = 120;

function formatMinute(m) {
  return m.stoppage ? `${m.minute}+${m.stoppage}'` : `${m.minute}'`;
}

function allPlayers(lineup) {
  return [...(lineup.rows || []).flat(), ...(lineup.subs || [])];
}

function validate(data) {
  const errors = [];
  const warnings = [];
  const { match, goals = [], featured, lineups, display = {} } = data;

  if (!match) return { errors: ['match block is missing'], warnings };
  for (const side of ['home', 'away']) {
    if (!match[side] || !match[side].display) errors.push(`match.${side}.display is missing`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(match.date || '') || isNaN(Date.parse(match.date))) {
    errors.push(`match.date must be YYYY-MM-DD, got "${match.date}"`);
  }
  for (const k of ['stadium', 'competition']) if (!match[k]) errors.push(`match.${k} is missing`);

  // Score must agree with the goal list (goal.team = team credited, also for own goals).
  if (display.showScorers !== false) {
    for (const side of ['home', 'away']) {
      const n = goals.filter((g) => g.team === side).length;
      if (n !== match.score[side]) {
        errors.push(`score says ${side} ${match.score[side]} but ${n} ${side} goals are listed`);
      }
    }
  }

  const types = ['regular', 'penalty', 'own_goal', 'free_kick', 'header'];
  goals.forEach((g, i) => {
    if (!Number.isInteger(g.minute) || g.minute < 1 || g.minute > MINUTE_MAX) errors.push(`goals[${i}] invalid minute ${g.minute}`);
    if (g.stoppage != null && (!Number.isInteger(g.stoppage) || g.stoppage < 1)) errors.push(`goals[${i}] invalid stoppage ${g.stoppage}`);
    if (g.stoppage && ![45, 90, 105, 120].includes(g.minute)) errors.push(`goals[${i}] stoppage time only after 45/90/105/120, got ${formatMinute(g)}`);
    if (!types.includes(g.type || 'regular')) errors.push(`goals[${i}] unknown type ${g.type}`);
    if (!g.display) errors.push(`goals[${i}] display name missing`);
  });
  const sorted = [...goals].sort((a, b) => a.minute - b.minute || (a.stoppage || 0) - (b.stoppage || 0));
  if (sorted.some((g, i) => g !== goals[i])) warnings.push('goals are not in chronological order');

  if (!featured || !featured.player) {
    errors.push('featured.player is missing');
  } else {
    const p = featured.player;
    if (!Number.isInteger(p.number) || p.number < 1 || p.number > 99) errors.push(`featured.player.number must be 1-99, got ${p.number}`);
    if (!p.display) errors.push('featured.player.display is missing');
    const mom = featured.moment;
    if (mom && mom.kind === 'goal') {
      const hit = goals.find((g) => g.display === p.display && g.team === p.team && g.minute === mom.minute && (g.stoppage || 0) === (mom.stoppage || 0));
      if (!hit) errors.push(`featured moment ${formatMinute(mom)} is not a goal by ${p.display} in the goal list`);
    }
    if (lineups && lineups[p.team]) {
      const surname = p.display.toLowerCase();
      const inXI = (lineups[p.team].rows || []).flat().some((n) => n.toLowerCase().includes(surname));
      const onBench = (lineups[p.team].subs || []).some((n) => n.toLowerCase().includes(surname));
      if (!inXI && !onBench) errors.push(`featured player ${p.display} is not in the ${p.team} matchday squad`);
      if (p.started === true && !inXI) errors.push(`featured player marked as starter but not in the ${p.team} XI`);
      if (p.started === false && inXI) errors.push(`featured player marked as substitute but listed in the ${p.team} XI`);
    }
  }

  if (lineups && display.showLineups !== false) {
    for (const side of ['home', 'away']) {
      const l = lineups[side];
      if (!l) { errors.push(`lineups.${side} missing`); continue; }
      const xi = (l.rows || []).flat();
      if (xi.length !== 11) errors.push(`lineups.${side} has ${xi.length} starters, expected 11`);
      const all = allPlayers(l).map((n) => n.toLowerCase());
      const dup = all.filter((n, i) => all.indexOf(n) !== i);
      if (dup.length) errors.push(`lineups.${side} lists players twice: ${dup.join(', ')}`);
      if (l.formation && l.formation.status !== 'official') warnings.push(`lineups.${side} formation ${l.formation.value} is ${l.formation.status}; it is not printed as fact`);
      // Every scorer of this side must have been in the matchday squad (own goals excepted).
      for (const g of goals.filter((x) => x.team === side && x.type !== 'own_goal')) {
        if (!all.some((n) => n.includes(g.display.toLowerCase()))) errors.push(`scorer ${g.display} not found in ${side} squad`);
      }
    }
  }

  const v = data.verification || {};
  (v.needs_manual_check || []).forEach((m) => warnings.push(`MANUAL CHECK: ${m}`));
  if (!(v.sources || []).length) errors.push('verification.sources is empty – every poster needs its sources');

  return { errors, warnings };
}

module.exports = { validate, formatMinute };
