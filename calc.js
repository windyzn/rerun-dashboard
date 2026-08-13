/**
 * calc.js — pure calculation functions for the Rerun Sample QC dashboard.
 *
 * No DOM, no localStorage, no `window` reference inside the functions themselves —
 * this file works both as a <script src="calc.js"> (exposes window.Calc) and under
 * plain Node (module.exports), so the math can be unit-tested with `node calc.test.js`
 * without any build step or test framework.
 *
 * Invariant enforced everywhere: NaN never enters an array that feeds mean/sd/counts.
 * Anything that isn't a clean finite number (BLQ, NR, Excel error strings, blanks,
 * garbage) is parsed into an excluded ParsedValue instead and filtered out by callers
 * before any arithmetic happens.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------
  // 1. Value parsing
  // ---------------------------------------------------------------------

  /**
   * @typedef {Object} ParsedValue
   * @property {string} raw - original string as pasted (trimmed)
   * @property {'numeric'|'blq'|'nr'|'error'|'empty'} kind
   * @property {number|null} value - the numeric value, only set when kind === 'numeric'
   * @property {number|null} blqLimit - the X in "BLQ < X", only set when kind === 'blq'
   */

  /**
   * Parse one pasted cell string into a typed value. Never throws.
   * @param {string|number|null|undefined} rawInput
   * @returns {ParsedValue}
   */
  function parseValue(rawInput) {
    const raw = rawInput == null ? '' : String(rawInput).trim();

    if (raw === '') {
      return { raw, kind: 'empty', value: null, blqLimit: null };
    }

    const blqMatch = raw.match(/^BLQ\s*<\s*([\d.]+)/i);
    if (blqMatch) {
      const limit = Number(blqMatch[1]);
      return { raw, kind: 'blq', value: null, blqLimit: Number.isFinite(limit) ? limit : null };
    }

    if (/^NR$/i.test(raw)) {
      return { raw, kind: 'nr', value: null, blqLimit: null };
    }

    if (raw.charAt(0) === '#') {
      // Excel error strings: #DIV/0!, #VALUE!, #N/A, etc. — exclude, never propagate as NaN.
      return { raw, kind: 'error', value: null, blqLimit: null };
    }

    const num = Number(raw);
    if (Number.isFinite(num)) {
      return { raw, kind: 'numeric', value: num, blqLimit: null };
    }

    // Unrecognized garbage — treat as excluded, never let it become NaN downstream.
    return { raw, kind: 'error', value: null, blqLimit: null };
  }

  /**
   * True if this parsed value should be excluded from CV/mean/ratio calcs and from
   * the valid-count denominator for that comparison.
   * @param {ParsedValue} parsed
   * @returns {boolean}
   */
  function isExcluded(parsed) {
    return !parsed || parsed.kind !== 'numeric';
  }

  /**
   * Given an array of ParsedValue, return just the numeric values (already filtered).
   * @param {ParsedValue[]} parsedValues
   * @returns {number[]}
   */
  function numericValues(parsedValues) {
    return (parsedValues || [])
      .filter(function (p) { return !isExcluded(p); })
      .map(function (p) { return p.value; });
  }

  /**
   * True if every entry in a set of ParsedValues agrees on the same excluded
   * kind (e.g. every replicate is BLQ, or every replicate is NR). This is a
   * real, agreeing result — both/all replicates consistently below the
   * detection limit, or consistently not reported — not a discrepancy, so
   * callers should NOT treat it the same as a genuine mismatch (one BLQ +
   * one numeric, BLQ mixed with NR, etc).
   * @param {ParsedValue[]} parsedValues
   * @param {'blq'|'nr'} kind
   * @returns {boolean}
   */
  function allShareExcludedKind(parsedValues, kind) {
    const list = parsedValues || [];
    if (list.length === 0) return false;
    return list.every(function (p) { return p && p.kind === kind; });
  }

  /**
   * True if a set of replicates that couldn't produce a numeric result is
   * nonetheless a consistent (agreeing) result — every replicate BLQ, or
   * every replicate NR — rather than a real mismatch.
   * @param {ParsedValue[]} parsedValues
   * @returns {boolean}
   */
  function isConsistentNonNumericAgreement(parsedValues) {
    return allShareExcludedKind(parsedValues, 'blq') || allShareExcludedKind(parsedValues, 'nr');
  }

  /**
   * True if at least one entry in a set of ParsedValues is the given kind.
   * @param {ParsedValue[]} parsedValues
   * @param {'numeric'|'blq'|'nr'|'error'|'empty'} kind
   * @returns {boolean}
   */
  function hasKind(parsedValues, kind) {
    return (parsedValues || []).some(function (p) { return p && p.kind === kind; });
  }

  /**
   * Xukun's rule: if every replicate being compared agrees they're BLQ, that's
   * a clean pass (still below the detection limit). If some are BLQ and
   * others carry a real measured concentration, that's a genuine disagreement
   * — one replicate detected the analyte, the other didn't — and it FAILS,
   * regardless of what the CV% would say (a CV can't even be computed from
   * only one concentration). This is a distinct failure mode from CV% and is
   * always checked in addition to it, never instead of it.
   * @param {ParsedValue[]} parsedValues
   * @returns {boolean}
   */
  function hasBlqNumericMismatch(parsedValues) {
    return hasKind(parsedValues, 'blq') && hasKind(parsedValues, 'numeric');
  }

  // ---------------------------------------------------------------------
  // 2. Shared primitives
  // ---------------------------------------------------------------------

  /**
   * Arithmetic mean of a numeric array.
   * @param {number[]} values
   * @returns {number|null} null if empty
   */
  function mean(values) {
    if (!values || values.length === 0) return null;
    const sum = values.reduce(function (a, b) { return a + b; }, 0);
    return sum / values.length;
  }

  /**
   * Sample standard deviation (n-1 denominator — the biotech CV convention used
   * throughout this app).
   * @param {number[]} values
   * @returns {number|null} null if fewer than 2 values
   */
  function sd(values) {
    if (!values || values.length < 2) return null;
    const m = mean(values);
    const sumSq = values.reduce(function (acc, v) { return acc + Math.pow(v - m, 2); }, 0);
    return Math.sqrt(sumSq / (values.length - 1));
  }

  /**
   * CV% = SD / Mean * 100 over already-filtered numeric values.
   * @param {number[]} values - pre-filtered numeric values (caller excludes BLQ/NR/error first)
   * @returns {number|null} null if fewer than 2 valid values (CV undefined for n<2) —
   *   callers must render this as "N/A (n<2)" or "Excluded", never 0.
   */
  function cvPercent(values) {
    if (!values || values.length < 2) return null;
    const m = mean(values);
    if (m === 0) return null; // avoid divide-by-zero; CV undefined at mean 0
    return (sd(values) / m) * 100;
  }

  /**
   * Ratio = mean(rerun replicates) / mean(first-run replicates). Works whether
   * there's 1, 2, or 3 replicates on either side (mean of 1 value is itself).
   * @param {number[]} firstRunValues - pre-filtered numeric values
   * @param {number[]} rerunValues - pre-filtered numeric values
   * @returns {number|null} null if either side has zero valid values (undefined ratio)
   */
  function ratio(firstRunValues, rerunValues) {
    const f = mean(firstRunValues);
    const r = mean(rerunValues);
    if (f == null || r == null || f === 0) return null;
    return r / f;
  }

  // Ratio distribution buckets, half-open [lo, hi) so every finite ratio lands in
  // exactly one bucket. Normal/acceptable band is the union of 0.8-0.9 .. 1.1-1.2.
  const RATIO_BUCKETS = [
    { label: '<0.7', test: function (r) { return r < 0.7; } },
    { label: '0.7-0.8', test: function (r) { return r >= 0.7 && r < 0.8; } },
    { label: '0.8-0.9', test: function (r) { return r >= 0.8 && r < 0.9; } },
    { label: '0.9-1.0', test: function (r) { return r >= 0.9 && r < 1.0; } },
    { label: '1.0-1.1', test: function (r) { return r >= 1.0 && r < 1.1; } },
    { label: '1.1-1.2', test: function (r) { return r >= 1.1 && r < 1.2; } },
    { label: '1.2-1.3', test: function (r) { return r >= 1.2 && r < 1.3; } },
    { label: '>=1.3', test: function (r) { return r >= 1.3; } }
  ];

  /**
   * @param {number|null} r
   * @returns {string|null} bucket label, or null if r is null
   */
  function bucketForRatio(r) {
    if (r == null) return null;
    for (let i = 0; i < RATIO_BUCKETS.length; i++) {
      if (RATIO_BUCKETS[i].test(r)) return RATIO_BUCKETS[i].label;
    }
    return null; // unreachable — buckets are exhaustive over the real number line
  }

  /**
   * Every magic number used by the analysis engine, in one place, so the UI can
   * render each threshold next to its "unconfirmed with Xukun" flag from a single
   * source of truth (see ASSUMPTIONS below).
   */
  const THRESHOLDS = {
    duplicateCvFailPeptideCount: 20,   // >20 biomarkers CV>20% -> FAIL (duplicate/VIP)
    duplicateCvFailPercent: 20,
    rerunIntraFailPeptideCount: 20,    // same peptide-count cutoff reused for rerun intra check
    rerunIntraFailPercent: 20,
    rerunInterFailPeptideCount: 20,
    rerunInterFailPercent: 30,
    rerunRatioBandLo: 0.8,
    rerunRatioBandHi: 1.2,
    poolPlasmaCvFailPeptideCount: 20,  // SAME peptide-count cutoff, DIFFERENT % cutoff than duplicate/VIP
    poolPlasmaCvFailPercent: 30,
    directionalDriftFraction: 0.6      // >=60% of samples shifting the same ratio direction -> batch drift flag
  };

  // "Most/all samples in a batch" (directional drift, batch-level escalation) requires
  // an actual batch to be meaningful — below this many samples, those checks always
  // report not-flagged rather than trivially firing on a single sample.
  const MIN_SAMPLES_FOR_BATCH_SIGNAL = 2;

  /**
   * Remaining open questions NOT confirmed with Xukun (as of Aug 7, 2026 — several
   * earlier assumptions were resolved in that round and removed from this list:
   * both CV thresholds are locked in as intentionally different, the tag/category
   * vocabulary is locked in, and barcode linking is now always an explicit user
   * choice rather than a heuristic, so there's no "auto-match confidence" to flag).
   * The UI reads this array as the single source of truth for every caveat banner
   * and inline tooltip — never duplicate this text elsewhere.
   */
  const ASSUMPTIONS = [
    {
      id: 'inter-run-cv-definition',
      text: 'Inter-run CV is computed as the CV of the two group means — cv([mean(first-run), mean(rerun)]) — rather than pooling every individual replicate together. The brief\'s wording ("CV between first-run and mean(rerun)") is a little ambiguous; this is the interpretation this build uses.'
    },
    {
      id: 'directional-drift-fraction',
      text: 'The directional-drift and batch-level-escalation flags trigger at a 60% same-direction / same-fail threshold, and only once a batch has at least ' + MIN_SAMPLES_FOR_BATCH_SIGNAL + ' samples (below that, "most/all samples" isn\'t a meaningful signal). Xukun asked that systematic drift be auto-flagged rather than left as a chart to eyeball; the exact percentage/minimum-batch-size cutoffs are this build\'s placeholders, not confirmed numbers.'
    }
  ];

  /**
   * Column category (single-select, locked in with Xukun Aug 7, 2026). Every sample
   * column has exactly one of these. "First-run" doubles as the generic anchor entry
   * that Rerun/Duplicate columns link to — even for a same-run duplicate pair with no
   * true prior run, one of the two columns is tagged First-run as the anchor.
   * VIP is tracked separately (see SampleColumn.vip) — it's an independent, stackable
   * flag, not a category.
   */
  const CATEGORY_VOCABULARY = ['First-run', 'Rerun', 'Duplicate', 'Pool plasma'];

  // ---------------------------------------------------------------------
  // 3. Analysis-type batch calculators
  // ---------------------------------------------------------------------

  /**
   * Count how many of a set of per-peptide CV values exceed each of 10/20/30%.
   * @param {(number|null)[]} cvValues
   * @returns {{cv10:number, cv20:number, cv30:number}}
   */
  function countCvThresholds(cvValues) {
    let cv10 = 0, cv20 = 0, cv30 = 0;
    cvValues.forEach(function (cv) {
      if (cv == null) return;
      if (cv > 10) cv10++;
      if (cv > 20) cv20++;
      if (cv > 30) cv30++;
    });
    return { cv10: cv10, cv20: cv20, cv30: cv30 };
  }

  /**
   * @typedef {Object} DuplicateRowInput
   * @property {string} protein
   * @property {string} mycoId
   * @property {string} peptideId
   * @property {string} peptide
   * @property {number} lloq
   * @property {number} uloq
   * @property {ParsedValue[]} replicates - 2 or 3 entries, same run
   */

  /**
   * Duplicate / VIP analysis (simplest, no inter-run comparison, no ratio).
   * @param {DuplicateRowInput[]} rows
   * @returns {Object} BatchResult
   */
  function duplicateAnalysis(rows) {
    const perPeptide = (rows || []).map(function (row) {
      const numeric = numericValues(row.replicates);
      const validCount = numeric.length;
      const intraCv = validCount >= 2 ? cvPercent(numeric) : null;
      // All-BLQ or all-NR replicates agree with each other — that's a clean
      // result (consistently below the detection limit / not reported), not
      // a discrepancy, so it shouldn't be treated the same as a real
      // mismatch (e.g. one BLQ + one numeric).
      const excluded = validCount === 0 && !isConsistentNonNumericAgreement(row.replicates);
      // Xukun's rule: some replicates BLQ and others carrying a real
      // concentration is a fail on its own — independent of (and in addition
      // to) the CV% check, since a CV can't even be computed from just one
      // numeric replicate.
      const blqMismatch = hasBlqNumericMismatch(row.replicates);
      return {
        protein: row.protein, mycoId: row.mycoId, peptideId: row.peptideId,
        peptide: row.peptide, lloq: row.lloq, uloq: row.uloq,
        replicates: row.replicates, validCount: validCount,
        excluded: excluded,
        blqMismatch: blqMismatch,
        intraCv: intraCv
      };
    });

    const cvCounts = countCvThresholds(perPeptide.map(function (p) { return p.intraCv; }));
    const validPeptideCount = perPeptide.filter(function (p) { return p.validCount >= 2; }).length;
    const blqMismatchCount = perPeptide.filter(function (p) { return p.blqMismatch; }).length;
    const failPeptideCount = cvCounts.cv20 + blqMismatchCount;
    const verdict = failPeptideCount > THRESHOLDS.duplicateCvFailPeptideCount ? 'FAIL' : 'PASS';

    return {
      type: 'duplicate',
      perPeptide: perPeptide,
      counts: {
        cv10: cvCounts.cv10, cv20: cvCounts.cv20, cv30: cvCounts.cv30, validPeptideCount: validPeptideCount,
        blqMismatchCount: blqMismatchCount, failPeptideCount: failPeptideCount
      },
      verdict: verdict
    };
  }

  /**
   * Inter-run CV, defined as the CV of the two group means (see ASSUMPTIONS:
   * 'inter-run-cv-definition') — i.e. plate-to-plate variability, not a pooled
   * intra+inter conflation.
   * @param {number[]} firstNumeric
   * @param {number[]} rerunNumeric
   * @returns {number|null}
   */
  function interRunCv(firstNumeric, rerunNumeric) {
    const f = mean(firstNumeric);
    const r = mean(rerunNumeric);
    if (f == null || r == null) return null;
    return cvPercent([f, r]);
  }

  /**
   * @typedef {Object} RerunRowInput
   * @property {string} protein
   * @property {string} mycoId
   * @property {string} peptideId
   * @property {string} peptide
   * @property {number} lloq
   * @property {number} uloq
   * @property {ParsedValue[]} firstRun - usually 1 replicate
   * @property {ParsedValue[]} rerun - 1-3 replicates
   */

  /**
   * Rerun comparison analysis.
   * @param {RerunRowInput[]} rows
   * @returns {Object} BatchResult (verdict/recommendation computed separately by rerunDecision)
   */
  function rerunAnalysis(rows) {
    const perPeptide = (rows || []).map(function (row) {
      const firstNumeric = numericValues(row.firstRun);
      const rerunNumeric = numericValues(row.rerun);
      const intraCv = rerunNumeric.length >= 2 ? cvPercent(rerunNumeric) : null;
      const r = ratio(firstNumeric, rerunNumeric);
      const interCv = interRunCv(firstNumeric, rerunNumeric);
      // Both sides consistently BLQ, or both sides consistently NR, is a clean
      // agreeing result (e.g. still below the detection limit after rerun) —
      // not a discrepancy — so don't flag it the same as a real mismatch
      // (first-run detected a value but the rerun didn't, or vice versa).
      const bothSidesAgree = (allShareExcludedKind(row.firstRun, 'blq') && allShareExcludedKind(row.rerun, 'blq')) ||
        (allShareExcludedKind(row.firstRun, 'nr') && allShareExcludedKind(row.rerun, 'nr'));
      const excluded = (firstNumeric.length === 0 || rerunNumeric.length === 0) && !bothSidesAgree;
      // Xukun's rule, applied on two axes: the rerun's OWN replicates disagreeing
      // on BLQ vs numeric is an intra-run problem (independent of intra-CV%);
      // first-run vs rerun disagreeing is an inter-run problem (independent of
      // inter-CV%) — one run detected the analyte, the other didn't.
      const intraBlqMismatch = hasBlqNumericMismatch(row.rerun);
      const interBlqMismatch = (hasKind(row.firstRun, 'blq') && rerunNumeric.length > 0) ||
        (firstNumeric.length > 0 && hasKind(row.rerun, 'blq'));
      return {
        protein: row.protein, mycoId: row.mycoId, peptideId: row.peptideId,
        peptide: row.peptide, lloq: row.lloq, uloq: row.uloq,
        firstRun: row.firstRun, rerun: row.rerun,
        firstRunValidCount: firstNumeric.length, rerunValidCount: rerunNumeric.length,
        excluded: excluded,
        intraBlqMismatch: intraBlqMismatch, interBlqMismatch: interBlqMismatch,
        intraCv: intraCv, ratio: r, ratioBucket: bucketForRatio(r), interCv: interCv
      };
    });

    const intraCounts = countCvThresholds(perPeptide.map(function (p) { return p.intraCv; }));
    const interCounts = countCvThresholds(perPeptide.map(function (p) { return p.interCv; }));
    const intraValidPeptideCount = perPeptide.filter(function (p) { return p.rerunValidCount >= 2; }).length;
    const interValidPeptideCount = perPeptide.filter(function (p) { return p.ratio != null; }).length;
    const intraBlqMismatchCount = perPeptide.filter(function (p) { return p.intraBlqMismatch; }).length;
    const interBlqMismatchCount = perPeptide.filter(function (p) { return p.interBlqMismatch; }).length;

    const ratioBuckets = {};
    RATIO_BUCKETS.forEach(function (b) { ratioBuckets[b.label] = 0; });
    perPeptide.forEach(function (p) {
      if (p.ratioBucket != null) ratioBuckets[p.ratioBucket]++;
    });

    return {
      type: 'rerun',
      perPeptide: perPeptide,
      intraCounts: {
        cv10: intraCounts.cv10, cv20: intraCounts.cv20, cv30: intraCounts.cv30, validPeptideCount: intraValidPeptideCount,
        blqMismatchCount: intraBlqMismatchCount, failPeptideCount: intraCounts.cv20 + intraBlqMismatchCount
      },
      interCounts: {
        cv10: interCounts.cv10, cv20: interCounts.cv20, cv30: interCounts.cv30, validPeptideCount: interValidPeptideCount,
        blqMismatchCount: interBlqMismatchCount, failPeptideCount: interCounts.cv30 + interBlqMismatchCount
      },
      ratioBuckets: ratioBuckets
    };
  }

  /**
   * @typedef {Object} PoolPlasmaRowInput
   * @property {string} protein
   * @property {string} mycoId
   * @property {string} peptideId
   * @property {string} peptide
   * @property {number} lloq
   * @property {number} uloq
   * @property {ParsedValue[]} poolReplicates
   */

  /**
   * Pool plasma analysis for ONE (first-run batch, rerun batch) pairing. Callers
   * must invoke this once per pairing when a rerun batch spans 2-3 first-run
   * batches — never average pool-plasma values across batches.
   * @param {PoolPlasmaRowInput[]} firstRunPoolRows
   * @param {PoolPlasmaRowInput[]} rerunPoolRows - same row order/length as firstRunPoolRows
   * @returns {Object} BatchResult
   */
  function poolPlasmaAnalysis(firstRunPoolRows, rerunPoolRows) {
    const n = Math.min((firstRunPoolRows || []).length, (rerunPoolRows || []).length);
    const perPeptide = [];
    for (let i = 0; i < n; i++) {
      const firstRow = firstRunPoolRows[i];
      const rerunRow = rerunPoolRows[i];
      const firstNumeric = numericValues(firstRow.poolReplicates);
      const rerunNumeric = numericValues(rerunRow.poolReplicates);
      const firstIntraCv = firstNumeric.length >= 2 ? cvPercent(firstNumeric) : null;
      const rerunIntraCv = rerunNumeric.length >= 2 ? cvPercent(rerunNumeric) : null;
      const r = ratio(firstNumeric, rerunNumeric);
      // Xukun's rule, applied across BOTH sides together — side A and side B
      // are literally "two samples" being compared here: if either side's own
      // replicates disagree on BLQ vs numeric, or the two sides disagree with
      // each other, that's a fail independent of CV%.
      const blqMismatch = hasBlqNumericMismatch((firstRow.poolReplicates || []).concat(rerunRow.poolReplicates || []));
      perPeptide.push({
        protein: firstRow.protein, mycoId: firstRow.mycoId, peptideId: firstRow.peptideId,
        peptide: firstRow.peptide, lloq: firstRow.lloq, uloq: firstRow.uloq,
        firstRunReplicates: firstRow.poolReplicates, rerunReplicates: rerunRow.poolReplicates,
        firstIntraCv: firstIntraCv, rerunIntraCv: rerunIntraCv, blqMismatch: blqMismatch,
        ratio: r, ratioBucket: bucketForRatio(r)
      });
    }

    // Intra-run CV check is evaluated against the rerun-batch pool plasma replicates
    // (the batch being qualified), same primitive as duplicateAnalysis but against
    // the pool-plasma 30% threshold (see ASSUMPTIONS: 'threshold-inconsistency').
    const cvCounts = countCvThresholds(perPeptide.map(function (p) { return p.rerunIntraCv; }));
    const validPeptideCount = perPeptide.filter(function (p) { return p.rerunIntraCv != null; }).length;
    const blqMismatchCount = perPeptide.filter(function (p) { return p.blqMismatch; }).length;
    const failPeptideCount = cvCounts.cv30 + blqMismatchCount;
    const verdict = failPeptideCount > THRESHOLDS.poolPlasmaCvFailPeptideCount ? 'FAIL' : 'PASS';

    const ratioBuckets = {};
    RATIO_BUCKETS.forEach(function (b) { ratioBuckets[b.label] = 0; });
    perPeptide.forEach(function (p) {
      if (p.ratioBucket != null) ratioBuckets[p.ratioBucket]++;
    });

    return {
      type: 'poolPlasma',
      perPeptide: perPeptide,
      counts: {
        cv10: cvCounts.cv10, cv20: cvCounts.cv20, cv30: cvCounts.cv30, validPeptideCount: validPeptideCount,
        blqMismatchCount: blqMismatchCount, failPeptideCount: failPeptideCount
      },
      ratioBuckets: ratioBuckets,
      verdict: verdict
    };
  }

  // ---------------------------------------------------------------------
  // 4. Decision logic (rerun comparison only)
  // ---------------------------------------------------------------------

  /**
   * Sum the ratio-bucket counts that fall inside the acceptable band (0.8-0.9,
   * 0.9-1.0, 1.0-1.1, 1.1-1.2 → i.e. [0.8, 1.2)).
   * @param {Record<string, number>} ratioBuckets
   * @returns {number}
   */
  function acceptableBandCount(ratioBuckets) {
    const bandLabels = ['0.8-0.9', '0.9-1.0', '1.0-1.1', '1.1-1.2'];
    return bandLabels.reduce(function (sum, label) { return sum + (ratioBuckets[label] || 0); }, 0);
  }

  /**
   * Batch-wide directional drift check: if most/all samples in a batch shift the
   * same ratio direction, that's a systematic (plate/instrument) issue rather than
   * N independent sample issues.
   * @param {{sampleId:string, ratio:number}[]} perSampleRatios - one aggregate ratio per sample
   * @param {number} [fraction] - defaults to THRESHOLDS.directionalDriftFraction
   * @returns {{flagged:boolean, direction:('up'|'down'|null), fraction:number}}
   */
  function directionalDriftFlag(perSampleRatios, fraction) {
    fraction = fraction == null ? THRESHOLDS.directionalDriftFraction : fraction;
    const list = perSampleRatios || [];
    // "Most/all samples shifting the same direction" is not a meaningful signal with
    // fewer than MIN_SAMPLES_FOR_BATCH_SIGNAL samples — a single sample trivially
    // satisfies "100% shifted one way" and would otherwise always flag.
    if (list.length < MIN_SAMPLES_FOR_BATCH_SIGNAL) return { flagged: false, direction: null, fraction: 0 };

    let up = 0, down = 0;
    list.forEach(function (s) {
      if (s.ratio > 1) up++;
      else if (s.ratio < 1) down++;
    });

    const total = list.length;
    const upFraction = up / total;
    const downFraction = down / total;
    const maxFraction = Math.max(upFraction, downFraction);
    const direction = upFraction >= downFraction ? 'up' : 'down';

    return {
      flagged: maxFraction >= fraction,
      direction: maxFraction >= fraction ? direction : null,
      fraction: maxFraction
    };
  }

  /**
   * Batch-wide escalation signal: most duplicates in the batch failing intra-run CV
   * means the whole batch should go back to the vendor, independent of any single
   * sample's inter-run agreement.
   * @param {('PASS'|'FAIL')[]} perSampleIntraVerdicts
   * @param {number} [fraction] - defaults to THRESHOLDS.directionalDriftFraction
   * @returns {{flagged:boolean, failFraction:number}}
   */
  function batchLevelEscalation(perSampleIntraVerdicts, fraction) {
    fraction = fraction == null ? THRESHOLDS.directionalDriftFraction : fraction;
    const list = perSampleIntraVerdicts || [];
    // Same rationale as directionalDriftFlag: "most duplicates in the batch" implies
    // an actual batch, not a single sample trivially being 100% of itself.
    if (list.length < MIN_SAMPLES_FOR_BATCH_SIGNAL) return { flagged: false, failFraction: 0 };
    const failFraction = list.filter(function (v) { return v === 'FAIL'; }).length / list.length;
    return { flagged: failFraction >= fraction, failFraction: failFraction };
  }

  /**
   * Core rerun comparison decision logic (brief §3.2).
   * @param {{cv10:number, cv20:number, cv30:number, validPeptideCount:number}} intraCounts
   * @param {{cv10:number, cv20:number, cv30:number, validPeptideCount:number}} interCounts
   * @param {Record<string, number>} ratioBuckets - label -> count, from rerunAnalysis
   * @param {{sampleId:string, ratio:number}[]} [perSampleRatios] - used only for the directional-drift check
   * @returns {{intraVerdict:('PASS'|'FAIL'), interVerdict:('PASS'|'FAIL'), recommendation:('use-first-run'|'use-rerun'|'manual-review'|'escalate-vendor'), directionalDrift:Object, reasonCode:string}}
   */
  function rerunDecision(intraCounts, interCounts, ratioBuckets, perSampleRatios) {
    // failPeptideCount folds in Xukun's BLQ/concentration-mismatch rule
    // alongside the CV% count; fall back to raw cv20/cv30 for callers that
    // pass in counts objects from before that field existed.
    const intraFailCount = intraCounts.failPeptideCount != null ? intraCounts.failPeptideCount : intraCounts.cv20;
    const interFailCount = interCounts.failPeptideCount != null ? interCounts.failPeptideCount : interCounts.cv30;
    const intraFail = intraFailCount > THRESHOLDS.rerunIntraFailPeptideCount;

    const totalBuckets = Object.keys(ratioBuckets || {}).reduce(function (sum, k) { return sum + ratioBuckets[k]; }, 0);
    const inBand = acceptableBandCount(ratioBuckets || {});
    // "ratio in band" = majority of peptides land in the 0.8-1.2 acceptable band.
    const ratioInBand = totalBuckets === 0 ? true : (inBand / totalBuckets) >= 0.5;
    const interFail = interFailCount > THRESHOLDS.rerunInterFailPeptideCount || !ratioInBand;

    const drift = directionalDriftFlag(perSampleRatios || []);

    // Corrected decision table (Aug 12 revision — the original draft had the two
    // single-axis-fail branches backwards; verified against Xukun's real examples
    // 228G789 and 473G835):
    //   intra PASS, inter PASS -> either run is fine; report first-run, rerun is research-only
    //   intra PASS, inter FAIL -> use RERUN (it's internally reproducible; first-run is the likely outlier — matches 473G835)
    //   intra FAIL, inter PASS -> use FIRST-RUN (the rerun replicates disagree with each other, so neither is
    //                             trustworthy even though their average happens to land near first-run — matches 228G789)
    //   intra FAIL, inter FAIL -> not covered by Xukun's examples; flag for manual review, don't auto-decide
    // "escalate-vendor" is reserved for the separate batch-wide signal in batchLevelEscalation() below,
    // not returned from this per-sample table.
    let recommendation, reasonCode;
    if (!intraFail && !interFail) {
      recommendation = 'use-first-run';
      reasonCode = 'INTRA_PASS_INTER_PASS';
    } else if (!intraFail && interFail) {
      recommendation = 'use-rerun';
      reasonCode = 'INTRA_PASS_INTER_FAIL';
    } else if (intraFail && !interFail) {
      recommendation = 'use-first-run';
      reasonCode = 'INTRA_FAIL_INTER_PASS';
    } else {
      recommendation = 'manual-review';
      reasonCode = 'INTRA_FAIL_INTER_FAIL';
    }
    if (drift.flagged) reasonCode = 'SYSTEMATIC_DRIFT'; // batch-level flag augments, doesn't replace, the recommendation

    return {
      intraVerdict: intraFail ? 'FAIL' : 'PASS',
      interVerdict: interFail ? 'FAIL' : 'PASS',
      recommendation: recommendation,
      directionalDrift: drift,
      reasonCode: reasonCode
    };
  }

  // ---------------------------------------------------------------------
  // 5. Rule-based sentence generator
  // ---------------------------------------------------------------------

  // Every clause is written as a lowercase continuation (it's normally joined onto a
  // preceding sentence with ", "). capitalize() is used where a clause instead has to
  // start a fresh sentence after a period.
  const REASON_CLAUSES = {
    INTRA_PASS_INTER_PASS: 'both intra-run and inter-run agreement passed; using first-run data for reporting, with the rerun marked as research-only.',
    INTRA_FAIL_INTER_PASS: 'intra-run CV failed, so the rerun replicates disagree with each other and neither individual value can be trusted, even though their average happens to land near first-run; using first-run for reporting, with the rerun marked as research-only.',
    INTRA_PASS_INTER_FAIL: 'indicating a plate-to-plate shift rather than duplicate imprecision.',
    INTRA_FAIL_INTER_FAIL: 'both intra-run and inter-run CV failed; flagging for manual review rather than an automatic recommendation.',
    SYSTEMATIC_DRIFT: 'indicating a systematic drift across the batch rather than isolated sample issues; recommend escalating to the vendor.'
  };

  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /**
   * Deterministic, rule-based one-paragraph write-up from already-computed counts.
   * No LLM, no free text — every branch here is enumerable and testable.
   * @param {'duplicate'|'rerun'|'poolPlasma'} type
   * @param {Object} batchResult - output of the relevant *Analysis() function
   * @param {Object} [decision] - output of rerunDecision(), required when type === 'rerun'
   * @param {{sampleId:string, interCv20Count:number, intraVerdict:string}[]} [perSampleSummary] - used for rerun's "only X failed" clause
   * @returns {string}
   */
  function summarySentence(type, batchResult, decision, perSampleSummary) {
    if (type === 'duplicate') {
      const c = batchResult.counts;
      const mismatchClause = c.blqMismatchCount > 0
        ? '; ' + c.blqMismatchCount + ' peptide(s) had a BLQ/concentration mismatch (one replicate detected, another didn\'t)' : '';
      return 'Intra-run CV ' + (batchResult.verdict === 'PASS' ? 'passed' : 'FAILED') +
        ' (' + c.cv20 + '/' + c.validPeptideCount + ' peptides >20% CV, threshold is >' +
        THRESHOLDS.duplicateCvFailPeptideCount + ')' + mismatchClause + '.';
    }

    if (type === 'poolPlasma') {
      const c = batchResult.counts;
      const mismatchClause = c.blqMismatchCount > 0
        ? '; ' + c.blqMismatchCount + ' peptide(s) had a BLQ/concentration mismatch between sides' : '';
      return 'Pool plasma intra-run CV ' + (batchResult.verdict === 'PASS' ? 'passed' : 'FAILED') +
        ' (' + c.cv30 + '/' + c.validPeptideCount + ' peptides >30% CV, threshold is >' +
        THRESHOLDS.poolPlasmaCvFailPeptideCount + ')' + mismatchClause + '.';
    }

    if (type === 'rerun') {
      const samples = perSampleSummary || [];
      const total = samples.length;
      const failedSamples = samples.filter(function (s) { return s.interVerdict === 'FAIL'; });
      const passCount = total - failedSamples.length;

      let sentence = total > 0
        ? 'Inter-run CV passed for ' + passCount + '/' + total + ' samples'
        : 'Inter-run CV ' + (decision.interVerdict === 'PASS' ? 'passed' : 'FAILED');

      if (failedSamples.length > 0 && failedSamples.length <= 2) {
        const names = failedSamples.map(function (s) {
          return s.sampleId + ' (' + s.interCv20Count + ' peptides >20% CV)';
        }).join(' and ');
        sentence += '; only ' + names + ' failed';
        if (failedSamples[0].intraVerdict === 'PASS') {
          sentence += ', despite passing intra-run CV';
        }
        sentence += ', ' + (REASON_CLAUSES[decision.reasonCode] || REASON_CLAUSES.INTRA_PASS_INTER_FAIL);
      } else if (failedSamples.length > 2) {
        sentence += '. ' + capitalize(REASON_CLAUSES.SYSTEMATIC_DRIFT);
      } else {
        sentence += '. ' + capitalize(REASON_CLAUSES[decision.reasonCode] || '');
      }

      return sentence.trim();
    }

    return '';
  }

  // ---------------------------------------------------------------------
  // 6. Barcode canonicalization
  // ---------------------------------------------------------------------

  // Known prefixes observed in real barcode data (e.g. "P1-228G789", "P4A-228G789").
  // Real data shows the SAME prefix can appear on both a first-run and a rerun column
  // for one sample (e.g. both "P1-473G835"), so prefix alone can never reliably tell
  // first-run from rerun — linking which column ties to which is always an explicit
  // user choice (see index.html), never inferred here. This function is display-only:
  // it gives a short canonical label to show in column lists/link-picker dropdowns.
  const KNOWN_PREFIXES = /^P\d[A-Z]?-/i;

  /**
   * Strip a known prefix from a barcode/sample ID to get a short canonical display
   * label. Not used for any auto-matching/grouping decision.
   * @param {string} raw
   * @returns {{canonical:string, prefix:string|null, confidence:('high'|'low')}}
   */
  function matchBarcode(raw) {
    const trimmed = (raw == null ? '' : String(raw)).trim();
    if (trimmed === '') return { canonical: '', prefix: null, confidence: 'low' };

    const match = trimmed.match(KNOWN_PREFIXES);
    if (match) {
      return { canonical: trimmed.slice(match[0].length), prefix: match[0], confidence: 'high' };
    }

    // No recognized prefix. A bare alphanumeric barcode (e.g. "228G789") is still
    // high confidence — it's the recognized *no-prefix* case. Anything containing
    // unexpected separators/characters is low confidence and needs manual review.
    if (/^[A-Za-z0-9]+$/.test(trimmed)) {
      return { canonical: trimmed, prefix: null, confidence: 'high' };
    }

    return { canonical: trimmed, prefix: null, confidence: 'low' };
  }

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------

  const api = {
    parseValue: parseValue,
    isExcluded: isExcluded,
    numericValues: numericValues,
    allShareExcludedKind: allShareExcludedKind,
    hasKind: hasKind,
    hasBlqNumericMismatch: hasBlqNumericMismatch,
    isConsistentNonNumericAgreement: isConsistentNonNumericAgreement,
    mean: mean,
    sd: sd,
    cvPercent: cvPercent,
    ratio: ratio,
    RATIO_BUCKETS: RATIO_BUCKETS,
    bucketForRatio: bucketForRatio,
    THRESHOLDS: THRESHOLDS,
    MIN_SAMPLES_FOR_BATCH_SIGNAL: MIN_SAMPLES_FOR_BATCH_SIGNAL,
    ASSUMPTIONS: ASSUMPTIONS,
    CATEGORY_VOCABULARY: CATEGORY_VOCABULARY,
    duplicateAnalysis: duplicateAnalysis,
    rerunAnalysis: rerunAnalysis,
    poolPlasmaAnalysis: poolPlasmaAnalysis,
    interRunCv: interRunCv,
    rerunDecision: rerunDecision,
    directionalDriftFlag: directionalDriftFlag,
    batchLevelEscalation: batchLevelEscalation,
    summarySentence: summarySentence,
    matchBarcode: matchBarcode
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Calc = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
