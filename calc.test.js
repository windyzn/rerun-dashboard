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

test('F5/DVIVHPLPLK: BLQ/BLQ duplicate row has no computable CV, not 0 or NaN — but counts as a pass', function () {
  const replicates = [Calc.parseValue('BLQ<1.4'), Calc.parseValue('BLQ<1.4')];
  const result = Calc.duplicateAnalysis([Object.assign({}, F5_ROW, { replicates: replicates })]);
  assert.strictEqual(result.perPeptide[0].intraCv, null);
  assert.strictEqual(result.perPeptide[0].excluded, false);
  assert.strictEqual(result.perPeptide[0].validCount, 0);
  assert.strictEqual(result.counts.validPeptideCount, 0); // no CV-computable peptides...
  // ...but per Xukun (Oct 2026) the agreeing BLQ pair is a pass, included in the totals.
  assert.strictEqual(result.perPeptide[0].agreement, 'agree-blq');
  assert.strictEqual(result.perPeptide[0].status, 'pass');
  assert.strictEqual(result.counts.total, 1);
  assert.strictEqual(result.counts.passCount, 1);
  assert.strictEqual(result.verdict, 'PASS');
});

test('duplicateAnalysis: all-NR replicates also agree — a pass, included in the totals', function () {
  const replicates = [Calc.parseValue('NR'), Calc.parseValue('NR')];
  const result = Calc.duplicateAnalysis([Object.assign({}, F5_ROW, { replicates: replicates })]);
  assert.strictEqual(result.perPeptide[0].excluded, false);
  assert.strictEqual(result.perPeptide[0].validCount, 0);
  assert.strictEqual(result.perPeptide[0].status, 'pass');
  assert.strictEqual(result.counts.total, 1);
  assert.strictEqual(result.counts.passCount, 1);
});

test('duplicateAnalysis: BLQ mixed with NR is a mismatch that needs review, not passed or failed', function () {
  const replicates = [Calc.parseValue('BLQ<1.4'), Calc.parseValue('NR')];
  const result = Calc.duplicateAnalysis([Object.assign({}, F5_ROW, { replicates: replicates })]);
  assert.strictEqual(result.perPeptide[0].mismatch, true);
  assert.strictEqual(result.perPeptide[0].status, 'needs-review');
  assert.strictEqual(result.counts.needsReviewCount, 1);
  assert.strictEqual(result.counts.passCount, 0);
  assert.strictEqual(result.counts.failCount, 0);
});

test('allShareExcludedKind / isConsistentNonNumericAgreement: exported helpers behave as documented', function () {
  assert.strictEqual(Calc.allShareExcludedKind([Calc.parseValue('BLQ<1'), Calc.parseValue('BLQ<2')], 'blq'), true);
  assert.strictEqual(Calc.allShareExcludedKind([Calc.parseValue('BLQ<1'), Calc.parseValue('NR')], 'blq'), false);
  assert.strictEqual(Calc.allShareExcludedKind([], 'blq'), false);
  assert.strictEqual(Calc.isConsistentNonNumericAgreement([Calc.parseValue('NR'), Calc.parseValue('NR')]), true);
  assert.strictEqual(Calc.isConsistentNonNumericAgreement([Calc.parseValue('BLQ<1'), Calc.parseValue('100')]), false);
});

test('replicateAgreement: classifies the vendor value vocabulary (number, BLQ < x, NR)', function () {
  const v = Calc.parseValue;
  assert.strictEqual(Calc.replicateAgreement([v('10'), v('12')]), 'numeric');
  assert.strictEqual(Calc.replicateAgreement([v('BLQ<1'), v('BLQ < 2')]), 'agree-blq');
  assert.strictEqual(Calc.replicateAgreement([v('NR'), v('NR')]), 'agree-nr');
  assert.strictEqual(Calc.replicateAgreement([v('BLQ<1'), v('10')]), 'mismatch');
  assert.strictEqual(Calc.replicateAgreement([v('NR'), v('10')]), 'mismatch');
  assert.strictEqual(Calc.replicateAgreement([v('BLQ<1'), v('NR')]), 'mismatch');
  // blanks/Excel errors are missing data, never a mismatch on their own
  assert.strictEqual(Calc.replicateAgreement([v('BLQ<1'), v('')]), 'insufficient');
  assert.strictEqual(Calc.replicateAgreement([v('#DIV/0!'), v('')]), 'missing');
});

test('rerunAnalysis: first-run and rerun both consistently BLQ agree — inter-run pass', function () {
  const row = Object.assign({}, F5_ROW, {
    firstRun: [Calc.parseValue('BLQ<1.4')],
    rerun: [Calc.parseValue('BLQ<1.4'), Calc.parseValue('BLQ<1.4')]
  });
  const result = Calc.rerunAnalysis([row]);
  assert.strictEqual(result.perPeptide[0].excluded, false);
  assert.strictEqual(result.perPeptide[0].interStatus, 'pass');
  assert.strictEqual(result.perPeptide[0].intraStatus, 'pass');
  assert.strictEqual(result.interCounts.total, 1);
});

test('rerunAnalysis: first-run and rerun both consistently NR agree — inter-run pass', function () {
  const row = Object.assign({}, F5_ROW, {
    firstRun: [Calc.parseValue('NR')],
    rerun: [Calc.parseValue('NR'), Calc.parseValue('NR')]
  });
  const result = Calc.rerunAnalysis([row]);
  assert.strictEqual(result.perPeptide[0].excluded, false);
  assert.strictEqual(result.perPeptide[0].interStatus, 'pass');
});

test('rerunAnalysis: first-run BLQ but rerun NR is an inter-run mismatch that needs review', function () {
  const row = Object.assign({}, F5_ROW, {
    firstRun: [Calc.parseValue('BLQ<1.4')],
    rerun: [Calc.parseValue('NR'), Calc.parseValue('NR')]
  });
  const result = Calc.rerunAnalysis([row]);
  assert.strictEqual(result.perPeptide[0].interMismatch, true);
  assert.strictEqual(result.perPeptide[0].interStatus, 'needs-review');
  assert.strictEqual(result.perPeptide[0].intraStatus, 'pass'); // rerun replicates agree with each other
});

test('rerunAnalysis: NR in one batch and a value in the other is an inter-run mismatch', function () {
  const row = Object.assign({}, F5_ROW, { firstRun: [Calc.parseValue('NR')], rerun: [Calc.parseValue('40'), Calc.parseValue('42')] });
  const result = Calc.rerunAnalysis([row]);
  assert.strictEqual(result.perPeptide[0].interStatus, 'needs-review');
  assert.strictEqual(result.interCounts.mismatchCount, 1);
});

test('mixed row [100, BLQ<5, #VALUE!]: CV not computable, mismatch needs review', function () {
  const replicates = [Calc.parseValue('100'), Calc.parseValue('BLQ<5'), Calc.parseValue('#VALUE!')];
  const result = Calc.duplicateAnalysis([Object.assign({}, F5_ROW, { replicates: replicates })]);
  const row = result.perPeptide[0];
  assert.strictEqual(row.validCount, 1);
  assert.strictEqual(row.excluded, false);
  assert.strictEqual(row.intraCv, null);
  // A real concentration alongside a BLQ replicate — one replicate detected the
  // analyte, the other didn't. The #VALUE! is ignored (missing data).
  assert.strictEqual(row.mismatch, true);
  assert.strictEqual(row.status, 'needs-review');
});

// ---------------------------------------------------------------------
// Xukun's agreement rule (Oct 2026): all BLQ / all NR -> pass; any mix of
// value, BLQ and NR -> needs review, with a reviewer override to pass or fail.
// ---------------------------------------------------------------------

test('hasBlqNumericMismatch: both BLQ is not a mismatch', function () {
  assert.strictEqual(Calc.hasBlqNumericMismatch([Calc.parseValue('BLQ<1'), Calc.parseValue('BLQ<2')]), false);
});

test('hasBlqNumericMismatch: one concentration + one BLQ IS a mismatch', function () {
  assert.strictEqual(Calc.hasBlqNumericMismatch([Calc.parseValue('42.0'), Calc.parseValue('BLQ<5')]), true);
});

function mismatchRows(n, prefix) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(Object.assign({}, F5_ROW, { peptide: (prefix || 'MISMATCH') + i, replicates: [Calc.parseValue('50'), Calc.parseValue('BLQ<5')] }));
  }
  return rows;
}
function cleanRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(Object.assign({}, F5_ROW, { peptide: 'CLEAN' + i, replicates: [Calc.parseValue('100'), Calc.parseValue('100')] }));
  }
  return rows;
}
function cvFailRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(Object.assign({}, F5_ROW, { peptide: 'CVFAIL' + i, replicates: [Calc.parseValue('79'), Calc.parseValue('100'), Calc.parseValue('121')] })); // CV=21
  }
  return rows;
}
function overridesFor(rows, decision, prefix) {
  const o = {};
  rows.forEach(function (r) { o[(prefix || '') + Calc.overrideKey(r)] = decision; });
  return o;
}

test('duplicateAnalysis: a mismatch is neither a pass nor a fail until reviewed', function () {
  const rows = mismatchRows(1).concat(cleanRows(20));
  const result = Calc.duplicateAnalysis(rows);
  assert.strictEqual(result.counts.cv20, 0);
  assert.strictEqual(result.counts.mismatchCount, 1);
  assert.strictEqual(result.counts.needsReviewCount, 1);
  assert.strictEqual(result.counts.failPeptideCount, 0);
  assert.strictEqual(result.counts.passCount, 20);
  assert.strictEqual(result.counts.total, 21);
  // 1 pending item can't push 0 failures past ">20", so the verdict is decided.
  assert.strictEqual(result.verdict, 'PASS');
});

test('resolveVerdict: NEEDS_REVIEW only when pending items could flip the outcome', function () {
  assert.strictEqual(Calc.resolveVerdict(21, 0, 20), 'FAIL');
  assert.strictEqual(Calc.resolveVerdict(21, 5, 20), 'FAIL');     // already failing
  assert.strictEqual(Calc.resolveVerdict(20, 0, 20), 'PASS');
  assert.strictEqual(Calc.resolveVerdict(20, 1, 20), 'NEEDS_REVIEW');
  assert.strictEqual(Calc.resolveVerdict(0, 20, 20), 'PASS');     // even all-fail stays within the cutoff
  assert.strictEqual(Calc.resolveVerdict(0, 21, 20), 'NEEDS_REVIEW');
});

test('duplicateAnalysis: enough unreviewed mismatches hold the verdict at NEEDS_REVIEW', function () {
  const result = Calc.duplicateAnalysis(mismatchRows(21));
  assert.strictEqual(result.counts.cv20, 0);
  assert.strictEqual(result.counts.mismatchCount, 21);
  assert.strictEqual(result.verdict, 'NEEDS_REVIEW');
});

test('duplicateAnalysis: overriding mismatches to FAIL flips the overall verdict to FAIL', function () {
  const rows = mismatchRows(21);
  const result = Calc.duplicateAnalysis(rows, overridesFor(rows, 'FAIL'));
  assert.strictEqual(result.counts.needsReviewCount, 0);
  assert.strictEqual(result.counts.failCount, 21);
  assert.strictEqual(result.counts.overriddenFailCount, 21);
  assert.strictEqual(result.verdict, 'FAIL');
});

test('duplicateAnalysis: overriding mismatches to PASS flips the overall verdict to PASS', function () {
  const rows = mismatchRows(21);
  const result = Calc.duplicateAnalysis(rows, overridesFor(rows, 'PASS'));
  assert.strictEqual(result.counts.passCount, 21);
  assert.strictEqual(result.counts.overriddenPassCount, 21);
  assert.strictEqual(result.verdict, 'PASS');
});

test('duplicateAnalysis: override keeps the original automatic result alongside it', function () {
  const rows = mismatchRows(1);
  const row = Calc.duplicateAnalysis(rows, overridesFor(rows, 'FAIL')).perPeptide[0];
  assert.strictEqual(row.autoStatus, 'needs-review');
  assert.strictEqual(row.override, 'FAIL');
  assert.strictEqual(row.status, 'fail');
});

test('duplicateAnalysis: an override on a row that no longer needs review is ignored', function () {
  // e.g. the reviewer passed a mismatch, then the column was re-pasted with clean data
  const rows = cvFailRows(1);
  const row = Calc.duplicateAnalysis(rows, overridesFor(rows, 'PASS')).perPeptide[0];
  assert.strictEqual(row.autoStatus, 'fail');
  assert.strictEqual(row.override, null);
  assert.strictEqual(row.status, 'fail');
});

test('duplicateAnalysis: overrides only add to genuine CV failures, they never hide them', function () {
  const rows = cvFailRows(20).concat(mismatchRows(1));
  assert.strictEqual(Calc.duplicateAnalysis(rows).verdict, 'NEEDS_REVIEW');
  assert.strictEqual(Calc.duplicateAnalysis(rows, overridesFor(mismatchRows(1), 'PASS')).verdict, 'PASS');
  assert.strictEqual(Calc.duplicateAnalysis(rows, overridesFor(mismatchRows(1), 'FAIL')).verdict, 'FAIL');
});

test('rerunAnalysis: rerun replicates disagreeing among themselves (BLQ + concentration) is an intra-run mismatch', function () {
  const row = Object.assign({}, F5_ROW, { firstRun: [Calc.parseValue('NR')], rerun: [Calc.parseValue('95'), Calc.parseValue('BLQ<5')] });
  const result = Calc.rerunAnalysis([row]);
  assert.strictEqual(result.perPeptide[0].intraMismatch, true);
  assert.strictEqual(result.perPeptide[0].intraStatus, 'needs-review');
  assert.strictEqual(result.intraCounts.mismatchCount, 1);
});

test('rerunAnalysis: internally split rerun vs a real first-run value is an intra issue only — inter compares the concentrations', function () {
  const row = Object.assign({}, F5_ROW, { firstRun: [Calc.parseValue('100')], rerun: [Calc.parseValue('95'), Calc.parseValue('BLQ<5')] });
  const result = Calc.rerunAnalysis([row]);
  assert.strictEqual(result.perPeptide[0].intraMismatch, true);
  assert.strictEqual(result.perPeptide[0].interAgreement, 'numeric');
  assert.strictEqual(result.perPeptide[0].interMismatch, false);
});

test('rerunAnalysis: first-run BLQ but rerun detected a concentration is an inter-run mismatch', function () {
  const row = Object.assign({}, F5_ROW, { firstRun: [Calc.parseValue('BLQ<5')], rerun: [Calc.parseValue('40'), Calc.parseValue('42')] });
  const result = Calc.rerunAnalysis([row]);
  assert.strictEqual(result.perPeptide[0].intraMismatch, false); // rerun replicates agree with each other
  assert.strictEqual(result.perPeptide[0].interMismatch, true); // but disagree with first-run
  assert.strictEqual(result.interCounts.mismatchCount, 1);
});

test('rerunAnalysis: intra and inter overrides are independent', function () {
  const row = Object.assign({}, F5_ROW, { firstRun: [Calc.parseValue('BLQ<5')], rerun: [Calc.parseValue('40'), Calc.parseValue('BLQ<5')] });
  const overrides = {};
  overrides['inter:' + Calc.overrideKey(row)] = 'FAIL';
  const p = Calc.rerunAnalysis([row], overrides).perPeptide[0];
  assert.strictEqual(p.interStatus, 'fail');
  assert.strictEqual(p.interOverride, 'FAIL');
  assert.strictEqual(p.intraStatus, 'needs-review');
  assert.strictEqual(p.intraOverride, null);
});

test('rerunDecision: inter-run failures (incl. mismatches overridden to fail) alone fail inter-run agreement', function () {
  const intraCounts = { cv20: 0, failPeptideCount: 0 };
  const interCounts = { cv30: 0, failPeptideCount: 21 };
  const decision = Calc.rerunDecision(intraCounts, interCounts, {}, []);
  assert.strictEqual(decision.interVerdict, 'FAIL');
});

test('rerunDecision: pending mismatches that could flip a verdict hold the recommendation at needs-review', function () {
  const decision = Calc.rerunDecision({ cv20: 0, failPeptideCount: 0, needsReviewCount: 0 }, { cv30: 0, failPeptideCount: 0, needsReviewCount: 21 }, {}, []);
  assert.strictEqual(decision.interVerdict, 'NEEDS_REVIEW');
  assert.strictEqual(decision.recommendation, 'needs-review');
  assert.strictEqual(decision.reasonCode, 'PENDING_REVIEW');
});

test('poolPlasmaAnalysis: a BLQ/concentration mismatch between sides needs review, independent of CV%', function () {
  const firstRow = Object.assign({}, F5_ROW, { poolReplicates: [Calc.parseValue('BLQ<5')] });
  const rerunRow = Object.assign({}, F5_ROW, { poolReplicates: [Calc.parseValue('60')] });
  const result = Calc.poolPlasmaAnalysis([firstRow], [rerunRow]);
  assert.strictEqual(result.perPeptide[0].mismatch, true);
  assert.strictEqual(result.perPeptide[0].status, 'needs-review');
  assert.strictEqual(result.counts.mismatchCount, 1);
  assert.strictEqual(result.counts.cv30, 0); // no CV computable at all (single replicate each side)
  assert.strictEqual(result.counts.failPeptideCount, 0);
  assert.strictEqual(result.verdict, 'PASS'); // 1 pending peptide can't push past the >20 threshold
});

test('poolPlasmaAnalysis: cross-side mismatches overridden to FAIL push the verdict to FAIL', function () {
  const firstRows = [];
  const rerunRows = [];
  for (let i = 0; i < 21; i++) {
    firstRows.push(Object.assign({}, F5_ROW, { peptide: 'MISMATCH' + i, poolReplicates: [Calc.parseValue('BLQ<5')] }));
    rerunRows.push(Object.assign({}, F5_ROW, { peptide: 'MISMATCH' + i, poolReplicates: [Calc.parseValue('60')] }));
  }
  assert.strictEqual(Calc.poolPlasmaAnalysis(firstRows, rerunRows).verdict, 'NEEDS_REVIEW');
  const result = Calc.poolPlasmaAnalysis(firstRows, rerunRows, overridesFor(firstRows, 'FAIL'));
  assert.strictEqual(result.counts.cv30, 0);
  assert.strictEqual(result.counts.mismatchCount, 21);
  assert.strictEqual(result.verdict, 'FAIL');
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

test('rerunDecision: intra FAIL + inter PASS -> use-first-run (rerun disagrees internally, matches 228G789)', function () {
  const intra = { cv10: 0, cv20: 25, cv30: 0, validPeptideCount: 95 };  // cv20=25, >20 -> FAIL
  const inter = { cv10: 0, cv20: 0, cv30: 5, validPeptideCount: 95 };   // PASS
  const decision = Calc.rerunDecision(intra, inter, inBandRatioBuckets(95, 95), []);
  assert.strictEqual(decision.intraVerdict, 'FAIL');
  assert.strictEqual(decision.interVerdict, 'PASS');
  assert.strictEqual(decision.recommendation, 'use-first-run');
  assert.strictEqual(decision.reasonCode, 'INTRA_FAIL_INTER_PASS');
});

test('rerunDecision: both FAIL -> manual-review (not covered by Xukun\'s examples, so don\'t auto-decide)', function () {
  const intra = { cv10: 0, cv20: 25, cv30: 0, validPeptideCount: 95 };
  const inter = { cv10: 0, cv20: 0, cv30: 25, validPeptideCount: 95 };
  const decision = Calc.rerunDecision(intra, inter, inBandRatioBuckets(95, 95), []);
  assert.strictEqual(decision.intraVerdict, 'FAIL');
  assert.strictEqual(decision.interVerdict, 'FAIL');
  assert.strictEqual(decision.recommendation, 'manual-review');
});

test('rerunDecision: intra PASS but ratio out of band -> inter FAIL -> use-rerun (internally reproducible, matches 473G835)', function () {
  const intra = { cv10: 0, cv20: 5, cv30: 0, validPeptideCount: 95 };
  const inter = { cv10: 0, cv20: 0, cv30: 5, validPeptideCount: 95 };
  const decision = Calc.rerunDecision(intra, inter, inBandRatioBuckets(10, 95), []); // only 10/95 in band -> not majority
  assert.strictEqual(decision.interVerdict, 'FAIL');
  assert.strictEqual(decision.recommendation, 'use-rerun');
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

test('summarySentence: duplicate wording reports mismatches with their review state', function () {
  const rows = [Object.assign({}, F5_ROW, { peptide: 'A', replicates: [Calc.parseValue('50'), Calc.parseValue('BLQ<5')] }),
    Object.assign({}, F5_ROW, { peptide: 'B', replicates: [Calc.parseValue('NR'), Calc.parseValue('50')] })];
  const overrides = {};
  overrides[Calc.overrideKey(rows[0])] = 'PASS';
  const s = Calc.summarySentence('duplicate', Calc.duplicateAnalysis(rows, overrides));
  assert.strictEqual(s, 'Intra-run CV passed (0/0 peptides >20% CV, threshold is >20); 2 peptide(s) had a BLQ/NR mismatch (one replicate BLQ/NR, another not): 1 overridden to pass, 1 awaiting review.');
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
    'Inter-run CV passed for 1/2 samples; only X1 (40 peptides >20% CV) failed, both intra-run and inter-run CV failed; flagging for manual review rather than an automatic recommendation.'
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
// parseBarcodePrefix — leading letter is a category signal ("D" = Duplicate),
// distinct from matchBarcode's display-only canonicalization.
// ---------------------------------------------------------------------

test('parseBarcodePrefix: splits letter, run number, and bare ID', function () {
  assert.deepStrictEqual(Calc.parseBarcodePrefix('P1-552H937'), { letter: 'P', run: '1', bareId: '552H937' });
  assert.deepStrictEqual(Calc.parseBarcodePrefix('D1-552H937'), { letter: 'D', run: '1', bareId: '552H937' });
  assert.deepStrictEqual(Calc.parseBarcodePrefix('D4A-228G789'), { letter: 'D', run: '4A', bareId: '228G789' });
});

test('parseBarcodePrefix: lowercase letter still detected, normalized to uppercase', function () {
  const m = Calc.parseBarcodePrefix('d1-552h937');
  assert.strictEqual(m.letter, 'D');
  assert.strictEqual(m.bareId, '552h937');
});

test('parseBarcodePrefix: no recognized prefix -> letter/run null, bareId is the raw trimmed string', function () {
  assert.deepStrictEqual(Calc.parseBarcodePrefix('228G789'), { letter: null, run: null, bareId: '228G789' });
  assert.deepStrictEqual(Calc.parseBarcodePrefix('  552H937  '), { letter: null, run: null, bareId: '552H937' });
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
