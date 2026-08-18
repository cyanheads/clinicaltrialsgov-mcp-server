/**
 * @fileoverview Tests for study format helpers.
 * @module tests/mcp-server/tools/utils/format-helpers
 */

import { describe, expect, it } from 'vitest';
import { formatRemainingStudyFields } from '@/mcp-server/tools/utils/format-helpers.js';

describe('formatRemainingStudyFields', () => {
  it('returns empty array when all fields are already rendered', () => {
    const study = {
      protocolSection: {
        identificationModule: { nctId: 'NCT12345678', briefTitle: 'Title' },
      },
    };
    const rendered = new Set([
      'protocolSection.identificationModule.nctId',
      'protocolSection.identificationModule.briefTitle',
    ]);
    expect(formatRemainingStudyFields(study, rendered)).toEqual([]);
  });

  it('flattens primitive arrays to a single comma-joined leaf', () => {
    const study = {
      protocolSection: { conditionsModule: { keywords: ['a', 'b', 'c', 'd', 'e'] } },
    };
    const lines = formatRemainingStudyFields(study, new Set());
    expect(lines.some((l) => l.includes('a, b, c, d, e'))).toBe(true);
  });

  it('does not emit a "+N more" truncation sentinel for object arrays (regression for #19)', () => {
    // Old behavior: hard-capped object arrays at 3 items and emitted a
    // `[…]: +N more` sentinel. The outer `maxLines` budget already bounds
    // total output, so the per-array cap added noise (and misleadingly
    // suggested truncation occurred even when `maxLines` wouldn't have cut).
    const study = {
      protocolSection: {
        referencesModule: {
          references: [
            { pmid: '1', citation: 'Ref 1' },
            { pmid: '2', citation: 'Ref 2' },
            { pmid: '3', citation: 'Ref 3' },
            { pmid: '4', citation: 'Ref 4' },
            { pmid: '5', citation: 'Ref 5' },
            { pmid: '6', citation: 'Ref 6' },
          ],
        },
      },
    };
    const output = formatRemainingStudyFields(study, new Set(), { maxLines: 20 }).join('\n');
    expect(output).not.toMatch(/\+\d+ more$/m);
    expect(output).not.toContain('[…]');
  });

  it('respects the outer maxLines budget for distinct labels', () => {
    // 6 distinct field labels with maxLines: 3 — the cap should drop 3 and
    // emit a truthful "and 3 more fields" footer.
    const study = {
      protocolSection: {
        identificationModule: { nctId: 'NCT1', briefTitle: 'T', acronym: 'A' },
        statusModule: { overallStatus: 'RECRUITING', studyFirstSubmitDate: '2026-01-01' },
        descriptionModule: { briefSummary: 'S' },
      },
    };
    const lines = formatRemainingStudyFields(study, new Set(), { maxLines: 3 });
    expect(lines.length).toBe(4); // 3 content + 1 summary
    expect(lines.some((l) => /and 3 more fields/.test(l))).toBe(true);
  });

  it('counts every cap-dropped entry of a repeated array exactly once (regression for #38, #86)', () => {
    // 20 interventions carry 40 distinct fields once each entry is attributed to
    // its own index, so a maxLines of 4 genuinely truncates 36 of them. The
    // footer must report that count exactly — neither inflated by re-counting a
    // repeating field nor claiming a drop the cap didn't make.
    const study = {
      protocolSection: {
        armsInterventionsModule: {
          interventions: Array.from({ length: 20 }, (_, i) => ({
            name: `Drug${i}`,
            type: 'DRUG',
          })),
        },
      },
    };
    const lines = formatRemainingStudyFields(study, new Set(), { maxLines: 4 });
    expect(lines).toHaveLength(5); // 4 content + 1 footer
    expect(lines.at(-1)).toBe('  … and 36 more fields');
  });

  it('renders all fields when maxLines is Infinity (regression for #38)', () => {
    // Explicit-fields path passes Infinity so every requested leaf renders.
    const study = {
      protocolSection: {
        identificationModule: { nctId: 'NCT1', briefTitle: 'T' },
        statusModule: {
          startDateStruct: { date: '2024-01-01' },
          primaryCompletionDateStruct: { date: '2025-01-01' },
        },
        armsInterventionsModule: { interventions: [{ name: 'Drug', type: 'DRUG' }] },
      },
    };
    const lines = formatRemainingStudyFields(study, new Set(), {
      maxLines: Number.POSITIVE_INFINITY,
    });
    expect(lines.some((l) => /more fields/.test(l))).toBe(false);
    expect(lines.some((l) => l.includes('NCT1'))).toBe(true);
    expect(lines.some((l) => l.includes('Drug'))).toBe(true);
    expect(lines.some((l) => l.includes('2024-01-01'))).toBe(true);
  });

  it('truncates long string values at maxValueLen', () => {
    const longString = 'x'.repeat(500);
    const study = {
      protocolSection: { descriptionModule: { detailedDescription: longString } },
    };
    const lines = formatRemainingStudyFields(study, new Set(), { maxValueLen: 50 });
    const descLine = lines.find((l) => l.includes('x'));
    expect(descLine).toBeDefined();
    expect(descLine!.endsWith('…')).toBe(true);
  });

  it('keeps repeated array entries distinct instead of splicing them together (regression for #86)', () => {
    // NCT03722472's two secondary IDs: entry [0] carries no `link`, entry [1] no
    // `domain`. Label-only dedup dropped entry [1]'s `id`/`type` as duplicates
    // while its `link` — a label entry [0] never populated — survived, so four
    // lines read as one coherent secondary ID built from two different entries.
    const study = {
      protocolSection: {
        identificationModule: {
          secondaryIdInfos: [
            { id: 'DMID 17-0104', type: 'OTHER', domain: 'NIH/NIAID/DMID' },
            {
              id: '272201400041C-0-0-1',
              type: 'NIH',
              link: 'https://reporter.nih.gov/quickSearch/272201400041C-0-0-1',
            },
          ],
        },
      },
    };
    const lines = formatRemainingStudyFields(study, new Set(), {
      maxLines: Number.POSITIVE_INFINITY,
      maxValueLen: Number.POSITIVE_INFINITY,
    });
    expect(lines).toEqual([
      '  Secondary Id Infos[0] > Id: DMID 17-0104',
      '  Secondary Id Infos[0] > Type: OTHER',
      '  Secondary Id Infos[0] > Domain: NIH/NIAID/DMID',
      '  Secondary Id Infos[1] > Id: 272201400041C-0-0-1',
      '  Secondary Id Infos[1] > Type: NIH',
      '  Secondary Id Infos[1] > Link: https://reporter.nih.gov/quickSearch/272201400041C-0-0-1',
    ]);
  });

  it('leaves a single-entry array label unindexed (#86)', () => {
    const study = {
      protocolSection: {
        armsInterventionsModule: { interventions: [{ name: 'Placebo', type: 'DRUG' }] },
      },
    };
    const lines = formatRemainingStudyFields(study, new Set(), {
      maxLines: Number.POSITIVE_INFINITY,
    });
    expect(lines).toEqual(['  Interventions > Name: Placebo', '  Interventions > Type: DRUG']);
  });

  it('does not merge same-labelled entries across two different repeated arrays (regression for #86)', () => {
    // Both arrays humanize to the same `Meshes > Term` label, so a dedup key
    // built from a bare entry index would merge conditionBrowse[i] with
    // interventionBrowse[i]. The key carries the originating array's own path.
    const study = {
      derivedSection: {
        conditionBrowseModule: { meshes: [{ term: 'Influenza' }, { term: 'Pneumonia' }] },
        interventionBrowseModule: { meshes: [{ term: 'Oseltamivir' }, { term: 'Zanamivir' }] },
      },
    };
    const text = formatRemainingStudyFields(study, new Set(), {
      maxLines: Number.POSITIVE_INFINITY,
    }).join('\n');
    for (const term of ['Influenza', 'Pneumonia', 'Oseltamivir', 'Zanamivir']) {
      expect(text).toContain(term);
    }
  });

  it('widens the label window when two sibling arrays humanize alike (regression for #104)', () => {
    // NCT02271776's two browse modules. Both arrays are named `meshes` and both
    // leaves are `term`, so a fixed two-segment window renders `Meshes[0] > Term`
    // for each — the distinguishing segment (`conditionBrowseModule` /
    // `interventionBrowseModule`) sits one step further back than the window
    // reaches. Values stay distinct and separated; only the labels collide.
    const study = {
      derivedSection: {
        conditionBrowseModule: {
          meshes: [
            { term: 'Obesity' },
            { term: 'Diabetes Mellitus, Type 2' },
            { term: 'Insulin Resistance' },
          ],
        },
        interventionBrowseModule: {
          meshes: [{ term: "4'-galactooligosaccharide" }, { term: 'maltodextrin' }],
        },
      },
    };
    const lines = formatRemainingStudyFields(study, new Set(), {
      maxLines: Number.POSITIVE_INFINITY,
    });
    expect(lines).toEqual([
      '  Condition Browse > Meshes[0] > Term: Obesity',
      '  Condition Browse > Meshes[1] > Term: Diabetes Mellitus, Type 2',
      '  Condition Browse > Meshes[2] > Term: Insulin Resistance',
      "  Intervention Browse > Meshes[0] > Term: 4'-galactooligosaccharide",
      '  Intervention Browse > Meshes[1] > Term: maltodextrin',
    ]);
  });

  it('widens only the colliding labels, leaving unambiguous ones at the two-segment window (#104)', () => {
    // The identification leaves are unambiguous and must keep their established
    // labels; only the two mesh arrays widen.
    const study = {
      protocolSection: {
        identificationModule: { nctId: 'NCT02271776', briefTitle: 'A trial' },
      },
      derivedSection: {
        conditionBrowseModule: { meshes: [{ term: 'Obesity' }] },
        interventionBrowseModule: { meshes: [{ term: 'maltodextrin' }] },
      },
    };
    const lines = formatRemainingStudyFields(study, new Set(), {
      maxLines: Number.POSITIVE_INFINITY,
    });
    expect(lines).toEqual([
      '  Identification > Nct Id: NCT02271776',
      '  Identification > Brief Title: A trial',
      '  Condition Browse > Meshes > Term: Obesity',
      '  Intervention Browse > Meshes > Term: maltodextrin',
    ]);
  });

  it('keeps widening until the colliding labels are distinct (#104)', () => {
    // The distinguishing segment sits three levels back, so one widening step
    // still collides and a second is required.
    const study = {
      protocolSection: {
        alphaModule: { browse: { meshes: [{ term: 'Alpha' }] } },
        betaModule: { browse: { meshes: [{ term: 'Beta' }] } },
      },
    };
    const lines = formatRemainingStudyFields(study, new Set(), {
      maxLines: Number.POSITIVE_INFINITY,
    });
    expect(lines).toEqual([
      '  Alpha > Browse > Meshes > Term: Alpha',
      '  Beta > Browse > Meshes > Term: Beta',
    ]);
  });

  it('counts only cap-dropped leaves in the footer when labels widen (regression for #38, #104)', () => {
    // Five leaves across two colliding arrays, capped at 2. Widening changes how
    // lines read, never what the footer counts: 3 cap-dropped, 0 consolidated.
    const study = {
      derivedSection: {
        conditionBrowseModule: { meshes: [{ term: 'A' }, { term: 'B' }, { term: 'C' }] },
        interventionBrowseModule: { meshes: [{ term: 'D' }, { term: 'E' }] },
      },
    };
    const lines = formatRemainingStudyFields(study, new Set(), { maxLines: 2 });
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toBe('  … and 3 more fields');
  });

  it('distinguishes entries of an array nested inside another array entry (#86)', () => {
    const study = {
      resultsSection: {
        outcomeMeasuresModule: {
          outcomeMeasures: [
            { title: 'Change in HbA1c', classes: [{ title: 'Cohort A' }, { title: 'Cohort B' }] },
            { title: 'Adverse events', classes: [{ title: 'Cohort C' }] },
          ],
        },
      },
    };
    const text = formatRemainingStudyFields(study, new Set(), {
      maxLines: Number.POSITIVE_INFINITY,
    }).join('\n');
    for (const value of ['Change in HbA1c', 'Adverse events', 'Cohort A', 'Cohort B', 'Cohort C']) {
      expect(text).toContain(value);
    }
    // The inner array of the second outcome holds one entry — no index suffix.
    expect(text).toContain('Classes > Title: Cohort C');
  });

  it('counts a repeated cap-dropped field once in the footer (regression for #86)', () => {
    // `centralContactModule.contact.email` and `overallOfficialModule.contact.email`
    // collapse to the same `Contact > Email` label. maxLines is filled before
    // either is reached, so both take the cap branch — which counted every
    // occurrence instead of recording the field as already dropped.
    const study = {
      protocolSection: {
        identificationModule: { nctId: 'NCT1', briefTitle: 'T' },
        centralContactModule: { contact: { email: 'a@example.org' } },
        overallOfficialModule: { contact: { email: 'b@example.org' } },
      },
    };
    const lines = formatRemainingStudyFields(study, new Set(), { maxLines: 2 });
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toContain('and 1 more fields');
  });

  it('does not count dedup-consolidated leaves toward the footer (regression for #38)', () => {
    // Same colliding-label pair, this time inside the cap: the second leaf is
    // consolidated, not truncated, so no footer may claim a drop.
    const study = {
      protocolSection: {
        identificationModule: { nctId: 'NCT1', briefTitle: 'T' },
        centralContactModule: { contact: { email: 'a@example.org' } },
        overallOfficialModule: { contact: { email: 'b@example.org' } },
      },
    };
    const lines = formatRemainingStudyFields(study, new Set(), { maxLines: 3 });
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => /more fields/.test(l))).toBe(false);
  });

  it('emits nothing for empty arrays and null leaves', () => {
    const study = {
      protocolSection: {
        identificationModule: { secondaryIdInfos: [], acronym: null, briefTitle: '' },
      },
    };
    expect(formatRemainingStudyFields(study, new Set())).toEqual([]);
  });

  it('skips structural path segments in labels', () => {
    const study = {
      protocolSection: { statusModule: { overallStatus: 'RECRUITING' } },
    };
    const lines = formatRemainingStudyFields(study, new Set());
    const line = lines.find((l) => l.includes('RECRUITING'));
    expect(line).toBeDefined();
    expect(line).not.toContain('protocolSection');
  });
});
