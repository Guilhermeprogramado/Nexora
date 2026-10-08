// Motor de accrue diario.
//
// REGRA IMPORTANTE (ver README): o valor creditado aqui vem da
// daily_rate do plano. Em simulation_mode = '1' essa taxa e uma CHAMADA DE
// CONFIGURACAO, nao rentabilidade de mercado — nao existe investimento que
// entregue 2.5% ao dia de forma sustentada. Todo campo deste modulo e
// rotulado como simulacao na interface.
//
// Formula: accrue do dia = principal × (rate / 100). Juros simples, sem
// capitalizacao — o dia seguinte incide sobre o principal, nao sobre o
// principal mais o lucro. E o que o calculador da landing promete, entao o
// motor entrega exatamente isso.
//
// Idempotencia: UNIQUE(position_id, accrual_date) + INSERT OR IGNORE. Rodar
// duas vezes no mesmo dia nao credita duas vezes.

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const A = Date.parse(a + 'T00:00:00Z');
  const B = Date.parse(b + 'T00:00:00Z');
  if (!Number.isFinite(A) || !Number.isFinite(B)) return 0;
  return Math.round((B - A) / 86400000);
}

function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

/**
 * Abre uma posicao para um deposito aprovado.
 */
function openPosition(db, { userId, depositId, planId, principal, rate, durationDays, planName }) {
  const p = round2(principal);
  if (!(p > 0)) throw new Error('Principal invalido');
  if (!(Number(rate) > 0)) throw new Error('Taxa invalida');
  const days = parseInt(durationDays, 10);
  if (!Number.isInteger(days) || days < 1) throw new Error('Duracao invalida');

  const ins = db.prepare(`INSERT INTO positions
    (user_id, deposit_id, plan_id, plan_name, principal, daily_rate, duration_days, started_on)
    VALUES (?, ?, ?, ?, ?, ?, ?, date('now'))`);
  const info = ins.run(userId, depositId ?? null, planId ?? null, String(planName), p, Number(rate), days);
  return db.prepare('SELECT * FROM positions WHERE id = ?').get(Number(info.lastInsertRowid));
}

/**
 * Calcula quanto rendera uma posicao ate uma data, sem gravar nada.
 * Usado por /api/my/positions e pelo admin.
 */
function projectPosition(pos, onDate) {
  const rate = Number(pos.daily_rate) || 0;
  const days = parseInt(pos.duration_days, 10) || 0;
  const paid = Number(pos.days_paid) || 0;
  const elapsed = daysBetween(pos.started_on, onDate || todayStr());
  const earnedDays = Math.max(0, Math.min(days, Math.max(elapsed, paid)));
  const daily = round2(Number(pos.principal) * (rate / 100));
  return {
    daily_amount: daily,
    earned_days: earnedDays,
    remaining_days: Math.max(0, days - earnedDays),
    projected_total: round2(Number(pos.principal) + daily * earnedDays),
    projected_profit: round2(daily * earnedDays)
  };
}

/**
 * Credita os dias vencidos de todas as posicoes ativas.
 * @returns {{credited:number, gross:number, positions:Array}}
 */
function runAccruals(db, opts = {}) {
  const onDate = opts.onDate || todayStr();
  const sim = db.transaction(() => {
    const rows = db
      .prepare("SELECT * FROM positions WHERE status = 'active' ORDER BY id ASC")
      .all();
    let credited = 0;
    let gross = 0;
    const touched = [];

    for (const pos of rows) {
      const rate = Number(pos.daily_rate) || 0;
      const total = parseInt(pos.duration_days, 10) || 0;
      const paid = Number(pos.days_paid) || 0;
      const daily = round2(Number(pos.principal) * (rate / 100));

      // Dia 0 nao paga: started_on e o dia de abertura.
      let elapsed = daysBetween(pos.started_on, onDate);
      let due = elapsed - paid;
      if (!(due > 0)) continue;

      let remaining = Math.max(0, total - paid);
      if (due > remaining) due = remaining;

      // Uma linha em accruals e UMA transacao por dia. Creditar 6 dias de
      // uma vez precisa gerar 6 transacoes, senao o extrato do usuario nao
      // bate com o ledger e a reconciliacao fica impossivel.
      const creditedDays = [];
      for (let n = 0; n < due; n++) {
        const dayNumber = paid + n + 1;
        const accrualDate = addDays(pos.started_on, dayNumber);
        const r = db
          .prepare(`INSERT OR IGNORE INTO accruals
            (position_id, accrual_date, day_number, principal, rate, amount)
            VALUES (?, ?, ?, ?, ?, ?)`)
          .run(pos.id, accrualDate, dayNumber, pos.principal, rate, daily);
        if (r.changes === 0) continue; // ja creditado nesse dia

        creditedDays.push(dayNumber);
        credited++;
        gross += daily;
      }

      if (creditedDays.length === 0) continue;

      for (const dayNumber of creditedDays) {
        const dateStr = addDays(pos.started_on, dayNumber);
        db.prepare(`INSERT INTO transactions (user_id, type, amount, detail) VALUES (?, 'accrual', ?, ?)`)
          .run(pos.user_id, daily,
            'Rendimento (SIMULADO) ' + pos.plan_name + ' dia ' + dayNumber + '/' + total + ' — ' + dateStr);
      }

      // Sincroniza o contador pelo que realmente foi gravado.
      const newPaid = Number(
        db.prepare('SELECT COALESCE(MAX(day_number), 0) AS m FROM accruals WHERE position_id = ?')
          .get(pos.id).m
      );
      const newAccrued = round2(
        Number(db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM accruals WHERE position_id = ?').get(pos.id).s)
      );

      db.prepare("UPDATE users SET balance = balance + ?, total_earnings = total_earnings + ? WHERE id = ?")
        .run(daily * Math.max(0, newPaid - paid), daily * Math.max(0, newPaid - paid), pos.user_id);

      if (newPaid !== paid || newAccrued !== Number(pos.accrued)) {
        const finished = newPaid >= total;
        db.prepare('UPDATE positions SET days_paid = ?, accrued = ?, status = ?, closed_at = ? WHERE id = ?')
          .run(newPaid, newAccrued, finished ? 'closed' : 'active', finished ? onDate : null, pos.id);
        touched.push({ id: pos.id, user_id: pos.user_id, days_paid: newPaid, accrued: newAccrued, finished });
      }
    }

    return { credited, gross: round2(gross), positions: touched };
  });

  return sim();
}

function addDays(dateStr, n) {
  const d = Date.parse(dateStr + 'T00:00:00Z') + n * 86400000;
  return new Date(d).toISOString().slice(0, 10);
}

module.exports = { openPosition, runAccruals, projectPosition, round2, todayStr, daysBetween };