import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Ledger} from '../src/service.js';
import {empiricalPosition} from '../src/baselines.js';
import {code} from './helpers.js';

async function newLedger(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'field-baseline-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return new Ledger(root);
}

// 生成确定性合成温度序列：年-月-日决定均值，站点间有固定偏差
function temperatureAt(year, month, day, stationBias = 0) {
  const seasonal = 15 + 12 * Math.sin((month - 4) / 12 * 2 * Math.PI);
  const yearly = (year - 2020) * 0.8;
  const dailyNoise = ((day * 7 + month * 13) % 5) - 2;
  return Math.round((seasonal + yearly + dailyNoise + stationBias) * 100) / 100;
}

async function seedStation(ledger, {sourceId = 'src1', stationId = 'st1', region = 'r1',
  years = [2020, 2021, 2022], priority = 100, activeFrom, activeUntil, bias = 0} = {}) {
  await ledger.registerSource({id: sourceId, name: `Source ${sourceId}`, region,
    metrics: ['temperature', 'rainfall'], priority});
  await ledger.registerStation({id: stationId, name: `Station ${stationId}`, region,
    latitude: 30, longitude: 120, sources: [sourceId],
    activeFrom: activeFrom ?? `${years[0]}-01-01T00:00:00Z`, activeUntil});
  const records = [];
  for (const year of years) {
    for (let month = 1; month <= 12; month += 1) {
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
      for (let day = 1; day <= days; day += 1) {
        const mm = String(month).padStart(2, '0');
        const dd = String(day).padStart(2, '0');
        records.push({
          station: stationId, metric: 'temperature',
          time: `${year}-${mm}-${dd}T00:00:00Z`, revision: 1,
          value: temperatureAt(year, month, day, bias), unit: 'C',
        });
      }
    }
  }
  // 分批入库，避免单批超过上限
  const chunkSize = 500;
  for (let index = 0; index < records.length; index += chunkSize) {
    await ledger.ingest({
      id: `${sourceId}-${stationId}-${index / chunkSize}`, source: sourceId,
      receivedAt: '2023-06-01T00:00:00Z',
      records: records.slice(index, index + chunkSize),
    });
  }
  return records;
}

test('station baseline aggregates local days then builds monthly distributions with median and IQR', async t => {
  const ledger = await newLedger(t);
  await seedStation(ledger);
  const created = await ledger.createBaseline({
    id: 'base1', scope: 'station', station: 'st1', metric: 'temperature',
    from: '2020-01-01T00:00:00Z', until: '2023-01-01T00:00:00Z',
    minimumDays: 20, minimumYears: 3,
  }, 'analyst');
  assert.equal(created.created, true);
  const baseline = await ledger.baseline('base1');
  assert.equal(baseline.months.length, 12);
  const january = baseline.months.find(item => item.month === 1);
  assert.equal(january.validDays, 93);
  assert.equal(january.yearCount, 3);
  assert.equal(january.interpretation.usable, true);
  assert.equal(typeof january.median, 'number');
  assert.equal(typeof january.iqr, 'number');
  assert.ok(january.iqr > 0);
  assert.equal(january.daily.length, 93);
  assert.equal(january.boundary.startsInside, false);
  // 冻结了输入修订与参数
  assert.equal(baseline.frozenAt !== null, true);
  assert.equal(baseline.lineage.length, 366 + 365 + 365);
  assert.equal(baseline.lineage.every(item => item.revision === 1), true);
  assert.equal(baseline.checksum.length, 64);
});

test('baseline id cannot be recreated; backfill requires a new baseline and leaves the old one unchanged', async t => {
  const ledger = await newLedger(t);
  await seedStation(ledger);
  const input = {id: 'freeze1', scope: 'station', station: 'st1', metric: 'temperature',
    from: '2020-01-01T00:00:00Z', until: '2023-01-01T00:00:00Z'};
  await ledger.createBaseline(input, 'analyst');
  await assert.rejects(ledger.createBaseline(input, 'analyst'), code('BASELINE_EXISTS'));
  const before = await ledger.baseline('freeze1');
  // 补录：修订 1 月某日观测
  const target = before.months.find(item => item.month === 1).daily[0];
  await ledger.ingest({id: 'backfill', source: 'src1', receivedAt: '2023-07-01T00:00:00Z',
    records: [{station: 'st1', metric: 'temperature', time: `${target.localDate}T00:00:00Z`,
      revision: 2, value: 42, unit: 'C'}]});
  const afterOld = await ledger.baseline('freeze1');
  assert.equal(afterOld.checksum, before.checksum);
  assert.deepEqual(afterOld.months, before.months);
  // 新建基准包含补录值
  const second = await ledger.createBaseline({...input, id: 'freeze2'}, 'analyst');
  assert.equal(second.created, true);
  const compare = await ledger.compareBaselines({before: 'freeze1', after: 'freeze2'});
  assert.equal(compare.revisionChanges.revised.length, 1);
  assert.equal(compare.revisionChanges.revised[0].after.revision, 2);
  assert.ok(compare.interpretation.drivers.includes('observation_revision_or_backfill'));
});

test('insufficient history and zero IQR block anomaly conclusions rather than fabricating them', async t => {
  const ledger = await newLedger(t);
  await ledger.registerSource({id: 's', name: 'S', region: 'r1', metrics: ['temperature']});
  await ledger.registerStation({id: 'p', name: 'P', region: 'r1', latitude: 1, longitude: 1,
    sources: ['s'], activeFrom: '2020-01-01T00:00:00Z'});
  // 仅两年、且每日完全相同 -> 零 IQR
  const records = [];
  for (const year of [2020, 2021]) {
    for (let month = 1; month <= 12; month += 1) {
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
      for (let day = 1; day <= days; day += 1) {
        records.push({station: 'p', metric: 'temperature',
          time: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00Z`,
          revision: 1, value: 20, unit: 'C'});
      }
    }
  }
  for (let index = 0; index < records.length; index += 500) {
    await ledger.ingest({id: `b${index}`, source: 's', receivedAt: '2022-01-01T00:00:00Z',
      records: records.slice(index, index + 500)});
  }
  await ledger.createBaseline({id: 'thin', scope: 'station', station: 'p', metric: 'temperature',
    from: '2020-01-01T00:00:00Z', until: '2022-01-01T00:00:00Z', minimumYears: 3}, 'analyst');
  const baseline = await ledger.baseline('thin');
  const january = baseline.months.find(item => item.month === 1);
  assert.equal(january.interpretation.usable, false);
  assert.ok(january.interpretation.reasons.includes('insufficient_years'));
  assert.ok(january.interpretation.reasons.includes('zero_iqr'));
  const position = await ledger.baselinePosition({baseline: 'thin', metric: 'temperature',
    station: 'p', from: '2022-01-01T00:00:00Z', until: '2022-01-02T00:00:00Z',
    values: [{localDate: '2022-01-01', value: 25}]});
  assert.equal(position.results[0].status, 'not_classified');
  assert.ok(position.results[0].reasons.includes('zero_iqr'));
  assert.equal(position.results[0].anomaly, undefined);
});

test('station starting or stopping inside a local month is flagged as partial, never as an anomaly', async t => {
  const ledger = await newLedger(t);
  await seedStation(ledger, {stationId: 'st1', activeFrom: '2020-01-15T00:00:00Z'});
  await ledger.createBaseline({id: 'partial', scope: 'station', station: 'st1', metric: 'temperature',
    from: '2020-01-01T00:00:00Z', until: '2023-01-01T00:00:00Z'}, 'analyst');
  const baseline = await ledger.baseline('partial');
  const january2020 = baseline.months.find(item => item.month === 1);
  assert.equal(january2020.partialMonth, true);
  assert.equal(january2020.boundary.startsInside, true);
  assert.ok(january2020.interpretation.reasons.includes('station_boundary_within_month'));
});

test('empirical position and IQR fences classify current-season values', async t => {
  const ledger = await newLedger(t);
  await seedStation(ledger);
  await ledger.createBaseline({id: 'pos', scope: 'station', station: 'st1', metric: 'temperature',
    from: '2020-01-01T00:00:00Z', until: '2023-01-01T00:00:00Z'}, 'analyst');
  const baseline = await ledger.baseline('pos');
  const july = baseline.months.find(item => item.month === 7);
  const extreme = await ledger.baselinePosition({baseline: 'pos', metric: 'temperature',
    station: 'st1',
    from: '2024-07-01T00:00:00Z', until: '2024-07-02T00:00:00Z',
    values: [{localDate: '2024-07-01', value: july.q3 + 2 * july.iqr}]});
  assert.equal(extreme.results[0].status, 'classified');
  assert.equal(extreme.results[0].anomaly, 'high_outlier');
  assert.ok(extreme.results[0].position > 0.9);
  const medianValue = await ledger.baselinePosition({baseline: 'pos', metric: 'temperature',
    station: 'st1', from: '2024-07-01T00:00:00Z', until: '2024-07-02T00:00:00Z',
    values: [{localDate: '2024-07-01', value: july.median}]});
  assert.equal(medianValue.results[0].anomaly, 'within_iqr');
  // 经验分位位置的纯函数性质
  assert.equal(empiricalPosition([1, 2, 3, 4], 1), 0.125);
  assert.equal(empiricalPosition([1, 2, 3, 4], 4), 0.875);
});

test('rainfall uses daily sum while temperature uses daily mean', async t => {
  const ledger = await newLedger(t);
  await ledger.registerSource({id: 's', name: 'S', region: 'r1', metrics: ['rainfall', 'temperature']});
  await ledger.registerStation({id: 'p', name: 'P', region: 'r1', latitude: 1, longitude: 1,
    sources: ['s'], activeFrom: '2020-01-01T00:00:00Z'});
  await ledger.ingest({id: 'r1', source: 's', receivedAt: '2020-01-02T00:00:00Z', records: [
    {station: 'p', metric: 'rainfall', time: '2020-01-01T00:00:00Z', revision: 1, value: 3, unit: 'mm'},
    {station: 'p', metric: 'rainfall', time: '2020-01-01T01:00:00Z', revision: 1, value: 5, unit: 'mm'},
    {station: 'p', metric: 'temperature', time: '2020-01-01T00:00:00Z', revision: 1, value: 10, unit: 'C'},
    {station: 'p', metric: 'temperature', time: '2020-01-01T01:00:00Z', revision: 1, value: 20, unit: 'C'},
  ]});
  await ledger.createBaseline({id: 'rain', scope: 'station', station: 'p', metric: 'rainfall',
    from: '2020-01-01T00:00:00Z', until: '2020-02-01T00:00:00Z', minimumDays: 2, minimumYears: 1}, 'a');
  await ledger.createBaseline({id: 'temp', scope: 'station', station: 'p', metric: 'temperature',
    from: '2020-01-01T00:00:00Z', until: '2020-02-01T00:00:00Z', minimumDays: 2, minimumYears: 1}, 'a');
  const rain = await ledger.baseline('rain');
  const temp = await ledger.baseline('temp');
  assert.equal(rain.months.find(item => item.month === 1).daily[0].value, 8);
  assert.equal(temp.months.find(item => item.month === 1).daily[0].value, 15);
});

test('suspect observations and source priority follow the shared selection rules', async t => {
  const ledger = await newLedger(t);
  await ledger.registerSource({id: 'low', name: 'low', region: 'r1', metrics: ['temperature'], priority: 100});
  await ledger.registerSource({id: 'high', name: 'high', region: 'r1', metrics: ['temperature'], priority: 1});
  await ledger.registerStation({id: 'p', name: 'P', region: 'r1', latitude: 1, longitude: 1,
    sources: ['low', 'high'], activeFrom: '2020-01-01T00:00:00Z'});
  const records = [
    {station: 'p', metric: 'temperature', time: '2020-01-01T00:00:00Z', revision: 1, value: 10, unit: 'C'},
    {station: 'p', metric: 'temperature', time: '2020-01-02T00:00:00Z', revision: 1, value: 12, unit: 'C'},
  ];
  await ledger.ingest({id: 'b-low', source: 'low', receivedAt: '2020-01-03T00:00:00Z', records});
  // 高优先级来源：1 号为 measured，2 号为 suspect
  await ledger.ingest({id: 'b-high', source: 'high', receivedAt: '2020-01-03T00:00:00Z', records: [
    {...records[0], value: 50},
    {...records[1], value: 52, quality: 'suspect'},
  ]});
  await ledger.createBaseline({id: 'pref', scope: 'station', station: 'p', metric: 'temperature',
    from: '2020-01-01T00:00:00Z', until: '2020-01-03T00:00:00Z', minimumDays: 2, minimumYears: 1}, 'a');
  const baseline = await ledger.baseline('pref');
  const january = baseline.months.find(item => item.month === 1);
  // 1 号：高优先级 measured 50 胜出；2 号：suspect 被排除，回落到 low 的 12
  assert.deepEqual(january.daily.map(day => day.value), [50, 12]);
  assert.equal(january.daily[1].suspect, 0);
  const withSuspect = await ledger.createBaseline({id: 'pref2', scope: 'station', station: 'p',
    metric: 'temperature', from: '2020-01-01T00:00:00Z', until: '2020-01-03T00:00:00Z',
    minimumDays: 2, minimumYears: 1, includeSuspect: true, selection: 'all'}, 'a');
  const allDays = withSuspect.baseline.months.find(item => item.month === 1).daily;
  // selection=all 时同一当地日的两个来源观测都参与均值
  assert.deepEqual(allDays.map(day => day.value), [30, 32]);
  assert.equal(allDays[0].count, 2);
  assert.equal(allDays[1].suspect, 1);
});

test('region baseline keeps fixed common stations and currently available stations as separate calibers', async t => {
  const ledger = await newLedger(t);
  // 老站点：三年完整数据
  await seedStation(ledger, {sourceId: 's1', stationId: 'old1', years: [2020, 2021, 2022], bias: 0});
  await seedStation(ledger, {sourceId: 's2', stationId: 'old2', years: [2020, 2021, 2022], bias: 2});
  // 新加高频站：只有 2022 年数据
  await seedStation(ledger, {sourceId: 's3', stationId: 'new1', years: [2022], bias: 5,
    activeFrom: '2022-01-01T00:00:00Z'});
  const created = await ledger.createBaseline({id: 'region1', scope: 'region', region: 'r1',
    metric: 'temperature', from: '2020-01-01T00:00:00Z', until: '2023-01-01T00:00:00Z'}, 'analyst');
  assert.deepEqual(created.baseline.fixedPanel.sort(), ['old1', 'old2']);
  const baseline = await ledger.baseline('region1');
  const january = baseline.months.find(item => item.month === 1);
  assert.deepEqual(january.fixed.stations.sort(), ['old1', 'old2']);
  assert.ok(january.available.stations.includes('new1'));
  assert.equal(january.available.stationCount, 3);
  // 排除权重被显式记录
  const newStationExclusions = january.excludedWeights.filter(item => item.station === 'new1' && item.caliber === 'fixed');
  assert.ok(newStationExclusions.length >= 1);
  assert.ok(newStationExclusions.every(item =>
    item.reason === 'not_in_common_panel' || item.reason === 'no_observation_in_month'));
  // 两个口径的中位数不同（覆盖变化的可复算证据）
  assert.notEqual(january.fixed.median, january.available.median);
  // 区域分位位置同时给两种口径
  const position = await ledger.baselinePosition({baseline: 'region1', metric: 'temperature',
    region: 'r1', from: '2024-01-01T00:00:00Z', until: '2024-01-02T00:00:00Z',
    values: [{localDate: '2024-01-01', value: 30}]});
  assert.ok(position.results[0].calibers.fixed);
  assert.ok(position.results[0].calibers.available);
});

test('region position can recompute directly from ledger observations', async t => {
  const ledger = await newLedger(t);
  await seedStation(ledger, {sourceId: 's1', stationId: 'old1', years: [2020, 2021, 2022]});
  await seedStation(ledger, {sourceId: 's2', stationId: 'old2', years: [2020, 2021, 2022], bias: 2});
  await ledger.createBaseline({id: 'reg', scope: 'region', region: 'r1', metric: 'temperature',
    from: '2020-01-01T00:00:00Z', until: '2023-01-01T00:00:00Z'}, 'analyst');
  // 当期数据直接从账本读取，不提供 values
  const position = await ledger.baselinePosition({baseline: 'reg', metric: 'temperature',
    region: 'r1', from: '2022-06-01T00:00:00Z', until: '2022-06-03T00:00:00Z'});
  assert.equal(position.results.length, 2);
  assert.equal(position.results.every(item => item.source === 'ledger'), true);
  assert.ok(position.results.every(item => item.calibers.fixed.status === 'classified'));
});

test('empty fixed panel degrades safely and never emits an anomaly verdict', async t => {
  const ledger = await newLedger(t);
  // 两个站点各只覆盖不同的年份 -> 没有共同面板
  await seedStation(ledger, {sourceId: 's1', stationId: 'a', years: [2020]});
  await seedStation(ledger, {sourceId: 's2', stationId: 'b', years: [2021], bias: 3});
  await ledger.createBaseline({id: 'nopanel', scope: 'region', region: 'r1', metric: 'temperature',
    from: '2020-01-01T00:00:00Z', until: '2022-01-01T00:00:00Z', minimumYears: 1}, 'analyst');
  const baseline = await ledger.baseline('nopanel');
  assert.deepEqual(baseline.fixedPanel, []);
  const january = baseline.months.find(item => item.month === 1);
  assert.equal(january.fixed.interpretation.usable, false);
  assert.ok(january.fixed.interpretation.reasons.includes('no_stations'));
  // 当期可用口径在该月汇集了两个站点、两个年份的有效日值，仍可独立使用
  assert.equal(january.available.interpretation.usable, true);
  assert.equal(january.available.stationCount, 2);
  assert.equal(january.yearCount, 2);
  const position = await ledger.baselinePosition({baseline: 'nopanel', metric: 'temperature',
    region: 'r1', from: '2024-01-01T00:00:00Z', until: '2024-01-02T00:00:00Z',
    values: [{localDate: '2024-01-01', value: 40}]});
  assert.equal(position.results[0].calibers.fixed.anomaly, undefined);
  assert.equal(position.results[0].calibers.fixed.status, 'not_classified');
  assert.equal(position.results[0].status, 'classified');
});

test('region comparison separates coverage change from backfill and climate movement', async t => {
  const ledger = await newLedger(t);
  await seedStation(ledger, {sourceId: 's1', stationId: 'old1', years: [2020, 2021, 2022]});
  await ledger.createBaseline({id: 'v1', scope: 'region', region: 'r1', metric: 'temperature',
    from: '2020-01-01T00:00:00Z', until: '2023-01-01T00:00:00Z'}, 'analyst');
  // 新站加入后再建基准
  await seedStation(ledger, {sourceId: 's2', stationId: 'new1', years: [2022], bias: 4,
    activeFrom: '2022-01-01T00:00:00Z'});
  await ledger.createBaseline({id: 'v2', scope: 'region', region: 'r1', metric: 'temperature',
    from: '2020-01-01T00:00:00Z', until: '2023-01-01T00:00:00Z'}, 'analyst');
  const compare = await ledger.compareBaselines({before: 'v1', after: 'v2'});
  assert.deepEqual(compare.coverageChange.added, ['new1']);
  assert.equal(compare.coverageChange.fixedPanelChanged, false);
  assert.deepEqual(compare.revisionChanges.revised, []);
  // 固定口径的月中位数在两版之间保持稳定（证明区域均值上升来自覆盖变化而非气候）
  const january = compare.monthChanges.find(item => item.month === 1);
  assert.equal(january.fixed.medianDelta, 0);
  assert.notEqual(january.available.medianDelta, 0);
});

test('frozen baseline lineage and checksum survive subsequent revisions and verify stays valid', async t => {
  const ledger = await newLedger(t);
  await seedStation(ledger);
  await ledger.createBaseline({id: 'frozen', scope: 'station', station: 'st1', metric: 'temperature',
    from: '2020-01-01T00:00:00Z', until: '2023-01-01T00:00:00Z'}, 'analyst');
  const baseline = await ledger.baseline('frozen');
  const entry = baseline.lineage[0];
  await ledger.ingest({id: 'rev', source: 'src1', receivedAt: '2023-08-01T00:00:00Z',
    records: [{station: 'st1', metric: 'temperature', time: entry.time, revision: 2, value: 40, unit: 'C'}]});
  const reloaded = await ledger.baseline('frozen');
  assert.equal(reloaded.checksum, baseline.checksum);
  const frozenEntry = reloaded.lineage.find(item => item.key === entry.key);
  assert.equal(frozenEntry.revision, 1);
  assert.equal(frozenEntry.value, entry.value);
  const verify = await ledger.verify();
  assert.equal(verify.valid, true);
  assert.equal(verify.business.findings.length, 0);
  const audit = await ledger.audit({operation: 'baseline.create'});
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, 'analyst');
});

test('baseline listing filters and revocation hides it by default', async t => {
  const ledger = await newLedger(t);
  await seedStation(ledger);
  await ledger.createBaseline({id: 'b1', scope: 'station', station: 'st1', metric: 'temperature',
    from: '2020-01-01T00:00:00Z', until: '2023-01-01T00:00:00Z'}, 'a');
  await ledger.createBaseline({id: 'b2', scope: 'station', station: 'st1', metric: 'rainfall',
    from: '2020-01-01T00:00:00Z', until: '2023-01-01T00:00:00Z', minimumDays: 2, minimumYears: 1}, 'a');
  assert.equal((await ledger.baselines()).length, 2);
  assert.equal((await ledger.baselines({metric: 'rainfall'})).length, 1);
  await ledger.revokeBaseline({id: 'b1', reason: 'superseded by corrected baseline'}, 'a');
  assert.equal((await ledger.baselines()).length, 1);
  assert.equal((await ledger.baselines({includeRevoked: true})).length, 2);
  await assert.rejects(ledger.baseline('b1'), code('BASELINE_REVOKED'));
});

test('baseline validates scope, period, local month offset and metric compatibility', async t => {
  const ledger = await newLedger(t);
  await seedStation(ledger);
  await assert.rejects(ledger.createBaseline({id: 'x', scope: 'station', metric: 'temperature',
    from: '2020-01-01T00:00:00Z', until: '2023-01-01T00:00:00Z'}, 'a'), code('MISSING_FIELD'));
  await assert.rejects(ledger.createBaseline({id: 'x', scope: 'station', station: 'st1', region: 'r1',
    metric: 'temperature', from: '2020-01-01T00:00:00Z', until: '2023-01-01T00:00:00Z'}, 'a'),
    code('BASELINE_SCOPE'));
  await assert.rejects(ledger.createBaseline({id: 'x', scope: 'station', station: 'ghost',
    metric: 'temperature', from: '2020-01-01T00:00:00Z', until: '2023-01-01T00:00:00Z'}, 'a'),
    code('STATION_MISSING'));
  await ledger.createBaseline({id: 'off', scope: 'station', station: 'st1', metric: 'temperature',
    from: '2020-01-01T00:00:00Z', until: '2023-01-01T00:00:00Z', offsetMinutes: 480}, 'a');
  const shifted = await ledger.baseline('off');
  assert.equal(shifted.offsetMinutes, 480);
  await assert.rejects(ledger.baselinePosition({baseline: 'off', metric: 'rainfall',
    from: '2024-01-01T00:00:00Z', until: '2024-01-02T00:00:00Z',
    values: [{localDate: '2024-01-01', value: 1}]}), code('BASELINE_METRIC'));
});
