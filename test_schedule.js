#!/usr/bin/env node
/**
 * MoldMainte スケジュールアルゴリズム 自動テストスイート
 * ========================================================
 *
 * 使い方:
 *   node test_schedule.js
 *
 * 目的:
 *   - buildAllShifts の全ステップ（①〜⑧）を網羅検証
 *   - UI側の4直目表示条件・DEADLINE OVER件数整合性を検証
 *   - 異常データ耐性・性能検証を実施
 *   - 回帰バグの早期発見
 *
 * 終了コード:
 *   0: 全テスト合格
 *   1: 1件以上失敗
 */

'use strict';

// ============================================================
// セクション1: 計算ヘルパー関数（index.html から抽出）
// ============================================================

function isShotUnregistered(mold) {
  return !mold.maint_shot_updated_at && !mold.last_shot_updated_at;
}

function calcEstimatedShot(mold, now, dandoriConfigured, dandoriMoldIdSet) {
  const baseShot = mold.maint_shot !== undefined ? (mold.maint_shot || 0) : (mold.current_shot || 0);
  const lastUpdated = mold.maint_shot_updated_at || mold.last_shot_updated_at || mold.updated_at;
  const cycleTime = mold.cycle_time_sec || 30;
  if (!lastUpdated) return baseShot;
  if (dandoriConfigured && !dandoriMoldIdSet.has(mold.id)) return baseShot;
  const elapsedSec = (now.getTime() - new Date(lastUpdated).getTime()) / 1000;
  if (elapsedSec < 0 || elapsedSec > 86400 * 30) return baseShot;
  return baseShot + Math.floor(Math.max(0, elapsedSec) / cycleTime);
}

function calcStatus(mold, now, dc, dms) {
  const estimated = calcEstimatedShot(mold, now, dc, dms);
  const interval = mold.maintenance_interval || 5000;
  if (estimated >= interval) return 'overdue';
  const remaining = Math.max(0, interval - estimated);
  const cyc = mold.cycle_time_sec > 0 ? mold.cycle_time_sec : 30;
  const remainingMin = Math.round(remaining * cyc / 60);
  const lv3 = mold.alert_min_danger || 60;
  const lv2 = mold.alert_min_warning || 120;
  if (remainingMin <= lv3) return 'danger';
  if (remainingMin <= lv2) return 'warning';
  return 'normal';
}

function calcEstimatedRemaining(m, n, dc, dms) {
  return Math.max(0, (m.maintenance_interval || 5000) - calcEstimatedShot(m, n, dc, dms));
}

function calcOverShot(m, n, dc, dms) {
  return Math.max(0, calcEstimatedShot(m, n, dc, dms) - (m.maintenance_interval || 5000));
}

// ============================================================
// セクション2: buildAllShifts（index.html と同一ロジック）
// ============================================================

function buildAllShifts(state, dandoriData, now) {
  const nowMs = now.getTime();
  const SHIFT_ORDER = ['1S', '2S', '3S'];
  const FALLBACK_CYCLE = 30;

  // ① 業務日基点（08:00起点）
  const workdayBase = new Date(now);
  if (now.getHours() < 8) workdayBase.setDate(workdayBase.getDate() - 1);
  workdayBase.setHours(8, 0, 0, 0);

  function makeShiftRangeByOffset(shiftName, offsetHours) {
    const start = new Date(workdayBase.getTime() + offsetHours * 3600000);
    const end = new Date(start.getTime() + 8 * 3600000);
    return { shiftName, start, end };
  }

  // ② 直範囲生成
  const nowH = now.getHours();
  const realtimeShift = nowH >= 8 && nowH < 16 ? '1S' : nowH >= 16 ? '2S' : '3S';
  const curIdx = SHIFT_ORDER.indexOf(realtimeShift);
  const shiftRanges = [
    makeShiftRangeByOffset(SHIFT_ORDER[curIdx % 3], curIdx * 8),
    makeShiftRangeByOffset(SHIFT_ORDER[(curIdx + 1) % 3], (curIdx + 1) * 8),
    makeShiftRangeByOffset(SHIFT_ORDER[(curIdx + 2) % 3], (curIdx + 2) * 8),
    makeShiftRangeByOffset(SHIFT_ORDER[curIdx % 3], (curIdx + 3) * 8),
  ];
  const totalEndMs = shiftRanges[3].end.getTime();
  const cursorBase = Math.max(nowMs, shiftRanges[0].start.getTime());

  // ③ 段取りフィルタ
  const machineNoToId = {};
  (state.machines || []).forEach(mc => { machineNoToId[String(mc.machine_no)] = mc.id; });
  const allDandoriMolds = state.molds.filter(mold => {
    const mcId = mold.machine_id || machineNoToId[String(mold.machine_no)];
    if (!mcId) return false;
    return dandoriData[mcId] === mold.id;
  });
  const dandoriConfigured = Object.keys(dandoriData).length > 0;
  const dandoriMoldIdSet = new Set(Object.values(dandoriData).filter(Boolean));

  const unregisteredMolds = allDandoriMolds.filter(mold => isShotUnregistered(mold));

  // ④ deadlineMs計算
  const STATUS_LEVEL = { overdue: 4, danger: 3, warning: 2, normal: 1 };
  const entries = allDandoriMolds
    .filter(mold => !isShotUnregistered(mold))
    .map(mold => {
      const cycSec = mold.cycle_time_sec > 0 ? mold.cycle_time_sec : FALLBACK_CYCLE;
      const status = calcStatus(mold, now, dandoriConfigured, dandoriMoldIdSet);
      const dur = (mold.simple_maint_time_min || 20) * 60000;
      const remShot = calcEstimatedRemaining(mold, now, dandoriConfigured, dandoriMoldIdSet);
      const overShot = calcOverShot(mold, now, dandoriConfigured, dandoriMoldIdSet);
      const deadlineMs = status === 'overdue' ? nowMs - overShot * cycSec * 1000 : nowMs + remShot * cycSec * 1000;
      const overElapsedMs = status === 'overdue' ? overShot * cycSec * 1000 : 0;
      return { mold, status, dur, deadlineMs, overElapsedMs, cycSec, lap: 1, deadlineOver: false };
    })
    .filter(e => e.status === 'overdue' || e.deadlineMs < totalEndMs);

  // ⑤ 優先順位ソート
  entries.sort((a, b) => {
    const la = STATUS_LEVEL[a.status];
    const lb = STATUS_LEVEL[b.status];
    if (la !== lb) return lb - la;
    if (a.status === 'overdue') return b.overElapsedMs - a.overElapsedMs;
    return a.deadlineMs - b.deadlineMs;
  });

  // ⑥-a 後方逆算
  const latestStart = new Array(entries.length);
  let backCursor = totalEndMs;
  for (let i = entries.length - 1; i >= 0; i--) {
    latestStart[i] = Math.min(entries[i].deadlineMs, backCursor - entries[i].dur);
    backCursor = Math.min(backCursor, latestStart[i]);
  }

  // ⑥-b 前向き貪欲配置＋unplacedMolds蓄積
  let cursor = cursorBase;
  const placed = [];
  const unplacedMolds = [];
  const MAX_ENTRIES = 300;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const startMs = Math.max(cursor, latestStart[i]);
    const endMs = startMs + e.dur;
    if (startMs >= totalEndMs) {
      unplacedMolds.push(e.mold);
      continue;
    }
    placed.push({ ...e, startMs, endMs, deadlineOver: (e.status !== 'overdue') && (startMs > e.deadlineMs) });
    cursor = endMs;
  }

  // ⑦ 複数回メンテ展開（隙間挿入方式）
  let expandIdx = 0;
  while (expandIdx < placed.length && placed.length < MAX_ENTRIES) {
    const e = placed[expandIdx++];
    const interval = e.mold.maintenance_interval || 5000;
    const cycSec = e.mold.cycle_time_sec > 0 ? e.mold.cycle_time_sec : FALLBACK_CYCLE;
    const nextDeadline = e.endMs + interval * cycSec * 1000;
    if (nextDeadline >= totalEndMs) continue;

    let nextStart = Math.max(e.endMs, nextDeadline);
    const sortedPlaced = placed.slice().sort((a, b) => a.startMs - b.startMs);
    for (const p of sortedPlaced) {
      if (p.endMs <= nextStart) continue;
      if (p.startMs >= nextStart + e.dur) break;
      nextStart = p.endMs;
    }

    const nextEnd = nextStart + e.dur;
    if (nextStart >= totalEndMs) continue;
    cursor = Math.max(cursor, nextEnd);
    placed.push({
      mold: e.mold, status: 'normal', dur: e.dur, deadlineMs: nextDeadline,
      overElapsedMs: 0, cycSec, lap: e.lap + 1,
      deadlineOver: nextStart > nextDeadline, startMs: nextStart, endMs: nextEnd,
    });

  }

  // ⑧ 直への振り分け・直またぎ処理
  const result = shiftRanges.map(sr => ({
    shiftName: sr.shiftName, shiftStart: sr.start, shiftEnd: sr.end, scheduled: [],
  }));
  const lastEndInShift = shiftRanges.map(sr => sr.start.getTime());

  for (const e of placed) {
    for (let ri = 0; ri < shiftRanges.length; ri++) {
      const sr = shiftRanges[ri];
      const srStartMs = sr.start.getTime();
      const srEndMs = sr.end.getTime();
      if (e.startMs < srStartMs || e.startMs >= srEndMs) continue;

      if (e.endMs <= srEndMs) {
        result[ri].scheduled.push({ ...e, crossShift: false, isContinuation: false });
        lastEndInShift[ri] = Math.max(lastEndInShift[ri], e.endMs);
        break;
      }

      // 前倒し
      const pullbackStart = srEndMs - e.dur;
      if (pullbackStart >= lastEndInShift[ri]) {
        e.startMs = pullbackStart;
        e.endMs = srEndMs;
        result[ri].scheduled.push({ ...e, crossShift: false, isContinuation: false });
        lastEndInShift[ri] = srEndMs;
        break;
      }

      // 次直先頭に移動
      const nextSr = shiftRanges[ri + 1];
      if (nextSr) {
        const movedEnd = nextSr.start.getTime() + e.dur;
        const canMove = e.status === 'overdue'
          ? movedEnd <= nextSr.end.getTime()
          : movedEnd <= e.deadlineMs && movedEnd <= nextSr.end.getTime();
        if (canMove) {
          e.startMs = nextSr.start.getTime();
          e.endMs = movedEnd;
          result[ri + 1].scheduled.push({ ...e, crossShift: false, isContinuation: false });
          lastEndInShift[ri + 1] = Math.max(lastEndInShift[ri + 1], movedEnd);
          break;
        }
      }

      // 直またぎ許容
      result[ri].scheduled.push({ ...e, crossShift: true, isContinuation: false });
      lastEndInShift[ri] = srEndMs;
      if (nextSr) {
        const contEntry = { ...e, startMs: nextSr.start.getTime() };
        result[ri + 1].scheduled.unshift({ ...contEntry, crossShift: true, isContinuation: true, fromShift: sr.shiftName });
        lastEndInShift[ri + 1] = Math.max(lastEndInShift[ri + 1], nextSr.start.getTime() + (e.endMs - srEndMs));
      }
      break;
    }
  }

  result.unregisteredMolds = unregisteredMolds;
  result.unplacedMolds = unplacedMolds;
  result.entries = entries;
  result.placed = placed;
  return result;
}

// ============================================================
// セクション3: UI表示条件（index.html renderScheduleBody と同一）
// ============================================================

function shouldShow4th(shiftData) {
  // 4直目は直またぎ/継続がある場合のみ表示（旧仕様に戻した）
  return shiftData.scheduled.some(s => s.isContinuation || s.crossShift);
}

function countDeadlineOverForBanner(allData) {
  // 4直目非表示時はそのエントリをカウント除外（画面表示と整合）
  return allData.reduce((n, d, i) => {
    if (i === 3 && !d.scheduled.some(s => s.isContinuation || s.crossShift)) return n;
    return n + d.scheduled.filter(s => s.deadlineOver && !s.isContinuation).length;
  }, 0);
}

// ============================================================
// セクション4: テストフレームワーク（依存なし）
// ============================================================

let passCount = 0;
let failCount = 0;
let currentGroup = '';
const failures = [];

function group(name) {
  currentGroup = name;
  console.log('\n▼ ' + name);
}

function expect(description, condition, expected) {
  const ok = !!condition;
  if (ok) {
    passCount++;
    console.log('  ✅ ' + description);
  } else {
    failCount++;
    failures.push(`[${currentGroup}] ${description} (期待: ${expected})`);
    console.log('  ❌ ' + description + ' (期待: ' + expected + ')');
  }
}

function assertEqual(description, actual, expected) {
  expect(description, actual === expected, expected);
}

function countByShift(r) {
  const counts = [0, 0, 0, 0];
  r.placed.forEach(p => {
    for (let i = 0; i < 4; i++) {
      if (p.startMs >= r.shiftRanges[i].start.getTime() && p.startMs < r.shiftRanges[i].end.getTime()) {
        counts[i]++;
        break;
      }
    }
  });
  return counts;
}

// ============================================================
// セクション5: テストケース
// ============================================================

console.log('═══════════════════════════════════════════════════════════');
console.log('  MoldMainte スケジュールアルゴリズム 自動テストスイート');
console.log('═══════════════════════════════════════════════════════════');

// ---------- ステップ① 業務日基点 ----------
group('ステップ① 業務日基点の境界条件');
{
  const testAt = (h, m) => {
    const now = new Date(2026, 3, 16, h, m);
    const base = new Date(now);
    if (now.getHours() < 8) base.setDate(base.getDate() - 1);
    base.setHours(8, 0, 0, 0);
    return base.getDate();
  };
  assertEqual('00:00 → 前日', testAt(0, 0), 15);
  assertEqual('07:59 → 前日', testAt(7, 59), 15);
  assertEqual('08:00 ちょうど → 当日', testAt(8, 0), 16);
  assertEqual('08:01 → 当日', testAt(8, 1), 16);
  assertEqual('15:59 → 当日', testAt(15, 59), 16);
  assertEqual('16:00 → 当日', testAt(16, 0), 16);
  assertEqual('23:59 → 当日', testAt(23, 59), 16);
}

// ---------- ステップ② 直範囲生成 ----------
group('ステップ② 直範囲生成');
{
  const testShift = (h) => {
    const r = buildAllShifts({ machines: [], molds: [] }, {}, new Date(2026, 3, 16, h, 0));
    return r[0].shiftName;
  };
  assertEqual('10:00 → 1S', testShift(10), '1S');
  assertEqual('18:00 → 2S', testShift(18), '2S');
  assertEqual('02:00 → 3S', testShift(2), '3S');
  assertEqual('07:00 → 3S', testShift(7), '3S');
  assertEqual('08:00 → 1S', testShift(8), '1S');
  assertEqual('16:00 → 2S', testShift(16), '2S');
  assertEqual('23:00 → 2S', testShift(23), '2S');
  assertEqual('00:00 → 3S', testShift(0), '3S');
}

// ---------- ステップ③ 段取りフィルタ ----------
group('ステップ③ 段取りフィルタ');
{
  const now = new Date(2026, 3, 16, 10, 0);
  const updated = new Date(now.getTime() - 3600000).toISOString();
  const baseMold = (id, mid, mno) => ({
    id, machine_id: mid, machine_no: mno,
    maintenance_interval: 3000, cycle_time_sec: 30,
    maint_shot: 100, maint_shot_updated_at: updated,
    simple_maint_time_min: 20,
  });

  // 段取り空
  const r1 = buildAllShifts(
    { machines: [{ id: 'm1', machine_no: '1' }], molds: [baseMold('A', 'm1', '1')] },
    {}, now
  );
  assertEqual('段取り空 → entries=0', r1.entries.length, 0);

  // 段取り1件
  const r2 = buildAllShifts(
    { machines: [{ id: 'm1', machine_no: '1' }], molds: [baseMold('A', 'm1', '1')] },
    { m1: 'A' }, now
  );
  assertEqual('段取り1件 → entries=1', r2.entries.length, 1);

  // 全機停止
  const r3 = buildAllShifts(
    { machines: [{ id: 'm1', machine_no: '1' }], molds: [baseMold('A', 'm1', '1')] },
    { m1: null }, now
  );
  assertEqual('全機停止 → entries=0', r3.entries.length, 0);

  // machine_noフォールバック
  const r4 = buildAllShifts(
    { machines: [{ id: 'm1', machine_no: '1' }], molds: [{ ...baseMold('A', null, '1'), machine_id: null }] },
    { m1: 'A' }, now
  );
  assertEqual('machine_noフォールバック → entries=1', r4.entries.length, 1);

  // 存在しないmold_id
  const r5 = buildAllShifts(
    { machines: [{ id: 'm1', machine_no: '1' }], molds: [baseMold('A', 'm1', '1')] },
    { m1: 'XXX' }, now
  );
  assertEqual('存在しないmold_id → entries=0', r5.entries.length, 0);
}

// ---------- ステップ④ deadlineMs計算 ----------
group('ステップ④ deadlineMs計算');
{
  const now = new Date(2026, 3, 16, 10, 0);
  const updated = new Date(now.getTime() - 3600000).toISOString();

  // normal: rem=2880 → deadline = now + 24h
  const r1 = buildAllShifts(
    { machines: [{ id: 'm1', machine_no: '1' }],
      molds: [{ id: 'A', machine_id: 'm1', machine_no: '1',
        maintenance_interval: 3000, cycle_time_sec: 30,
        maint_shot: 0, maint_shot_updated_at: updated, simple_maint_time_min: 20 }] },
    { m1: 'A' }, now
  );
  const expected1 = now.getTime() + 2880 * 30 * 1000;
  expect('normal deadline=now+24h', Math.abs(r1.entries[0].deadlineMs - expected1) < 2000, '±2sec');

  // overdue: deadline = now - 経過超過分
  const updated2 = new Date(now.getTime() - 2 * 3600000).toISOString();
  const r2 = buildAllShifts(
    { machines: [{ id: 'm1', machine_no: '1' }],
      molds: [{ id: 'A', machine_id: 'm1', machine_no: '1',
        maintenance_interval: 100, cycle_time_sec: 30,
        maint_shot: 100, maint_shot_updated_at: updated2, simple_maint_time_min: 20 }] },
    { m1: 'A' }, now
  );
  expect('overdue deadline=過去時刻', r2.entries[0].deadlineMs < now.getTime(), '過去');

  // FALLBACK cycle (0 → 30)
  const r3 = buildAllShifts(
    { machines: [{ id: 'm1', machine_no: '1' }],
      molds: [{ id: 'A', machine_id: 'm1', machine_no: '1',
        maintenance_interval: 3000, cycle_time_sec: 0,
        maint_shot: 0, maint_shot_updated_at: updated, simple_maint_time_min: 20 }] },
    { m1: 'A' }, now
  );
  expect('cycle=0 → FALLBACK 30で計算', r3.entries.length === 1, '1件');

  // maint_shot_updated_at null → 未登録扱い
  const r4 = buildAllShifts(
    { machines: [{ id: 'm1', machine_no: '1' }],
      molds: [{ id: 'A', machine_id: 'm1', machine_no: '1',
        maintenance_interval: 3000, cycle_time_sec: 30,
        maint_shot: 0, maint_shot_updated_at: null, simple_maint_time_min: 20 }] },
    { m1: 'A' }, now
  );
  assertEqual('updated_at=null → unregistered', r4.unregisteredMolds.length, 1);
}

// ---------- ステップ⑤ 優先順位ソート ----------
group('ステップ⑤ 優先順位ソート');
{
  const now = new Date(2026, 3, 16, 10, 0);
  const updated = new Date(now.getTime() - 3600000).toISOString();
  // 両方とも totalEndMs(32h) 内に deadline が来るように調整
  const state = {
    machines: [{ id: 'm1', machine_no: '1' }, { id: 'm2', machine_no: '2' }],
    molds: [
      // N: warning (残り少なめ、deadline数時間後)
      { id: 'N', machine_id: 'm1', machine_no: '1', maintenance_interval: 300, cycle_time_sec: 30, maint_shot: 100, maint_shot_updated_at: updated, simple_maint_time_min: 20 },
      // O: overdue
      { id: 'O', machine_id: 'm2', machine_no: '2', maintenance_interval: 100, cycle_time_sec: 30, maint_shot: 1000, maint_shot_updated_at: updated, simple_maint_time_min: 20 },
    ]
  };
  const r = buildAllShifts(state, { m1: 'N', m2: 'O' }, now);
  expect('overdueがNに先行する', r.entries.length >= 2 && r.entries[0].mold.id === 'O', 'O先頭');
  expect('Nも含まれる', r.entries.some(e => e.mold.id === 'N'), 'N含有');
}

// ---------- ステップ⑥ 配置アルゴリズム ----------
group('ステップ⑥ 配置アルゴリズム（後方逆算＋前向き貪欲）');
{
  const now = new Date(2026, 3, 16, 10, 0);
  const updated = new Date(now.getTime() - 3600000).toISOString();

  // 1件配置
  const r1 = buildAllShifts(
    { machines: [{ id: 'm1', machine_no: '1' }],
      molds: [{ id: 'A', machine_id: 'm1', machine_no: '1',
        maintenance_interval: 3000, cycle_time_sec: 30,
        maint_shot: 0, maint_shot_updated_at: updated, simple_maint_time_min: 20 }] },
    { m1: 'A' }, now
  );
  expect('1件配置成功', r1.placed.length >= 1, '>=1');
  assertEqual('deadlineOver=false', r1.placed[0].deadlineOver, false);

  // 配置できる金型がない
  const r2 = buildAllShifts({ machines: [], molds: [] }, {}, now);
  assertEqual('空 → placed=0', r2.placed.length, 0);
  assertEqual('空 → unplaced=0', r2.unplacedMolds.length, 0);
}

// ---------- ステップ⑦ 複数回メンテ展開 ----------
group('ステップ⑦ 複数回メンテ展開');
{
  const now = new Date(2026, 3, 16, 9, 0);
  const updated = new Date(now.getTime() - 3600000).toISOString();

  // 短周期 → 複数展開
  const r1 = buildAllShifts(
    { machines: [{ id: 'm1', machine_no: '1' }],
      molds: [{ id: 'A', machine_id: 'm1', machine_no: '1',
        maintenance_interval: 100, cycle_time_sec: 30,
        maint_shot: 0, maint_shot_updated_at: updated, simple_maint_time_min: 20 }] },
    { m1: 'A' }, now
  );
  expect('短周期で複数展開', r1.placed.length > 1, '>1');
  expect('MAX_ENTRIES=300以下', r1.placed.length <= 300, '<=300');

  // 長周期 → 1回で終わり（24時間以上周期）
  const r2 = buildAllShifts(
    { machines: [{ id: 'm1', machine_no: '1' }],
      molds: [{ id: 'A', machine_id: 'm1', machine_no: '1',
        maintenance_interval: 3000, cycle_time_sec: 30,
        maint_shot: 100, maint_shot_updated_at: updated, simple_maint_time_min: 20 }] },
    { m1: 'A' }, now
  );
  // interval=3000 × 30秒 = 25時間周期 → lap1のみ
  assertEqual('長周期でlap1のみ', r2.placed.length, 1);
  assertEqual('lap=1', r2.placed[0] ? r2.placed[0].lap : null, 1);

  // 隙間挿入：2回目が他金型の配置より前のdeadlineを持つ場合、隙間に挿入されること
  // 金型A: cycle=60sec, interval=180shot → 3時間周期
  // 金型B: cycle=60sec, interval=500shot → 8.3時間周期
  // now=09:00、Aはoverdue(200shot超過)、Bは残り500shot
  // 期待: Aの1回目→09:00付近、Aの2回目→12:00付近（Bの15時台より前の隙間に挿入）
  {
    const now3 = new Date(2026, 3, 16, 9, 0);
    const aUpdated = new Date(now3.getTime() - 200 * 60 * 1000).toISOString(); // 200分前=overdue
    const bUpdated = new Date(now3.getTime() - 0).toISOString();
    const r3 = buildAllShifts(
      { machines: [{ id: 'ma', machine_no: '5' }, { id: 'mb', machine_no: '6' }],
        molds: [
          { id: 'A', machine_id: 'ma', machine_no: '5', maintenance_interval: 180,
            cycle_time_sec: 60, maint_shot: 180, maint_shot_updated_at: aUpdated, simple_maint_time_min: 30 },
          { id: 'B', machine_id: 'mb', machine_no: '6', maintenance_interval: 500,
            cycle_time_sec: 60, maint_shot: 0, maint_shot_updated_at: bUpdated, simple_maint_time_min: 30 },
        ] },
      { ma: 'A', mb: 'B' }, now3
    );
    const a2 = r3.placed.find(p => p.mold.id === 'A' && p.lap === 2);
    const bEntry = r3.placed.find(p => p.mold.id === 'B' && p.lap === 1);
    // Aの2回目はBの1回目より前に挿入されるべき
    expect('隙間挿入: Aの2回目はBの前に配置', a2 && bEntry && a2.startMs < bEntry.startMs, true);
    // Aの2回目はdeadlineoverにならない
    expect('隙間挿入: Aの2回目はdeadlineOver=false', a2 && !a2.deadlineOver, true);
  }
}

// ---------- ステップ⑧ 直またぎ処理 ----------
group('ステップ⑧ 直またぎ処理');
{
  const now = new Date(2026, 3, 16, 15, 30); // 15:30 (1S、あと30分)
  const updated = new Date(now.getTime() - 30 * 60000).toISOString();

  // 直境界付近での直またぎ
  const r = buildAllShifts(
    { machines: [{ id: 'm1', machine_no: '1' }],
      molds: [{ id: 'A', machine_id: 'm1', machine_no: '1',
        maintenance_interval: 60, cycle_time_sec: 30,
        maint_shot: 30, maint_shot_updated_at: updated, simple_maint_time_min: 40 }] },
    { m1: 'A' }, now
  );
  expect('所要40分の金型を配置', r.placed.length >= 1, '>=1');
}

// ---------- バグA修正検証: 4直目表示条件 ----------
group('4直目表示条件（バグA修正／旧仕様復帰）');
{
  // 継続なし＆crossShiftなし → 非表示
  expect('通常エントリのみ → 非表示',
    !shouldShow4th({ scheduled: [{ isContinuation: false, crossShift: false, lap: 5 }] }),
    '非表示');

  // 継続あり → 表示
  expect('継続あり → 表示',
    shouldShow4th({ scheduled: [{ isContinuation: true, crossShift: true }] }),
    '表示');

  // crossShift → 表示
  expect('crossShift → 表示',
    shouldShow4th({ scheduled: [{ isContinuation: false, crossShift: true }] }),
    '表示');

  // 空 → 非表示
  expect('空 → 非表示',
    !shouldShow4th({ scheduled: [] }),
    '非表示');

  // 継続＋通常混在 → 表示
  expect('継続＋通常混在 → 表示',
    shouldShow4th({ scheduled: [
      { isContinuation: true, crossShift: true },
      { isContinuation: false, crossShift: false, lap: 5 }
    ]}),
    '表示');
}

// ---------- バグ修正検証: DEADLINE OVER件数整合性 ----------
group('DEADLINE OVER件数整合性（4直目非表示時の除外）');
{
  // 4直目非表示 → 4直目の件数を除外
  const case1 = [
    { scheduled: [{ deadlineOver: true, isContinuation: false, crossShift: false }] },
    { scheduled: [{ deadlineOver: true, isContinuation: false, crossShift: false }] },
    { scheduled: [] },
    { scheduled: [
      { deadlineOver: true, isContinuation: false, crossShift: false, lap: 5 },
      { deadlineOver: true, isContinuation: false, crossShift: false, lap: 6 }
    ]}, // 4直目（継続なし）
  ];
  assertEqual('4直目非表示 → 4直目分を除外', countDeadlineOverForBanner(case1), 2);

  // 4直目表示（継続あり） → 4直目もカウント
  const case2 = [
    { scheduled: [{ deadlineOver: true, isContinuation: false, crossShift: false }] },
    { scheduled: [] },
    { scheduled: [] },
    { scheduled: [
      { isContinuation: true, crossShift: true, deadlineOver: false },
      { deadlineOver: true, isContinuation: false, crossShift: false }
    ]},
  ];
  assertEqual('4直目表示 → 4直目DLoverもカウント', countDeadlineOverForBanner(case2), 2);

  // 継続エントリはカウント除外
  const case3 = [
    { scheduled: [] },
    { scheduled: [{ deadlineOver: true, isContinuation: false, crossShift: true }] }, // 元
    { scheduled: [{ deadlineOver: true, isContinuation: true, crossShift: true }] }, // 継続
    { scheduled: [] },
  ];
  assertEqual('継続エントリ除外 → 1件', countDeadlineOverForBanner(case3), 1);

  // 全て0の場合
  const case4 = [
    { scheduled: [] }, { scheduled: [] }, { scheduled: [] }, { scheduled: [] },
  ];
  assertEqual('空データ → 0件', countDeadlineOverForBanner(case4), 0);
}

// ---------- バグB修正検証: unplacedMolds ----------
group('unplacedMolds：物理制約で配置できなかった金型の追跡');
{
  const now = new Date(2026, 3, 16, 10, 0);
  const updated = new Date(now.getTime() - 3600000).toISOString();

  // 100金型（32時間に収まらない）
  const state = { machines: [], molds: [] };
  for (let i = 0; i < 100; i++) {
    state.machines.push({ id: 'm' + i, machine_no: String(i) });
    state.molds.push({
      id: 'M' + i, machine_id: 'm' + i, machine_no: String(i),
      maintenance_interval: 3000, cycle_time_sec: 30,
      maint_shot: 2800, maint_shot_updated_at: updated,
      simple_maint_time_min: 20,
    });
  }
  const dandori = Object.fromEntries(state.machines.map(m => [m.id, 'M' + m.id.substring(1)]));
  const r = buildAllShifts(state, dandori, now);

  expect('配置+未配置=100', r.placed.filter(p => p.lap === 1).length + r.unplacedMolds.length === 100, '=100');
  expect('一部がunplacedMolds', r.unplacedMolds.length > 0, '>0');
  expect('unplacedMoldsはarray', Array.isArray(r.unplacedMolds), 'Array');

  // 1件のみ → unplaced=0
  const r2 = buildAllShifts(
    { machines: [{ id: 'm1', machine_no: '1' }],
      molds: [{ id: 'A', machine_id: 'm1', machine_no: '1',
        maintenance_interval: 3000, cycle_time_sec: 30,
        maint_shot: 100, maint_shot_updated_at: updated, simple_maint_time_min: 20 }] },
    { m1: 'A' }, now
  );
  assertEqual('1件収まる → unplaced=0', r2.unplacedMolds.length, 0);
}

// ---------- 異常データ耐性 ----------
group('異常データ耐性');
{
  const now = new Date(2026, 3, 16, 10, 0);
  const updated = new Date(now.getTime() - 3600000).toISOString();

  // 負のinterval
  expect('負のinterval でもクラッシュしない', (() => {
    try {
      const r = buildAllShifts(
        { machines: [{ id: 'm1', machine_no: '1' }],
          molds: [{ id: 'A', machine_id: 'm1', machine_no: '1',
            maintenance_interval: -100, cycle_time_sec: 30,
            maint_shot: 0, maint_shot_updated_at: updated, simple_maint_time_min: 20 }] },
        { m1: 'A' }, now
      );
      return r.placed.length <= 300; // MAX_ENTRIESで打ち切り
    } catch (e) { return false; }
  })(), 'クラッシュなし');

  // 極大ショット数
  expect('極大ショット数でもクラッシュしない', (() => {
    try {
      const r = buildAllShifts(
        { machines: [{ id: 'm1', machine_no: '1' }],
          molds: [{ id: 'A', machine_id: 'm1', machine_no: '1',
            maintenance_interval: 3000, cycle_time_sec: 30,
            maint_shot: 99999999, maint_shot_updated_at: updated, simple_maint_time_min: 20 }] },
        { m1: 'A' }, now
      );
      return r !== null;
    } catch (e) { return false; }
  })(), 'クラッシュなし');

  // 空DB
  const r1 = buildAllShifts({ machines: [], molds: [] }, {}, now);
  assertEqual('空DB → placed=0', r1.placed.length, 0);
  assertEqual('空DB → unregistered=0', r1.unregisteredMolds.length, 0);
  assertEqual('空DB → unplaced=0', r1.unplacedMolds.length, 0);
}

// ---------- 性能検証 ----------
group('性能検証');
{
  const now = new Date(2026, 3, 16, 10, 0);
  const updated = new Date(now.getTime() - 3600000).toISOString();
  const state = { machines: [], molds: [] };
  for (let i = 0; i < 500; i++) {
    state.machines.push({ id: 'mx' + i, machine_no: String(1000 + i) });
    state.molds.push({
      id: 'MX' + i, machine_id: 'mx' + i, machine_no: String(1000 + i),
      maintenance_interval: 3000, cycle_time_sec: 30,
      maint_shot: 100, maint_shot_updated_at: updated, simple_maint_time_min: 20,
    });
  }
  const dandori = Object.fromEntries(state.machines.map(m => [m.id, 'MX' + m.id.substring(2)]));
  const start = Date.now();
  const r = buildAllShifts(state, dandori, now);
  const elapsed = Date.now() - start;
  expect('500金型が1秒以内', elapsed < 1000, '<1000ms');
  console.log('    実行時間: ' + elapsed + 'ms / placed=' + r.placed.length + ' unplaced=' + r.unplacedMolds.length);
}

// ---------- 結果サマリー ----------
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  テスト結果サマリー');
console.log('═══════════════════════════════════════════════════════════');
console.log('  Pass:   ' + passCount);
console.log('  Fail:   ' + failCount);
console.log('  Total:  ' + (passCount + failCount));

if (failCount > 0) {
  console.log('\n❌ 失敗したテスト:');
  failures.forEach(f => console.log('  - ' + f));
  console.log('\n⚠️ テストに失敗しました。修正が必要です。');
  process.exit(1);
} else {
  console.log('\n✅ 全テスト合格！');
  process.exit(0);
}
