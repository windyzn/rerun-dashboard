/**
 * calc.test.js — plain Node smoke tests for calc.js. No test framework, no npm
 * install required. Run with:
 *
 *     node calc.test.js
 *
 * Exits 0 if every assertion passes, non-zero otherwise.
 */
const assert = require('assert');
const Calc = require('./calc.js');

let pass = 0, fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('ok  -', name);
  } catch (e) {
    fail++;
    console.error('FAIL -', name, '\n   ', e.message);
  }
}

// ---------------------------------------------------------------------
// parseValue / isExcluded
// ---------------------------------------------------------------------

test('parseValue: BLQ<X is excluded, captures the limit', function () {
  const p = Calc.parseValue('BLQ<1.4');
  assert.strictEqual(p.kind, 'blq');
  assert.strictEqual(p.value, null);
  assert.strictEqual(p.blqLimit, 1.4);
  assert.strictEqual(Calc.isExcluded(p), true);
});

test('parseValue: "BLQ < 5" with spaces still parses', function () {
  const p = Calc.parseValue('BLQ < 5');
  assert.strictEqual(p.kind, 'blq');
  assert.strictEqual(p.blqLimit, 5);
});

test('parseValue: NR is excluded', function () {
  const p = Calc.parseValue('NR');
  assert.strictEqual(p.kind, 'nr');
  assert.strictEqual(Calc.isExcluded(p), true);
});

test('parseValue: Excel error strings are excluded, never NaN', function () {
  ['#DIV/0!', '#VALUE!', '#N/A'].forEach(function (raw) {
    const p = Calc.parseValue(raw);
    assert.strictEqual(p.kind, 'error');
    assert.strictEqual(p.value, null);
    assert.strictEqual(Number.isNaN(p.value), false);
    assert.strictEqual(Calc.isExcluded(p), true);
  });
});

test('parseValue: plain numeric value parses cleanly', function () {
  const p = Calc.parseValue('12.34');
  assert.strictEqual(p.kind, 'numeric');
  assert.strictEqual(p.value, 12.34);
  assert.strictEqual(Calc.isExcluded(p), false);
});

test('parseValue: empty string is excluded, not zero', function () {
  const p = Calc.parseValue('');
  assert.strictEqual(p.kind, 'empty');
  assert.strictEqual(p.value, null);
  assert.strictEqual(Calc.isExcluded(p), true);
});

test('parseValue: unrecognized garbage excluded as error, never NaN', function () {
  const p = Calc.parseValue('n/a-ish??');
  assert.strictEqual(p.kind, 'error');
  assert.strictEqual(Number.isNaN(p.value), false);
});

// ---------------------------------------------------------------------
// mean / sd / cvPercent
// ---------------------------------------------------------------------

test('mean: basic case', function () {
  assert.strictEqual(Calc.mean([90, 100, 110]), 100);
});

test('mean: empty array is null', function () {
  assert.strictEqual(Calc.mean([]), null);
});

test('sd: null when fewer than 2 values', function () {
  assert.strictEqual(Calc.sd([100]), null);
  assert.strictEqual(Calc.sd([]), null);
});

test('sd: sample SD (n-1) for a known triple', function () {
  // values 90,100,110 -> mean 100, deviations -10/0/10, sumSq=200, variance=100, sd=10
  assert.strictEqual(Calc.sd([90, 100, 110]), 10);
});

test('cvPercent: null when fewer than 2 valid values', function () {
  assert.strictEqual(Calc.cvPercent([]), null);
  assert.strictEqual(Calc.cvPercent([100]), null);
});

test('cvPercent: exact 10/20/30% cases via nice integer triples', function () {
  assert.strictEqual(Calc.cvPercent([90, 100, 110]), 10);
  assert.strictEqual(Calc.cvPercent([80, 100, 120]), 20);
  assert.strictEqual(Calc.cvPercent([70, 100, 130]), 30);
});

// ---------------------------------------------------------------------
// F5 / DVIVHPLPLK anchor fixture (real example row from the build brief)
// ---------------------------------------------------------------------

const F5_ROW = {
  protein: 'Adhesion G protein-coupled receptor F5',
  mycoId: 'M00000393',
  peptideId: 'M00000794',
  peptide: 'DVIVHPLPLK',
  lloq: 1.4,
  uloq: 1630.5
};

test('F5/DVIVHPLPLK: BLQ/BLQ duplicate row has no computable CV, not 0 or NaN', function () {
  const replicates = [Calc.parseValue('BLQ<1.4'), Calc.parseValue('BLQ<1.4')];
  const result = Calc.duplicateAnalysis([Object.assign({}, F5_ROW, { replicates: replicates })]);
  assert.strictEqual(result.perPeptide[0].intraCv, null);
  // Both replicates agreeing BLQ is a clean, consistent result (still below
  // the detection limit) — not a discrepancy — so it should NOT be flagged
  // the same way a real mismatch would be.
  assert.strictEqual(result.perPeptide[0].excluded, false);
  assert.strictEqual(result.perPeptide[0].validCount, 0);
  assert.strictEqual(result.counts.validPeptideCount, 0);
  // an all-excluded batch should PASS (no peptides can push it toward fail) rather
  // than blow up or read as a false FAIL.
  assert.strictEqual(result.verdict, 'PASS');
});

test('duplicateAnalysis: all-NR replicates also agree, not flagged as excluded', function () {
  const replicates = [Calc.parseValue('NR'), Calc.parseValue('NR')];
  const result = Calc.duplicateAnalysis([Object.assign({}, F5_ROW, { replicates: replicates })]);
  assert.strictEqual(result.perPeptide[0].excluded, false);
  assert.strictEqual(result.perPeptide[0].validCount, 0);
});

test('duplicateAnalysis: BLQ mixed with NR is a real mismatch, still flagged as excluded', function () {
  const replicates = [Calc.parseValue('BLQ<1.4'), Calc.parseValue('NR')];
  const result = Calc.duplicateAnalysis([Object.assign({}, F5_ROW, { replicates: replicates })]);
  assert.strictEqual(result.perPeptide[0].excluded, true);
});

test('allShareExcludedKind / isConsistentNonNumericAgreement: exported helpers behave as documented', function () {
  assert.strictEqual(Calc.allShareExcludedKind([Calc.parseValue('BLQ<1'), Calc.parseValue('BLQ<2')], 'blq'), true);
  assert.strictEqual(Calc.allShareExcludedKind([Calc.parseValue('BLQ<1'), Calc.parseValue('NR')], 'blq'), false);
  assert.strictEqual(Calc.allShareExcludedKind([], 'blq'), false);
  assert.strictEqual(Calc.isConsistentNonNumericAgreement([Calc.parseValue('NR'), Calc.parseValue('NR')]), true);
  assert.strictEqual(Calc.isConsistentNonNumericAgreement([Calc.parseValue('BLQ<1'), Calc.parseValue('100')]), false);
});

test('rerunAnalysis: first-run and rerun both consistently BLQ agree, not flagged as excluded', function () {
  const row = Object.assign({}, F5_ROW, {
    firstRun: [Calc.parseValue('BLQ<1.4')],
    rerun: [Calc.parseValue('BLQ<1.4'), Calc.parseValue('BLQ<1.4')]
  });
  const result = Calc.rerunAnalysis([row]);
  assert.strictEqual(result.perPeptide[0].excluded, false);
});

test('rerunAnalysis: first-run and rerun both consistently NR agree, not flagged as excluded', function () {
  const row = Object.assign({}, F5_ROW, {
    firstRun: [Calc.parseValue('NR')],
    rerun: [Calc.parseValue('NR'), Calc.parseValue('NR')]
  });
  const result = Calc.rerunAnalysis([row]);
  assert.strictEqual(result.perPeptide[0].excluded, false);
});

test('rerunAnalysis: first-run BLQ but rerun detected a value is a real mismatch, still flagged as excluded', function () {
  const row = Object.assign({}, F5_ROW, {
    firstRun: [Calc.parseValue('BLQ<1.4')],
    rerun: [Calc.parseValue('42.0'), Calc.parseValue('43.0')]
  });
  const result = Calc.rerunAnalysis([row]);
  // firstNumeric.length is 0 here, so it's excluded from ratio/interCv, and
  // this is a genuine discrepancy (not an agreeing BLQ/BLQ or NR/NR case).
  assert.strictEqual(result.perPeptide[0].excluded, true);
});

test('rerunAnalysis: first-run BLQ but rerun NR is a mismatched exclusion kind, still flagged as excluded', function () {
  const row = Object.assign({}, F5_ROW, {
    firstRun: [Calc.parseValue('BLQ<1.4')],
    rerun: [Calc.parseValue('NR'), Calc.parseValue('NR')]
  });
  const result = Calc.rerunAnalysis([row]);
  assert.strictEqual(result.perPeptide[0].excluded, true);
});

test('mixed row [100, BLQ<5, #VALUE!]: 1 valid value, CV not computable but not fully excluded', function () {
  const replicates = [Calc.parseValue('100'), Calc.parseValue('BLQ<5'), Calc.parseValue('#VALUE!')];
  const result = Calc.duplicateAnalysis([Object.assign({}, F5_ROW, { replicates: replicates })]);
  const row = result.perPeptide[0];
  assert.strictEqual(row.validCount, 1);
  assert.strictEqual(row.excluded, false); // some data present, just insufficient for CV
  assert.strictEqual(row.intraCv, null);
});

// ---------------------------------------------------------------------
// Duplicate/VIP: CV threshold boundary strictness (> not >=)
// ---------------------------------------------------------------------

test('duplicateAnalysis: CV exactly at 10/20/30% is NOT counted (strict >)', function () {
  const rows = [
    Object.assign({}, F5_ROW, { peptide: 'P10', replicates: [Calc.parseValue('90'), Calc.parseValue('100'), Calc.parseValue('110')] }), // CV=10
    Object.assign({}, F5_ROW, { peptide: 'P20', replicates: [Calc.parseValue('80'), Calc.parseValue('100'), Calc.parseValue('120')] }), // CV=20
    Object.assign({}, F5_ROW, { peptide: 'P30', replicates: [Calc.parseValue('70'), Calc.parseValue('100'), Calc.parseValue('130')] })  // CV=30
  ];
  const result = Calc.duplicateAnalysis(rows);
  // P20 (CV=20) and P30 (CV=30) both exceed 10%, so cv10=2; only P30 exceeds 20%, so cv20=1;
  // none exceeds 30%, so cv30=0. Exactly-at-threshold values never push their own bucket.
  assert.strictEqual(result.counts.cv10, 2);
  assert.strictEqual(result.counts.cv20, 1);
  assert.strictEqual(result.counts.cv30, 0);
});

test('duplicateAnalysis: CV just above threshold IS counted', function () {
  const rows = [
    Object.assign({}, F5_ROW, { peptide: 'P21', replicates: [Calc.parseValue('79'), Calc.parseValue('100'), Calc.parseValue('121')] }), // CV=21
    Object.assign({}, F5_ROW, { peptide: 'P19', replicates: [Calc.parseValue('81'), Calc.parseValue('100'), Calc.parseValue('119')] })  // CV=19
  ];
  const result = Calc.duplicateAnalysis(rows);
  assert.strictEqual(result.counts.cv20, 1); // only the CV=21 peptide
  assert.strictEqual(result.counts.cv10, 2); // both 21 and 19 exceed 10
});

test('duplicateAnalysis: verdict FAILs when >20 peptides exceed 20% CV', function () {
  const rows = [];
  for (let i = 0; i < 21; i++) {
    rows.push(Object.assign({}, F5_ROW, { peptide: 'P' + i, replicates: [Calc.parseValue('79'), Calc.parseValue('100'), Calc.parseValue('121')] })); // CV=21, all fail
  }
  const result = Calc.duplicateAnalysis(rows);
  assert.strictEqual(result.counts.cv20, 21);
  assert.strictEqual(result.verdict, 'FAIL');
});

test('duplicateAnalysis: verdict PASSes at exactly 20 failing peptides (threshold is ">20")', function () {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push(Object.assign({}, F5_ROW, { peptide: 'P' + i, replicates: [Calc.parseValue('79'), Calc.parseValue('100'), Calc.parseValue('121')] }));
  }
  const result = Calc.duplicateAnalysis(rows);
  assert.strictEqual(result.counts.cv20, 20);
  assert.strictEqual(result.verdict, 'PASS');
});

// ---------------------------------------------------------------------
// Ratio / bucket boundaries
// ---------------------------------------------------------------------

test('ratio: mean(rerun)/mean(firstRun), works for a single rerun replicate', function () {
  assert.strictEqual(Calc.ratio([100], [90]), 0.9);
  assert.strictEqual(Calc.ratio([100], [80, 100]), 0.9);
});

test('ratio: null when either side has no valid values', function () {
  assert.strictEqual(Calc.ratio([], [90]), null);
  assert.strictEqual(Calc.ratio([100], []), null);
});

test('bucketForRatio: half-open boundaries, no double-count or gap', function () {
  assert.strictEqual(Calc.bucketForRatio(0.7), '0.7-0.8');
  assert.strictEqual(Calc.bucketForRatio(0.699999), '<0.7');
  assert.strictEqual(Calc.bucketForRatio(1.3), '>=1.3');
  assert.strictEqual(Calc.bucketForRatio(1.299999), '1.2-1.3');
  assert.strictEqual(Calc.bucketForRatio(1.0), '1.0-1.1');
  assert.strictEqual(Calc.bucketForRatio(null), null);
});

// ---------------------------------------------------------------------
// rerunDecision branches + directional drift + batch escalation
// ---------------------------------------------------------------------

function inBandRatioBuckets(passCount, totalCount) {
  // helper: totalCount peptides, passCount of them inside the 0.8-1.2 band
  const buckets = {};
  Calc.RATIO_BUCKETS.forEach(function (b) { buckets[b.label] = 0; });
  buckets['1.0-1.1'] = passCount;
  buckets['<0.7'] = totalCount - passCount;
  return buckets;
}

test('rerunDecision: intra PASS + inter PASS -> use-first-run', function () {
  const intra = { cv10: 0, cv20: 5, cv30: 0, validPeptideCount: 95 };   // cv20=5, <=20 -> PASS
  const inter = { cv10: 0, cv20: 0, cv30: 5, validPeptideCount: 95 };   // cv30=5, <=20 -> PASS
  const decision = Calc.rerunDecision(intra, inter, inBandRatioBuckets(95, 95), []);
  assert.strictEqual(decision.intraVerdict, 'PASS');
  assert.strictEqual(decision.interVerdict, 'PASS');
  assert.strictEqual(decision.recommendation, 'use-first-run');
  assert.strictEqual(decision.reasonCode, 'INTRA_PASS_INTER_PASS');
});

test('rerunDecision: intra FAIL + inter PASS -> use-rerun (reproducibility confirmed)', function () {
  const intra = { cv10: 0, cv20: 25, cv30: 0, validPeptideCount: 95 };  // cv20=25, >20 -> FAIL
  const inter = { cv10: 0, cv20: 0, cv30: 5, validPeptideCount: 95 };   // PASS
  const decision = Calc.rerunDecision(intra, inter, inBandRatioBuckets(95, 95), []);
  assert.strictEqual(decision.intraVerdict, 'FAIL');
  assert.strictEqual(decision.interVerdict, 'PASS');
  assert.strictEqual(decision.recommendation, 'use-rerun');
  assert.strictEqual(decision.reasonCode, 'INTRA_FAIL_INTER_PASS');
});

test('rerunDecision: both FAIL -> escalate-vendor', function () {
  const intra = { cv10: 0, cv20: 25, cv30: 0, validPeptideCount: 95 };
  const inter = { cv10: 0, cv20: 0, cv30: 25, validPeptideCount: 95 };
  const decision = Calc.rerunDecision(intra, inter, inBandRatioBuckets(95, 95), []);
  assert.strictEqual(decision.intraVerdict, 'FAIL');
  assert.strictEqual(decision.interVerdict, 'FAIL');
  assert.strictEqual(decision.recommendation, 'escalate-vendor');
});

test('rerunDecision: intra PASS but ratio out of band -> inter FAIL -> escalate-vendor', function () {
  const intra = { cv10: 0, cv20: 5, cv30: 0, validPeptideCount: 95 };
  const inter = { cv10: 0, cv20: 0, cv30: 5, validPeptideCount: 95 };
  const decision = Calc.rerunDecision(intra, inter, inBandRatioBuckets(10, 95), []); // only 10/95 in band -> not majority
  assert.strictEqual(decision.interVerdict, 'FAIL');
  assert.strictEqual(decision.recommendation, 'escalate-vendor');
  assert.strictEqual(decision.reasonCode, 'INTRA_PASS_INTER_FAIL');
});

test('directionalDriftFlag: majority-shift-down is flagged', function () {
  const samples = [];
  for (let i = 0; i < 8; i++) samples.push({ sampleId: 'S' + i, ratio: 0.85 });
  for (let i = 0; i < 2; i++) samples.push({ sampleId: 'T' + i, ratio: 1.1 });
  const drift = Calc.directionalDriftFlag(samples);
  assert.strictEqual(drift.flagged, true);
  assert.strictEqual(drift.direction, 'down');
});

test('directionalDriftFlag: 50/50 split is NOT flagged', function () {
  const samples = [
    { sampleId: 'A', ratio: 0.85 }, { sampleId: 'B', ratio: 0.85 },
    { sampleId: 'C', ratio: 1.15 }, { sampleId: 'D', ratio: 1.15 }
  ];
  const drift = Calc.directionalDriftFlag(samples);
  assert.strictEqual(drift.flagged, false);
});

test('batchLevelEscalation: flags when >=60% of samples fail intra-run CV', function () {
  const verdicts = ['FAIL', 'FAIL', 'FAIL', 'PASS', 'PASS'];
  const escalation = Calc.batchLevelEscalation(verdicts);
  assert.strictEqual(escalation.flagged, true);
});

test('batchLevelEscalation: does not flag when most samples pass', function () {
  const verdicts = ['FAIL', 'PASS', 'PASS', 'PASS', 'PASS'];
  const escalation = Calc.batchLevelEscalation(verdicts);
  assert.strictEqual(escalation.flagged, false);
});

test('directionalDriftFlag: a single-sample "batch" never flags (100% of 1 is not a batch signal)', function () {
  const drift = Calc.directionalDriftFlag([{ sampleId: 'ONLY_ONE', ratio: 0.5 }]);
  assert.strictEqual(drift.flagged, false);
  assert.strictEqual(drift.direction, null);
});

test('batchLevelEscalation: a single-sample "batch" never flags, even if that sample failed', function () {
  const escalation = Calc.batchLevelEscalation(['FAIL']);
  assert.strictEqual(escalation.flagged, false);
});

test('MIN_SAMPLES_FOR_BATCH_SIGNAL guard: exactly at the minimum still evaluates normally', function () {
  const drift = Calc.directionalDriftFlag([{ sampleId: 'A', ratio: 0.5 }, { sampleId: 'B', ratio: 0.5 }]);
  assert.strictEqual(Calc.MIN_SAMPLES_FOR_BATCH_SIGNAL, 2);
  assert.strictEqual(drift.flagged, true); // 2/2 samples, at the minimum, both shifted down
});

// ---------------------------------------------------------------------
// summarySentence — fixed-string assertions to lock wording
// ---------------------------------------------------------------------

test('summarySentence: duplicate PASS wording', function () {
  const batchResult = { verdict: 'PASS', counts: { cv20: 3, validPeptideCount: 97 } };
  const s = Calc.summarySentence('duplicate', batchResult);
  assert.strictEqual(s, 'Intra-run CV passed (3/97 peptides >20% CV, threshold is >20).');
});

test('summarySentence: poolPlasma FAIL wording', function () {
  const batchResult = { verdict: 'FAIL', counts: { cv30: 25, validPeptideCount: 98 } };
  const s = Calc.summarySentence('poolPlasma', batchResult);
  assert.strictEqual(s, 'Pool plasma intra-run CV FAILED (25/98 peptides >30% CV, threshold is >20).');
});

test('summarySentence: rerun single-sample-failed wording matches brief style', function () {
  const decision = { reasonCode: 'INTRA_PASS_INTER_FAIL', interVerdict: 'FAIL' };
  const perSampleSummary = [
    { sampleId: '473G835', interVerdict: 'FAIL', interCv20Count: 63, intraVerdict: 'PASS' }
  ];
  for (let i = 0; i < 10; i++) perSampleSummary.push({ sampleId: 'S' + i, interVerdict: 'PASS', interCv20Count: 2, intraVerdict: 'PASS' });
  const s = Calc.summarySentence('rerun', {}, decision, perSampleSummary);
  assert.strictEqual(
    s,
    'Inter-run CV passed for 10/11 samples; only 473G835 (63 peptides >20% CV) failed, despite passing intra-run CV, indicating a plate-to-plate shift rather than duplicate imprecision.'
  );
});

test('summarySentence: rerun failed sample WITHOUT a "despite passing intra" clause still reads grammatically (comma before the reason)', function () {
  const decision = { reasonCode: 'INTRA_FAIL_INTER_FAIL', interVerdict: 'FAIL' };
  const perSampleSummary = [
    { sampleId: 'X1', interVerdict: 'FAIL', interCv20Count: 40, intraVerdict: 'FAIL' },
    { sampleId: 'X2', interVerdict: 'PASS', interCv20Count: 1, intraVerdict: 'PASS' }
  ];
  const s = Calc.summarySentence('rerun', {}, decision, perSampleSummary);
  assert.strictEqual(
    s,
    'Inter-run CV passed for 1/2 samples; only X1 (40 peptides >20% CV) failed, both intra-run and inter-run CV failed; recommend escalating to the vendor for a full batch rerun.'
  );
});

test('summarySentence: rerun with zero failed samples uses a capitalized closing sentence (no dangling lowercase after a period)', function () {
  const decision = { reasonCode: 'INTRA_PASS_INTER_PASS', interVerdict: 'PASS' };
  const perSampleSummary = [
    { sampleId: 'Y1', interVerdict: 'PASS', interCv20Count: 1, intraVerdict: 'PASS' },
    { sampleId: 'Y2', interVerdict: 'PASS', interCv20Count: 0, intraVerdict: 'PASS' }
  ];
  const s = Calc.summarySentence('rerun', {}, decision, perSampleSummary);
  assert.strictEqual(
    s,
    'Inter-run CV passed for 2/2 samples. Both intra-run and inter-run agreement passed; using first-run data for reporting, with the rerun marked as research-only.'
  );
});

test('summarySentence: rerun with >2 failed samples uses the capitalized systematic-drift closing sentence', function () {
  const decision = { reasonCode: 'SYSTEMATIC_DRIFT', interVerdict: 'FAIL' };
  const perSampleSummary = ['A', 'B', 'C'].map(function (id) {
    return { sampleId: id, interVerdict: 'FAIL', interCv20Count: 30, intraVerdict: 'PASS' };
  });
  const s = Calc.summarySentence('rerun', {}, decision, perSampleSummary);
  assert.strictEqual(
    s,
    'Inter-run CV passed for 0/3 samples. Indicating a systematic drift across the batch rather than isolated sample issues; recommend escalating to the vendor.'
  );
});

// ---------------------------------------------------------------------
// poolPlasmaAnalysis — per-pairing, never averaged across batches
// ---------------------------------------------------------------------

test('poolPlasmaAnalysis: computes independently per (first-run, rerun) pairing', function () {
  const firstRunBatchA = [Object.assign({}, F5_ROW, { poolReplicates: [Calc.parseValue('90'), Calc.parseValue('100'), Calc.parseValue('110')] })]; // CV=10
  const firstRunBatchB = [Object.assign({}, F5_ROW, { poolReplicates: [Calc.parseValue('63'), Calc.parseValue('90'), Calc.parseValue('117')] })]; // CV=30, mean=90 (deliberately different mean from batch A)
  const rerunBatch = [Object.assign({}, F5_ROW, { poolReplicates: [Calc.parseValue('95'), Calc.parseValue('100'), Calc.parseValue('105')] })]; // CV=5

  const pairingA = Calc.poolPlasmaAnalysis(firstRunBatchA, rerunBatch);
  const pairingB = Calc.poolPlasmaAnalysis(firstRunBatchB, rerunBatch);

  // Same rerun-batch pool plasma data on both sides -> rerunIntraCv identical...
  assert.strictEqual(pairingA.perPeptide[0].rerunIntraCv, pairingB.perPeptide[0].rerunIntraCv);
  // ...but the ratio against each first-run batch differs because they're never averaged together.
  assert.notStrictEqual(pairingA.perPeptide[0].ratio, pairingB.perPeptide[0].ratio);
});

// ---------------------------------------------------------------------
// matchBarcode — prefix stripping + low-confidence cases
// ---------------------------------------------------------------------

test('matchBarcode: strips known prefixes with high confidence', function () {
  assert.deepStrictEqual(Calc.matchBarcode('P1-228G789'), { canonical: '228G789', prefix: 'P1-', confidence: 'high' });
  const p4a = Calc.matchBarcode('P4A-228G789');
  assert.strictEqual(p4a.canonical, '228G789');
  assert.strictEqual(p4a.confidence, 'high');
});

test('matchBarcode: bare barcode with no prefix is still high confidence', function () {
  const m = Calc.matchBarcode('228G789');
  assert.strictEqual(m.canonical, '228G789');
  assert.strictEqual(m.prefix, null);
  assert.strictEqual(m.confidence, 'high');
});

test('matchBarcode: unrecognized/ambiguous format is low confidence', function () {
  const m = Calc.matchBarcode('228G789 (dup?)');
  assert.strictEqual(m.confidence, 'low');
});

// ---------------------------------------------------------------------
// Guard: Xukun confirmed (Aug 7, 2026) both CV thresholds stay fixed as-is —
// duplicate/VIP at 20%, pool plasma at 30%, no dynamic scaling. Never "fix"
// this inconsistency without re-confirming with her first.
// ---------------------------------------------------------------------

test('THRESHOLDS guard: duplicate/VIP uses 20% CV, pool plasma uses 30% CV (confirmed intentional, fixed, not scaled)', function () {
  assert.strictEqual(Calc.THRESHOLDS.duplicateCvFailPercent, 20);
  assert.strictEqual(Calc.THRESHOLDS.poolPlasmaCvFailPercent, 30);
});

test('ASSUMPTIONS only lists genuinely open items (resolved Aug 7 items are not re-flagged)', function () {
  const ids = Calc.ASSUMPTIONS.map(function (a) { return a.id; });
  assert.deepStrictEqual(ids.sort(), ['directional-drift-fraction', 'inter-run-cv-definition']);
});

test('CATEGORY_VOCABULARY: single-select category list matches Xukun\'s locked-in model', function () {
  assert.deepStrictEqual(Calc.CATEGORY_VOCABULARY, ['First-run', 'Rerun', 'Duplicate', 'Pool plasma']);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
