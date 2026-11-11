import {choice, clone, digest, exactKeys, identifier, integer, timestamp} from './value.js';
import {requireValue} from './errors.js';
import {metric} from './catalog.js';
import {filterObservations, preferSources, queryInput} from './query.js';
import {stableSum, statistics} from './windows.js';
import {event} from './state.js';

const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

export function baselineInput(input) {
  exactKeys(input, [
    'id', 'scope', 'station', 'region', 'metric', 'from', 'until',
    'offsetMinutes', 'minimumDays', 'minimumYears', 'includeSuspect', 'selection', 'note',
  ], ['id', 'scope', 'metric', 'from', 'until']);
  const id = identifier(input.id, 'id');
  const scope = choice(input.scope, ['station', 'region'], 'scope');
  const definition = metric(input.metric);
  const from = timestamp(input.from, 'from');
  const until = timestamp(input.until, 'until');
  requireValue(from < until, 'PERIOD', 'Baseline period end must follow start');
  const offsetMinutes = integer(input.offsetMinutes ?? 0, 'offsetMinutes', -840, 840);
  const minimumDays = integer(input.minimumDays ?? 20, 'minimumDays', 2, 366);
  const minimumYears = integer(input.minimumYears ?? 3, 'minimumYears', 1, 100);
  const includeSuspect = input.includeSuspect ?? false;
  requireValue(typeof includeSuspect === 'boolean', 'BOOLEAN', 'includeSuspect must be boolean');
  const selection = choice(input.selection ?? 'preferred', ['all', 'preferred'], 'selection');
  let station = null;
  let region = null;
  if (scope === 'station') {
    requireValue(input.station !== undefined, 'MISSING_FIELD', 'Missing field: station');
    station = identifier(input.station, 'station');
    requireValue(input.region === undefined, 'BASELINE_SCOPE', 'Station baseline cannot carry a region');
  } else {
    requireValue(input.region !== undefined, 'MISSING_FIELD', 'Missing field: region');
    region = identifier(input.region, 'region');
    requireValue(input.station === undefined, 'BASELINE_SCOPE', 'Region baseline cannot carry a station');
  }
  return {
    id, scope, station, region, metric: input.metric, unit: definition.unit,
    aggregation: definition.aggregation, from, until, offsetMinutes,
    minimumDays, minimumYears, includeSuspect, selection, note: input.note ?? null,
  };
}

export function positionInput(input) {
  exactKeys(input, ['baseline', 'station', 'region', 'metric', 'from', 'until', 'values'],
    ['baseline', 'metric', 'from', 'until']);
  const baselineId = identifier(input.baseline, 'baseline');
  metric(input.metric);
  const from = timestamp(input.from, 'from');
  const until = timestamp(input.until, 'until');
  requireValue(from < until, 'PERIOD', 'Position period end must follow start');
  let station = null;
  let region = null;
  if (input.station !== undefined) {
    station = identifier(input.station, 'station');
  }
  if (input.region !== undefined) {
    region = identifier(input.region, 'region');
  }
  const values = input.values ?? null;
  if (values !== null) {
    requireValue(Array.isArray(values) && values.length > 0 && values.length <= 10000,
      'LIMIT', 'values must be a non-empty array of at most 10000 entries');
    for (const entry of values) {
      exactKeys(entry, ['localDate', 'value'], ['localDate', 'value']);
      requireValue(typeof entry.localDate === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(entry.localDate),
        'INVALID_DATE', 'localDate must use YYYY-MM-DD');
      requireValue(typeof entry.value === 'number' && Number.isFinite(entry.value),
        'INVALID_NUMBER', 'value must be finite');
    }
  }
  return {baseline: baselineId, station, region, metric: input.metric, from, until, values};
}

// ---------------------------------------------------------------------------
// 当地日历工具
// ---------------------------------------------------------------------------

function localDateParts(time, offsetMs) {
  const shifted = new Date(Date.parse(time) + offsetMs);
  return {
    localDate: shifted.toISOString().slice(0, 10),
    month: Number(shifted.toISOString().slice(5, 7)),
    year: Number(shifted.toISOString().slice(0, 4)),
  };
}

function monthKey(localDate) {
  return localDate.slice(0, 7);
}

function round6(value) {
  return value === null ? null : Math.round(value * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// 站点日值归并：每个当地日先按来源优先级/质量标记选观测，再按指标口径汇总
// ---------------------------------------------------------------------------

function stationDailyValues(state, stationId, metricName, from, until, params) {
  let rows = filterObservations(state, queryInput({
    station: stationId, metric: metricName, from, until,
  }));
  if (!params.includeSuspect) {
    rows = rows.filter(row => row.quality !== 'suspect');
  }
  if (params.selection === 'preferred') {
    rows = preferSources(state, rows);
  }
  const offsetMs = params.offsetMinutes * 60000;
  const days = new Map();
  for (const row of rows) {
    const parts = localDateParts(row.time, offsetMs);
    if (!days.has(parts.localDate)) {
      days.set(parts.localDate, {rows: [], parts});
    }
    days.get(parts.localDate).rows.push(row);
  }
  const output = [];
  for (const [localDate, group] of [...days.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const values = group.rows.map(row => row.value);
    const stats = statistics(values);
    const value = params.aggregation === 'sum' ? stats.sum : stats.mean;
    output.push({
      localDate,
      month: group.parts.month,
      year: group.parts.year,
      value: round6(value),
      count: values.length,
      measured: group.rows.filter(row => row.quality === 'measured').length,
      estimated: group.rows.filter(row => row.quality === 'estimated').length,
      suspect: group.rows.filter(row => row.quality === 'suspect').length,
      corrected: group.rows.filter(row => row.revision > 1).length,
      late: group.rows.filter(row => row.late).length,
      lineage: group.rows.map(row => ({key: row.key, revision: row.revision, batch: row.batch})),
    });
  }
  return output;
}

// 站点在某个当地月内是否跨有效期边界（启动或停用落在该月内）
function stationSpansMonthBoundary(station, year, month, offsetMs) {
  const monthStart = Date.UTC(year, month - 1, 1) - offsetMs;
  const monthEnd = Date.UTC(year, month, 1) - offsetMs;
  const activeFrom = Date.parse(station.activeFrom);
  const activeUntil = station.activeUntil ? Date.parse(station.activeUntil) : null;
  const startsInside = activeFrom > monthStart && activeFrom < monthEnd;
  const endsInside = activeUntil !== null && activeUntil > monthStart && activeUntil < monthEnd;
  return {partial: startsInside || endsInside, startsInside, endsInside};
}

// ---------------------------------------------------------------------------
// 分布统计：中位数、四分位距、经验分位位置
// ---------------------------------------------------------------------------

function quantile(sorted, p) {
  if (!sorted.length) {
    return null;
  }
  const position = (sorted.length - 1) * p;
  const base = Math.floor(position);
  const rest = position - base;
  if (base + 1 >= sorted.length) {
    return sorted[base];
  }
  return sorted[base] + (sorted[base + 1] - sorted[base]) * rest;
}

export function empiricalPosition(sorted, value) {
  // 经验累积分布位置：小于当前值的比例 + 等于当前值比例的一半（中点秩思路）
  let below = 0;
  let equal = 0;
  for (const item of sorted) {
    if (item < value) {
      below += 1;
    } else if (item === value) {
      equal += 1;
    } else {
      break;
    }
  }
  const n = sorted.length;
  return round6((below + equal / 2) / n);
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = round6(q3 - q1);
  const stats = statistics(values);
  return {
    sorted,
    validDays: sorted.length,
    median: round6(median),
    q1: round6(q1),
    q3: round6(q3),
    iqr,
    min: sorted[0],
    max: sorted.at(-1),
    mean: round6(stats.mean),
    zeroIqr: iqr === 0,
  };
}

// ---------------------------------------------------------------------------
// 基准创建（站点口径）
// ---------------------------------------------------------------------------

function buildStationBaseline(state, params) {
  const station = state.stations[params.station];
  requireValue(station, 'STATION_MISSING', 'Unknown station', {id: params.station});
  const offsetMs = params.offsetMinutes * 60000;
  const daily = stationDailyValues(state, station.id, params.metric, params.from, params.until, params);
  const months = buildMonthlyDistributions(daily, (year, month) =>
    stationSpansMonthBoundary(station, year, month, offsetMs), params);
  const lineage = collectLineage(daily);
  return {months, lineage, stations: [station.id]};
}

function buildMonthlyDistributions(daily, boundaryChecker, params) {
  const byMonth = new Map();
  for (const day of daily) {
    const key = monthKey(day.localDate);
    if (!byMonth.has(key)) {
      byMonth.set(key, []);
    }
    byMonth.get(key).push(day);
  }
  const months = [];
  for (let month = 1; month <= 12; month += 1) {
    const entries = [...byMonth.entries()]
      .filter(([key]) => Number(key.slice(5, 7)) === month)
      .sort(([a], [b]) => a.localeCompare(b));
    const years = entries.map(([key]) => Number(key.slice(0, 4)));
    const allDays = entries.flatMap(([, days]) => days);
    const values = allDays.map(day => day.value);
    const dist = values.length ? distribution(values) : emptyDistribution();
    const boundaryFlags = entries.map(([key]) => {
      const year = Number(key.slice(0, 4));
      return boundaryChecker(year, month);
    });
    const partial = boundaryFlags.some(flag => flag.partial);
    const reasons = [];
    if (dist.validDays < params.minimumDays) {
      reasons.push('insufficient_days');
    }
    if (new Set(years).size < params.minimumYears) {
      reasons.push('insufficient_years');
    }
    if (dist.zeroIqr) {
      reasons.push('zero_iqr');
    }
    if (partial) {
      reasons.push('station_boundary_within_month');
    }
    months.push({
      month,
      years: years.sort((a, b) => a - b),
      yearCount: new Set(years).size,
      ...dist,
      partialMonth: partial,
      boundary: summarizeBoundaries(boundaryFlags),
      // 历史不足或零四分位距时，分布仅作描述用途，不得据此下异常结论
      interpretation: reasons.length ? {usable: false, reasons} : {usable: true, reasons: []},
      daily: allDays.map(({localDate, value, count, measured, estimated, suspect, corrected, late, lineage}) =>
        ({localDate, value, count, measured, estimated, suspect, corrected, late, lineage})),
    });
  }
  return months;
}

function summarizeBoundaries(flags) {
  return {
    startsInside: flags.some(flag => flag.startsInside),
    endsInside: flags.some(flag => flag.endsInside),
  };
}

function emptyDistribution() {
  return {
    sorted: [], validDays: 0, median: null, q1: null, q3: null, iqr: null,
    min: null, max: null, mean: null, zeroIqr: false,
  };
}

function collectLineage(daily) {
  const entries = new Map();
  for (const day of daily) {
    for (const item of day.lineage) {
      entries.set(item.key, item);
    }
  }
  return [...entries.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// 基准创建（区域口径：固定共同站点 + 当期可用站点）
// ---------------------------------------------------------------------------

function regionDailyByStation(state, params) {
  const stations = Object.values(state.stations)
    .filter(station => station.region === params.region)
    .sort((a, b) => a.id.localeCompare(b.id));
  requireValue(stations.length > 0, 'REGION_EMPTY', 'Region has no registered stations');
  const offsetMs = params.offsetMinutes * 60000;
  const perStation = new Map();
  for (const station of stations) {
    const daily = stationDailyValues(state, station.id, params.metric, params.from, params.until, params);
    perStation.set(station.id, {station, daily, byDate: new Map(daily.map(day => [day.localDate, day]))});
  }
  return {stations, perStation, offsetMs};
}

function buildRegionBaseline(state, params) {
  const {stations, perStation, offsetMs} = regionDailyByStation(state, params);
  // 每个（年, 月）实际产出过日值的站点集合
  const monthStations = new Map();
  for (const {station, daily} of perStation.values()) {
    for (const day of daily) {
      const key = monthKey(day.localDate);
      if (!monthStations.has(key)) {
        monthStations.set(key, new Set());
      }
      monthStations.get(key).add(station.id);
    }
  }
  // 固定共同站点：对每个日历月，取该月所有年份都有数据的站点交集；
  // 再取 12 个月的交集作为整区固定面板。
  const commonByMonth = new Map();
  for (let month = 1; month <= 12; month += 1) {
    const keys = [...monthStations.keys()].filter(key => Number(key.slice(5, 7)) === month);
    if (!keys.length) {
      commonByMonth.set(month, new Set());
      continue;
    }
    let intersection = null;
    for (const key of keys) {
      const set = monthStations.get(key);
      intersection = intersection === null ? new Set(set) : new Set([...intersection].filter(id => set.has(id)));
    }
    commonByMonth.set(month, intersection ?? new Set());
  }
  const fixedPanel = stations.map(station => station.id)
    .filter(id => [...commonByMonth.values()].every(set => set.has(id)));
  const fixedSet = new Set(fixedPanel);

  const months = [];
  for (let month = 1; month <= 12; month += 1) {
    const monthKeys = [...monthStations.keys()]
      .filter(key => Number(key.slice(5, 7)) === month)
      .sort((a, b) => a.localeCompare(b));
    const years = monthKeys.map(key => Number(key.slice(0, 4)));
    // 当期可用站点口径：该月出现过任意日值的站点
    const available = new Set();
    for (const key of monthKeys) {
      for (const id of monthStations.get(key)) {
        available.add(id);
      }
    }
    const fixedDaily = [];
    const availableDaily = [];
    const exclusions = [];
    for (const key of monthKeys) {
      const year = Number(key.slice(0, 4));
      for (const localDate of [...monthStations.get(key)].length ? datesForMonthKey(perStation, key) : []) {
        const fixedContributors = [];
        const availableContributors = [];
        for (const station of stations) {
          const day = perStation.get(station.id).byDate.get(localDate);
          if (!day) {
            continue;
          }
          availableContributors.push({station: station.id, value: day.value});
          if (fixedSet.has(station.id)) {
            fixedContributors.push({station: station.id, value: day.value});
          }
        }
        if (fixedContributors.length) {
          fixedDaily.push({localDate, value: combineDay(fixedContributors, params.aggregation),
            stations: fixedContributors.map(item => item.station)});
        }
        if (availableContributors.length) {
          availableDaily.push({localDate, value: combineDay(availableContributors, params.aggregation),
            stations: availableContributors.map(item => item.station)});
        }
      }
      // 显式记录权重排除：固定面板外的站点，以及面板内该月缺数据的站点
      for (const station of stations) {
        const monthHas = monthStations.get(key)?.has(station.id) ?? false;
        const boundary = stationSpansMonthBoundary(station, year, month, offsetMs);
        if (!fixedSet.has(station.id)) {
          exclusions.push({monthKey: key, station: station.id, caliber: 'fixed',
            reason: monthHas ? 'not_in_common_panel' : 'no_observation_in_month', boundary});
        } else if (!monthHas) {
          exclusions.push({monthKey: key, station: station.id, caliber: 'fixed',
            reason: 'missing_this_month', boundary});
        }
      }
    }
    const fixedDist = fixedDaily.length ? distribution(fixedDaily.map(day => day.value)) : emptyDistribution();
    const availableDist = availableDaily.length ? distribution(availableDaily.map(day => day.value)) : emptyDistribution();
    const partial = stations.some(station =>
      monthKeys.some(key => {
        const year = Number(key.slice(0, 4));
        return stationSpansMonthBoundary(station, year, month, offsetMs).partial;
      }));
    months.push({
      month,
      years: years.sort((a, b) => a - b),
      yearCount: new Set(years).size,
      partialMonth: partial,
      fixed: caliberBlock(fixedDist, fixedDaily, fixedPanel, params, new Set(years).size),
      available: caliberBlock(availableDist, availableDaily, [...available].sort(), params, new Set(years).size),
      excludedWeights: exclusions.sort((a, b) =>
        a.monthKey.localeCompare(b.monthKey) || a.station.localeCompare(b.station)),
    });
  }
  const lineage = new Map();
  for (const {daily} of perStation.values()) {
    for (const day of daily) {
      for (const item of day.lineage) {
        lineage.set(item.key, item);
      }
    }
  }
  return {
    months,
    lineage: [...lineage.values()].sort((a, b) => a.key.localeCompare(b.key)),
    stations: stations.map(station => station.id),
    fixedPanel,
  };
}

function datesForMonthKey(perStation, key) {
  const dates = new Set();
  for (const {byDate} of perStation.values()) {
    for (const localDate of byDate.keys()) {
      if (monthKey(localDate) === key) {
        dates.add(localDate);
      }
    }
  }
  return [...dates].sort();
}

function combineDay(contributors, aggregation) {
  const values = contributors.map(item => item.value);
  if (aggregation === 'sum') {
    return round6(stableSum(values));
  }
  return round6(stableSum(values) / values.length);
}

function caliberBlock(dist, daily, stationIds, params, yearCount) {
  const reasons = [];
  if (dist.validDays < params.minimumDays) {
    reasons.push('insufficient_days');
  }
  if (yearCount < params.minimumYears) {
    reasons.push('insufficient_years');
  }
  if (dist.zeroIqr) {
    reasons.push('zero_iqr');
  }
  if (stationIds.length === 0) {
    reasons.push('no_stations');
  }
  return {
    stations: stationIds,
    stationCount: stationIds.length,
    ...dist,
    interpretation: reasons.length ? {usable: false, reasons} : {usable: true, reasons: []},
    daily: daily.map(day => ({localDate: day.localDate, value: day.value, stations: day.stations})),
  };
}

// ---------------------------------------------------------------------------
// 冻结快照与事件
// ---------------------------------------------------------------------------

export function createBaseline(state, input) {
  const params = baselineInput(input);
  requireValue(!state.baselines[params.id], 'BASELINE_EXISTS', 'Baseline id already exists; create a new version instead');
  if (params.scope === 'station') {
    requireValue(state.stations[params.station], 'STATION_MISSING', 'Unknown station');
  } else {
    requireValue(Object.values(state.stations).some(station => station.region === params.region),
      'REGION_EMPTY', 'Region has no registered stations');
  }
  const built = params.scope === 'station' ? buildStationBaseline(state, params) : buildRegionBaseline(state, params);
  const frozenLineage = freezeLineage(state, built.lineage);
  const record = {
    ...params,
    sequence: state.sequence,
    head: state.head,
    frozenAt: new Date().toISOString(),
    stations: built.stations,
    fixedPanel: built.fixedPanel ?? null,
    months: built.months,
    lineage: frozenLineage,
    checksum: digest({params, months: built.months, lineage: frozenLineage}),
    revoked: false,
  };
  return {events: [event('baseline.created', record)], result: {baseline: publicBaseline(record), created: true}};
}

function freezeLineage(state, lineage) {
  return lineage.map(entry => {
    const current = state.observations[entry.key];
    requireValue(current, 'JOURNAL_INVARIANT', 'Lineage observation missing', {key: entry.key}, 500);
    return {
      key: entry.key,
      station: current.station,
      metric: current.metric,
      source: current.source,
      time: current.time,
      revision: current.revision,
      value: current.value,
      unit: current.unit,
      quality: current.quality,
      batch: current.batch,
      late: current.late,
    };
  });
}

export function getBaseline(state, id) {
  identifier(id);
  const record = state.baselines[id];
  requireValue(record, 'BASELINE_MISSING', 'Unknown baseline');
  requireValue(!record.revoked, 'BASELINE_REVOKED', 'Baseline has been revoked');
  requireValue(digest({
    params: baselineParams(record), months: record.months, lineage: record.lineage,
  }) === record.checksum, 'BASELINE_CORRUPT', 'Baseline checksum differs');
  return publicBaseline(record);
}

export function baselineParams(record) {
  const keys = ['id', 'scope', 'station', 'region', 'metric', 'unit', 'aggregation', 'from', 'until',
    'offsetMinutes', 'minimumDays', 'minimumYears', 'includeSuspect', 'selection', 'note'];
  return Object.fromEntries(keys.map(key => [key, record[key]]));
}

export function publicBaseline(record) {
  return clone(record);
}

export function listBaselines(state, input = {}) {
  exactKeys(input, ['scope', 'metric', 'station', 'region', 'includeRevoked'], []);
  return Object.values(state.baselines)
    .filter(record => {
      if (!input.includeRevoked && record.revoked) {
        return false;
      }
      if (input.scope && record.scope !== input.scope) {
        return false;
      }
      if (input.metric && record.metric !== input.metric) {
        return false;
      }
      if (input.station && record.station !== input.station) {
        return false;
      }
      if (input.region && record.region !== input.region) {
        return false;
      }
      return true;
    })
    .map(record => ({
      id: record.id, scope: record.scope, station: record.station, region: record.region,
      metric: record.metric, from: record.from, until: record.until, frozenAt: record.frozenAt,
      sequence: record.sequence, checksum: record.checksum, revoked: record.revoked,
      fixedPanel: record.fixedPanel,
    }))
    .sort((a, b) => a.frozenAt.localeCompare(b.frozenAt) || a.id.localeCompare(b.id));
}

export function revokeBaseline(state, input) {
  exactKeys(input, ['id', 'reason'], ['id', 'reason']);
  const id = identifier(input.id);
  const record = state.baselines[id];
  requireValue(record, 'BASELINE_MISSING', 'Unknown baseline');
  requireValue(typeof input.reason === 'string' && input.reason.trim().length >= 3,
    'REASON', 'Revocation requires an explanation');
  if (record.revoked) {
    return {events: [], result: {id, revoked: true}};
  }
  return {
    events: [event('baseline.revoked', {id, reason: input.reason.trim()})],
    result: {id, revoked: true},
  };
}

// ---------------------------------------------------------------------------
// 当期值在冻结基准中的分位位置（不修改基准）
// ---------------------------------------------------------------------------

export function baselinePosition(state, input) {
  const query = positionInput(input);
  const record = state.baselines[query.baseline];
  requireValue(record, 'BASELINE_MISSING', 'Unknown baseline');
  requireValue(!record.revoked, 'BASELINE_REVOKED', 'Baseline has been revoked');
  requireValue(record.metric === query.metric, 'BASELINE_METRIC', 'Metric does not match baseline');
  const offsetMs = record.offsetMinutes * 60000;
  const values = query.values
    ? externalValues(query, record)
    : ledgerValues(state, query, record, offsetMs);
  const results = values.map(entry => positionForDay(record, entry, offsetMs));
  return {
    baseline: record.id,
    scope: record.scope,
    metric: record.metric,
    unit: record.unit,
    sequence: state.sequence,
    baselineChecksum: record.checksum,
    results,
  };
}

function externalValues(query, record) {
  if (record.scope === 'station') {
    requireValue(query.station, 'BASELINE_SCOPE', 'Station baseline position requires a station');
    requireValue(query.station === record.station, 'BASELINE_SCOPE', 'Station does not match baseline');
  } else {
    requireValue(query.region, 'BASELINE_SCOPE', 'Region baseline position requires a region');
    requireValue(query.region === record.region, 'BASELINE_SCOPE', 'Region does not match baseline');
  }
  return query.values.map(entry => ({localDate: entry.localDate, value: round6(entry.value), source: 'provided'}));
}

function ledgerValues(state, query, record, offsetMs) {
  const params = {
    offsetMinutes: record.offsetMinutes,
    includeSuspect: record.includeSuspect,
    selection: record.selection,
    aggregation: record.aggregation,
  };
  if (record.scope === 'station') {
    const stationId = query.station ?? record.station;
    requireValue(stationId === record.station, 'BASELINE_SCOPE', 'Station does not match baseline');
    requireValue(state.stations[stationId], 'STATION_MISSING', 'Unknown station');
    return stationDailyValues(state, stationId, record.metric, query.from, query.until, params)
      .map(day => ({localDate: day.localDate, value: day.value, source: 'ledger', lineage: day.lineage}));
  }
  const region = query.region ?? record.region;
  requireValue(region === record.region, 'BASELINE_SCOPE', 'Region does not match baseline');
  const {perStation} = regionDailyByStation(state, {...params, region, metric: record.metric, from: query.from, until: query.until});
  const byDate = new Map();
  for (const [stationId, {byDate: stationDates}] of perStation.entries()) {
    for (const [localDate, day] of stationDates) {
      if (!byDate.has(localDate)) {
        byDate.set(localDate, []);
      }
      byDate.get(localDate).push({station: stationId, value: day.value});
    }
  }
  const output = [];
  for (const [localDate, contributors] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    output.push({localDate, value: combineDay(contributors, record.aggregation), source: 'ledger',
      stations: contributors.map(item => item.station)});
  }
  return output;
}

function positionForDay(record, entry, offsetMs) {
  const month = Number(entry.localDate.slice(5, 7));
  const monthBlock = record.months.find(item => item.month === month);
  const base = {localDate: entry.localDate, month, value: entry.value, source: entry.source};
  if (!monthBlock) {
    return {...base, status: 'no_baseline_month', reasons: ['month_missing']};
  }
  if (record.scope === 'station') {
    return stationPosition(monthBlock, base, entry);
  }
  return regionPosition(monthBlock, base, entry);
}

function stationPosition(monthBlock, base, entry) {
  const interpretation = monthBlock.interpretation;
  if (!interpretation.usable) {
    return {...base, status: 'not_classified', reasons: interpretation.reasons,
      median: monthBlock.median, iqr: monthBlock.iqr, validDays: monthBlock.validDays};
  }
  const sorted = monthBlock.sorted;
  const position = empiricalPosition(sorted, entry.value);
  return {
    ...base,
    status: 'classified',
    position,
    median: monthBlock.median,
    q1: monthBlock.q1,
    q3: monthBlock.q3,
    iqr: monthBlock.iqr,
    validDays: monthBlock.validDays,
    anomaly: classifyAnomaly(entry.value, monthBlock),
    deltaFromMedian: round6(entry.value - monthBlock.median),
    partialMonth: monthBlock.partialMonth,
    lineage: entry.lineage ?? null,
  };
}

function regionPosition(monthBlock, base, entry) {
  const output = {...base, calibers: {}};
  for (const caliber of ['fixed', 'available']) {
    const block = monthBlock[caliber];
    if (!block.interpretation.usable) {
      output.calibers[caliber] = {status: 'not_classified', reasons: block.interpretation.reasons,
        median: block.median, iqr: block.iqr, validDays: block.validDays, stationCount: block.stationCount};
      continue;
    }
    output.calibers[caliber] = {
      status: 'classified',
      position: empiricalPosition(block.sorted, entry.value),
      median: block.median, q1: block.q1, q3: block.q3, iqr: block.iqr,
      validDays: block.validDays, stationCount: block.stationCount,
      anomaly: classifyAnomaly(entry.value, block),
      deltaFromMedian: round6(entry.value - block.median),
    };
  }
  output.status = output.calibers.fixed.status === 'classified' || output.calibers.available.status === 'classified'
    ? 'classified' : 'not_classified';
  output.reasons = [...new Set([
    ...(output.calibers.fixed.reasons ?? []),
    ...(output.calibers.available.reasons ?? []),
  ])];
  output.excludedWeights = monthBlock.excludedWeights;
  return output;
}

function classifyAnomaly(value, block) {
  // 仅在四分位距非零时给出方向标签；零 IQR 已在 interpretation 中拦截
  if (block.iqr === 0 || block.iqr === null) {
    return null;
  }
  const lowerFence = block.q1 - 1.5 * block.iqr;
  const upperFence = block.q3 + 1.5 * block.iqr;
  if (value < lowerFence) {
    return 'low_outlier';
  }
  if (value > upperFence) {
    return 'high_outlier';
  }
  if (value < block.q1) {
    return 'below_q1';
  }
  if (value > block.q3) {
    return 'above_q3';
  }
  return 'within_iqr';
}

// ---------------------------------------------------------------------------
// 补数影响：对比两个冻结基准，区分气候/覆盖/补录差异
// ---------------------------------------------------------------------------

export function compareBaselines(state, input) {
  exactKeys(input, ['before', 'after'], ['before', 'after']);
  const beforeId = identifier(input.before, 'before');
  const afterId = identifier(input.after, 'after');
  const before = state.baselines[beforeId];
  const after = state.baselines[afterId];
  requireValue(before, 'BASELINE_MISSING', 'Unknown baseline', {id: beforeId});
  requireValue(after, 'BASELINE_MISSING', 'Unknown baseline', {id: afterId});
  requireValue(before.scope === after.scope && before.metric === after.metric &&
    before.station === after.station && before.region === after.region,
    'BASELINE_COMPARE', 'Baselines must share scope, target and metric');
  const parameterChanges = diffParams(before, after);
  const revisionChanges = diffLineage(before, after);
  const monthChanges = diffMonths(before, after);
  return {
    before: {id: before.id, frozenAt: before.frozenAt, sequence: before.sequence, checksum: before.checksum},
    after: {id: after.id, frozenAt: after.frozenAt, sequence: after.sequence, checksum: after.checksum},
    parameterChanges,
    coverageChange: {
      beforeStations: before.stations,
      afterStations: after.stations,
      added: after.stations.filter(id => !before.stations.includes(id)),
      removed: before.stations.filter(id => !after.stations.includes(id)),
      fixedPanelChanged: JSON.stringify(before.fixedPanel) !== JSON.stringify(after.fixedPanel),
      beforeFixedPanel: before.fixedPanel,
      afterFixedPanel: after.fixedPanel,
    },
    revisionChanges,
    monthChanges,
    interpretation: summarizeAttribution(parameterChanges, revisionChanges, monthChanges),
  };
}

function diffParams(before, after) {
  const keys = ['from', 'until', 'offsetMinutes', 'minimumDays', 'minimumYears', 'includeSuspect', 'selection'];
  const changes = [];
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changes.push({parameter: key, before: before[key], after: after[key]});
    }
  }
  return changes;
}

function diffLineage(before, after) {
  const beforeIndex = new Map(before.lineage.map(item => [item.key, item]));
  const afterIndex = new Map(after.lineage.map(item => [item.key, item]));
  const revised = [];
  const added = [];
  const removed = [];
  for (const [key, item] of afterIndex) {
    const old = beforeIndex.get(key);
    if (!old) {
      added.push({key, revision: item.revision, value: item.value, late: item.late, quality: item.quality});
    } else if (old.revision !== item.revision || old.value !== item.value || old.quality !== item.quality) {
      revised.push({key, before: {revision: old.revision, value: old.value, quality: old.quality},
        after: {revision: item.revision, value: item.value, quality: item.quality}, late: item.late});
    }
  }
  for (const [key, item] of beforeIndex) {
    if (!afterIndex.has(key)) {
      removed.push({key, revision: item.revision, value: item.value});
    }
  }
  return {
    added: added.sort((a, b) => a.key.localeCompare(b.key)),
    revised: revised.sort((a, b) => a.key.localeCompare(b.key)),
    removed: removed.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

function diffMonths(before, after) {
  const changes = [];
  for (let month = 1; month <= 12; month += 1) {
    const b = before.months.find(item => item.month === month);
    const a = after.months.find(item => item.month === month);
    if (before.scope === 'station') {
      changes.push({month, before: monthSummary(b), after: monthSummary(a),
        medianDelta: round6((a.median ?? 0) - (b.median ?? 0)),
        iqrDelta: a.iqr === null || b.iqr === null ? null : round6(a.iqr - b.iqr),
        validDaysDelta: a.validDays - b.validDays});
    } else {
      changes.push({
        month,
        fixed: {before: monthSummary(b.fixed), after: monthSummary(a.fixed),
          medianDelta: safeDelta(a.fixed.median, b.fixed.median), iqrDelta: safeDelta(a.fixed.iqr, b.fixed.iqr),
          validDaysDelta: a.fixed.validDays - b.fixed.validDays,
          stationCountDelta: a.fixed.stationCount - b.fixed.stationCount},
        available: {before: monthSummary(b.available), after: monthSummary(a.available),
          medianDelta: safeDelta(a.available.median, b.available.median),
          iqrDelta: safeDelta(a.available.iqr, b.available.iqr),
          validDaysDelta: a.available.validDays - b.available.validDays,
          stationCountDelta: a.available.stationCount - b.available.stationCount},
      });
    }
  }
  return changes;
}

function safeDelta(a, b) {
  return a === null || b === null ? null : round6(a - b);
}

function monthSummary(block) {
  return {validDays: block.validDays, median: block.median, iqr: block.iqr,
    q1: block.q1, q3: block.q3, usable: block.interpretation.usable, reasons: block.interpretation.reasons,
    stationCount: block.stationCount ?? null};
}

function summarizeAttribution(parameterChanges, revisionChanges, monthChanges) {
  const hasBackfill = revisionChanges.added.length > 0 || revisionChanges.revised.length > 0;
  const hasParameterChange = parameterChanges.length > 0;
  const drivers = [];
  if (hasParameterChange) {
    drivers.push('parameter_change');
  }
  if (hasBackfill) {
    drivers.push('observation_revision_or_backfill');
  }
  const stationShift = monthChanges.some(item =>
    item.fixed ? item.available.stationCountDelta !== 0 || item.fixed.stationCountDelta !== 0 : false);
  if (stationShift) {
    drivers.push('station_coverage_change');
  }
  if (!drivers.length) {
    drivers.push('climate_signal_only');
  }
  return {
    drivers,
    note: 'Differences are decomposed into frozen parameter changes, station coverage changes and observation revisions; ' +
      'medians and IQR shifts alone do not establish an anomaly when interpretation.usable is false.',
  };
}
