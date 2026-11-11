import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Ledger} from './service.js';
const root = await mkdtemp(path.join(os.tmpdir(), 'field-ledger-demo-'));
try {
  const ledger = new Ledger(root);
  await ledger.registerSource({id: 'cooperative', name: 'Synthetic cooperative', region: 'delta', metrics: ['rainfall']});
  await ledger.registerStation({id: 'plot1', name: 'Synthetic plot', region: 'delta', latitude: 10, longitude: 20,
    sources: ['cooperative'], activeFrom: '2026-01-01T00:00:00Z'});
  const batch = {id: 'day1', source: 'cooperative', receivedAt: '2026-11-01T03:00:00Z', records: [
    {station: 'plot1', metric: 'rainfall', time: '2026-11-01T00:00:00Z', revision: 1, value: 12, unit: 'mm'},
    {station: 'plot1', metric: 'rainfall', time: '2026-11-01T01:00:00Z', revision: 1, value: -2, unit: 'mm'},
  ]};
  const first = await ledger.ingest(batch);
  assert.equal(first.accepted, 1);
  assert.equal(first.quarantined, 1);
  assert.equal((await ledger.ingest(batch)).replay, true);
  const quarantined = (await ledger.quarantine())[0];
  await ledger.resolve({id: quarantined.id, action: 'replace', actor: 'operator', reason: 'corrected transcription',
    record: {...batch.records[1], value: 3}});
  await ledger.watermark({source: 'cooperative', time: '2026-11-01T02:00:00Z'});
  const query = {station: 'plot1', metric: 'rainfall', from: '2026-11-01T00:00:00Z', until: '2026-11-01T02:00:00Z', widthMs: 7200000};
  assert.equal((await ledger.windows(query)).windows[0].sum, 15);
  await ledger.export({id: 'snapshot1', purpose: 'synthetic agricultural analysis', query: {station: 'plot1'}});
  await ledger.ingest({id: 'correction', source: 'cooperative', receivedAt: '2026-11-01T04:00:00Z',
    records: [{...batch.records[0], revision: 2, value: 5}]});
  assert.equal((await ledger.windows(query)).windows[0].sum, 8);
  assert.equal((await ledger.getExport('snapshot1')).stale, true);
  await ledger.checkpoint();
  const reopened = new Ledger(root);
  assert.equal((await reopened.verify()).valid, true);
  assert.equal((await reopened.status()).activeObservations, 2);

  // 冻结式气候基准：三年历史 + 当期新站，双口径区分覆盖变化与气候信号
  await reopened.registerSource({id: 'hist', name: 'Historical network', region: 'delta',
    metrics: ['temperature']});
  await reopened.registerStation({id: 'legacy', name: 'Legacy station', region: 'delta',
    latitude: 10, longitude: 20, sources: ['hist'], activeFrom: '2020-01-01T00:00:00Z'});
  const history = [];
  for (const year of [2020, 2021, 2022]) {
    for (let month = 1; month <= 12; month += 1) {
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
      for (let day = 1; day <= days; day += 1) {
        history.push({station: 'legacy', metric: 'temperature',
          time: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00Z`,
          revision: 1, value: 18 + ((day + month) % 4), unit: 'C'});
      }
    }
  }
  for (let index = 0; index < history.length; index += 500) {
    await reopened.ingest({id: `hist-${index}`, source: 'hist', receivedAt: '2023-02-01T00:00:00Z',
      records: history.slice(index, index + 500)});
  }
  const period = {from: '2020-01-01T00:00:00Z', until: '2023-01-01T00:00:00Z'};
  await reopened.createBaseline({id: 'climate-v1', scope: 'region', region: 'delta',
    metric: 'temperature', ...period}, 'agronomist');
  // 今年新增高频站（温度系统性偏高），重建基准但旧基准保持冻结
  await reopened.registerSource({id: 'hf', name: 'High frequency station', region: 'delta',
    metrics: ['temperature']});
  await reopened.registerStation({id: 'new-high', name: 'New high frequency station', region: 'delta',
    latitude: 11, longitude: 21, sources: ['hf'], activeFrom: '2022-01-01T00:00:00Z'});
  const newRows = [];
  for (let month = 1; month <= 12; month += 1) {
    const days = new Date(Date.UTC(2022, month, 0)).getUTCDate();
    for (let day = 1; day <= days; day += 1) {
      newRows.push({station: 'new-high', metric: 'temperature',
        time: `2022-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00Z`,
        revision: 1, value: 24 + ((day + month) % 3), unit: 'C'});
    }
  }
  for (let index = 0; index < newRows.length; index += 500) {
    await reopened.ingest({id: `hf-${index}`, source: 'hf', receivedAt: '2023-03-01T00:00:00Z',
      records: newRows.slice(index, index + 500)});
  }
  await reopened.createBaseline({id: 'climate-v2', scope: 'region', region: 'delta',
    metric: 'temperature', ...period}, 'agronomist');
  const attribution = await reopened.compareBaselines({before: 'climate-v1', after: 'climate-v2'});
  assert.deepEqual(attribution.coverageChange.added, ['new-high']);
  assert.deepEqual(attribution.coverageChange.beforeFixedPanel, ['legacy']);
  const january = attribution.monthChanges.find(item => item.month === 1);
  assert.equal(january.fixed.medianDelta, 0);
  assert.notEqual(january.available.medianDelta, 0);
  const v1 = await reopened.baseline('climate-v1');
  assert.equal(v1.fixedPanel.length, 1);
  assert.equal((await reopened.verify()).valid, true);
  process.stdout.write(JSON.stringify({
    accepted: true, status: await reopened.status(), offline: true,
    baseline: {drivers: attribution.interpretation.drivers, addedStation: attribution.coverageChange.added,
      fixedMedianStable: january.fixed.medianDelta === 0, availableMedianShifted: january.available.medianDelta},
  }) + String.fromCharCode(10));
} finally {
  await rm(root, {recursive: true, force: true});
}
