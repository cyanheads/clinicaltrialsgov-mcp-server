/**
 * @fileoverview Row type for the clinical-trials local mirror — metadata tier only.
 *
 * Columns mirror the metadata fields requested from the ClinicalTrials.gov API
 * during bootstrap/refresh. FTS-indexed columns are denormalized to plain TEXT
 * strings so SQLite FTS5 can search across them. Structured arrays (conditions,
 * interventions, phases) are stored as pipe-delimited TEXT and parsed back on
 * read.
 * @module services/clinical-trials/mirror/types
 */

/** A single row in the local mirror — metadata tier. */
export interface StudyMetaRow {
  /** Brief title. */
  brief_title: string | null;
  /** Pipe-delimited conditions (e.g., Diabetes Mellitus|Type 2). */
  conditions: string | null;
  /**
   * Eligibility criteria text — included in FTS for
   * clinicaltrials_find_eligible queries.
   */
  eligibility_criteria: string | null;
  /** Enrolled participant count. */
  enrollment_count: number | null;
  /** Whether the study has posted results. */
  has_results: number | null;
  /** Whether the study accepts healthy volunteers. */
  healthy_volunteers: number | null;
  /** Pipe-delimited interventions (e.g., Drug A|Drug B). */
  interventions: string | null;
  /** Last update post date — used as the incremental sync checkpoint. ISO 8601. */
  last_update_post_date: string | null;
  /** Lead sponsor class (e.g., INDUSTRY, NIH). */
  lead_sponsor_class: string | null;
  /** Lead sponsor name. */
  lead_sponsor_name: string | null;
  /**
   * Pipe-delimited location summary strings
   * (e.g., "Seattle, WA, United States|London, United Kingdom").
   */
  locations: string | null;
  /** Maximum age string (e.g., "65 Years"). */
  maximum_age: string | null;
  /** Minimum age string (e.g., "18 Years"). */
  minimum_age: string | null;
  /** NCT ID — primary key. Format: NCT followed by 8 digits. */
  nct_id: string;
  /** Official title. */
  official_title: string | null;
  /** Overall status (e.g., RECRUITING, COMPLETED). */
  overall_status: string | null;
  /** Pipe-delimited study phases (e.g., PHASE2|PHASE3). */
  phases: string | null;
  /** Primary completion date string. */
  primary_completion_date: string | null;
  /** Sex eligibility (e.g., ALL, FEMALE, MALE). */
  sex: string | null;
  /** Study start date string (YYYY-MM or YYYY-MM-DD). */
  start_date: string | null;
  /** Pipe-delimited standard age groups (e.g., ADULT|OLDER_ADULT). */
  std_ages: string | null;
  /** Study type (e.g., INTERVENTIONAL, OBSERVATIONAL). */
  study_type: string | null;
}

/** Map from StudyMetaRow key to SQLite type declaration. */
export const STUDY_META_COLUMNS: Record<keyof StudyMetaRow, string> = {
  nct_id: 'TEXT NOT NULL',
  brief_title: 'TEXT',
  official_title: 'TEXT',
  overall_status: 'TEXT',
  phases: 'TEXT',
  study_type: 'TEXT',
  lead_sponsor_name: 'TEXT',
  lead_sponsor_class: 'TEXT',
  conditions: 'TEXT',
  interventions: 'TEXT',
  eligibility_criteria: 'TEXT',
  minimum_age: 'TEXT',
  maximum_age: 'TEXT',
  sex: 'TEXT',
  std_ages: 'TEXT',
  healthy_volunteers: 'INTEGER',
  start_date: 'TEXT',
  primary_completion_date: 'TEXT',
  last_update_post_date: 'TEXT',
  enrollment_count: 'INTEGER',
  locations: 'TEXT',
  has_results: 'INTEGER',
};

/** FTS5-indexed columns — the ones search queries scan. */
export const STUDY_META_FTS: Array<keyof StudyMetaRow> = [
  'brief_title',
  'official_title',
  'conditions',
  'interventions',
  'eligibility_criteria',
  'lead_sponsor_name',
];
