/**
 * @fileoverview Complete, declarative definition for the 'clinicaltrials_find_eligible_studies' tool.
 * Matches patient demographics and medical profiles to eligible clinical trials.
 *
 * @module src/mcp-server/tools/definitions/clinicaltrials-find-eligible-studies.tool
 */

import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { container } from '@/container/index.js';
import { z } from 'zod';

import { ClinicalTrialsProvider } from '@/container/core/tokens.js';
import type {
  SdkContext,
  ToolAnnotations,
  ToolDefinition,
} from '@/mcp-server/tools/utils/toolDefinition.js';
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import type { IClinicalTrialsProvider } from '@/services/clinical-trials-gov/core/IClinicalTrialsProvider.js';
import type { Study } from '@/services/clinical-trials-gov/types.js';
import { logger, type RequestContext } from '@/utils/index.js';
import { checkAgeEligibility } from '../utils/ageParser.js';
import {
  checkHealthyVolunteerEligibility,
  checkSexEligibility,
} from '../utils/eligibilityCheckers.js';
import {
  extractContactInfo,
  extractRelevantLocations,
  extractStudyDetails,
} from '../utils/studyExtractors.js';
import {
  calculateConditionRelevance,
  calculateMatchScore,
  rankStudies,
} from '../utils/studyRanking.js';

const TOOL_NAME = 'clinicaltrials_find_eligible_studies';
const TOOL_TITLE = 'Find Eligible Clinical Trials';
const TOOL_DESCRIPTION =
  'Matches patient demographics and medical profile to eligible clinical trials. Filters by age, sex, conditions, location, and healthy volunteer status. Returns ranked list of matching studies with eligibility explanations.';

const TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const PatientLocationSchema = z
  .object({
    country: z.string().describe('Country (e.g., "United States")'),
    state: z.string().optional().describe('State or province'),
    city: z.string().optional().describe('City'),
    postalCode: z.string().optional().describe('Postal code'),
  })
  .describe('Patient location for geographic filtering.');

const InputSchema = z
  .object({
    age: z.number().int().min(0).max(120).describe('Patient age in years.'),
    sex: z
      .enum(['All', 'Female', 'Male'])
      .describe('Biological sex of the patient.'),
    conditions: z
      .array(z.string())
      .min(1)
      .describe(
        'List of medical conditions or diagnoses (e.g., ["Type 2 Diabetes", "Hypertension"]).',
      ),
    location: PatientLocationSchema,
    healthyVolunteer: z
      .boolean()
      .default(false)
      .describe('Whether the patient is a healthy volunteer.'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum number of matching studies to return.'),
    recruitingOnly: z
      .boolean()
      .default(true)
      .describe('Only include actively recruiting studies.'),
  })
  .describe('Input parameters for finding eligible clinical trial studies.');

const EligibilityHighlightsSchema = z
  .object({
    ageRange: z.string().optional().describe('Age range for the study'),
    sex: z.string().optional().describe('Sex requirement'),
    healthyVolunteers: z
      .boolean()
      .optional()
      .describe('Whether healthy volunteers are accepted'),
    criteriaSnippet: z
      .string()
      .optional()
      .describe('Excerpt from eligibility criteria'),
  })
  .describe('Eligibility highlights for the study.');

const StudyLocationSchema = z
  .object({
    facility: z.string().optional().describe('Facility name'),
    city: z.string().optional().describe('City'),
    state: z.string().optional().describe('State or province'),
    country: z.string().optional().describe('Country'),
    distance: z.number().optional().describe('Distance in miles'),
  })
  .describe('Study location information.');

const StudyContactSchema = z
  .object({
    name: z.string().optional().describe('Contact person name'),
    phone: z.string().optional().describe('Contact phone number'),
    email: z.string().optional().describe('Contact email address'),
  })
  .describe('Study contact information.');

const StudyDetailsSchema = z
  .object({
    phase: z.array(z.string()).optional().describe('Trial phases'),
    status: z.string().describe('Overall study status'),
    enrollmentCount: z.number().optional().describe('Planned enrollment count'),
    sponsor: z.string().optional().describe('Lead sponsor name'),
  })
  .describe('Study details for ranking and display.');

const EligibleStudySchema = z
  .object({
    nctId: z.string().describe('The NCT identifier'),
    title: z.string().describe('Study title'),
    briefSummary: z.string().optional().describe('Brief study summary'),
    matchScore: z
      .number()
      .min(0)
      .max(100)
      .describe('Confidence score (0-100) for eligibility match'),
    matchReasons: z
      .array(z.string())
      .describe(
        'Reasons why this study matches (e.g., "Age within range", "Accepts females")',
      ),
    eligibilityHighlights: EligibilityHighlightsSchema,
    locations: z
      .array(StudyLocationSchema)
      .describe('Relevant study locations'),
    contact: StudyContactSchema.optional().describe(
      'Study contact information',
    ),
    studyDetails: StudyDetailsSchema,
  })
  .describe('An eligible clinical trial study with match details.');

const OutputSchema = z
  .object({
    eligibleStudies: z
      .array(EligibleStudySchema)
      .describe('Array of eligible studies, ranked by relevance'),
    totalMatches: z.number().describe('Total number of eligible studies found'),
    totalAvailable: z
      .number()
      .optional()
      .describe(
        'Total studies matching the query (before eligibility filtering). Present when results were truncated.',
      ),
    searchCriteria: z
      .object({
        conditions: z.array(z.string()).describe('Searched conditions'),
        location: z.string().describe('Patient location summary'),
        ageRange: z.string().describe('Patient demographic summary'),
      })
      .describe('Summary of search criteria used'),
  })
  .describe('Response containing eligible clinical trial studies.');

type FindEligibleStudiesInput = z.infer<typeof InputSchema>;
type EligibleStudy = z.infer<typeof EligibleStudySchema>;
type FindEligibleStudiesOutput = z.infer<typeof OutputSchema>;

/**
 * Filters studies based on eligibility criteria and scores them by condition relevance.
 *
 * Hard filters (age, sex, healthy volunteers, location) exclude ineligible studies.
 * Condition relevance is scored by comparing the study's `conditionsModule.conditions`
 * against the patient's input conditions using normalized token overlap.
 * Studies with zero condition relevance are excluded — they matched only via
 * incidental keyword hits in the API's full-text search.
 */
function filterByEligibility(
  studies: Study[],
  input: FindEligibleStudiesInput,
  appContext: RequestContext,
): EligibleStudy[] {
  const eligible: EligibleStudy[] = [];

  for (const study of studies) {
    const eligibility = study.protocolSection?.eligibilityModule;
    if (!eligibility) {
      logger.debug('Skipping study without eligibility module', {
        ...appContext,
        nctId: study.protocolSection?.identificationModule?.nctId,
      });
      continue;
    }

    const matchReasons: string[] = [];
    const demographicChecks: Array<{ eligible: boolean; reason: string }> = [];

    // Age check
    const ageCheck = checkAgeEligibility(
      eligibility.minimumAge,
      eligibility.maximumAge,
      input.age,
    );
    demographicChecks.push(ageCheck);
    if (!ageCheck.eligible) continue;
    matchReasons.push(ageCheck.reason);

    // Sex check
    const sexCheck = checkSexEligibility(eligibility.sex, input.sex);
    demographicChecks.push(sexCheck);
    if (!sexCheck.eligible) continue;
    matchReasons.push(sexCheck.reason);

    // Healthy volunteers check
    const hvCheck = checkHealthyVolunteerEligibility(
      eligibility.healthyVolunteers,
      input.healthyVolunteer,
    );
    demographicChecks.push(hvCheck);
    if (!hvCheck.eligible) continue;
    matchReasons.push(hvCheck.reason);

    // Location check — at least one location must match the patient's country
    const locations = extractRelevantLocations(study, input.location);
    const locationCheck = {
      eligible: locations.length > 0,
      reason:
        locations.length > 0
          ? `${locations.length} location(s) in ${input.location.country}`
          : `No locations in ${input.location.country}`,
    };
    demographicChecks.push(locationCheck);
    if (!locationCheck.eligible) continue;
    matchReasons.push(locationCheck.reason);

    // Condition relevance — compare study conditions against patient conditions
    const studyConditions =
      study.protocolSection?.conditionsModule?.conditions ?? [];
    const conditionRelevance = calculateConditionRelevance(
      studyConditions,
      input.conditions,
    );

    // Exclude studies with no condition overlap (false positives from full-text search)
    if (conditionRelevance === 0) {
      logger.debug('Excluding study with zero condition relevance', {
        ...appContext,
        nctId: study.protocolSection?.identificationModule?.nctId,
        studyConditions,
        patientConditions: input.conditions,
      });
      continue;
    }

    matchReasons.push(
      `Condition relevance: ${Math.round(conditionRelevance * 100)}% (${studyConditions.join(', ')})`,
    );

    // Weighted score: condition relevance (0–60) + demographics (0–40)
    const matchScore = calculateMatchScore(
      conditionRelevance,
      demographicChecks,
    );

    // Extract study information
    const nctId =
      study.protocolSection?.identificationModule?.nctId ?? 'Unknown';
    const title =
      study.protocolSection?.identificationModule?.briefTitle ?? 'No title';
    const briefSummary = study.protocolSection?.descriptionModule?.briefSummary;

    const contact = extractContactInfo(study);
    const studyDetails = extractStudyDetails(study);

    eligible.push({
      nctId,
      title,
      briefSummary,
      matchScore,
      matchReasons,
      eligibilityHighlights: {
        ageRange: `${eligibility.minimumAge ?? 'N/A'} - ${eligibility.maximumAge ?? 'N/A'}`,
        sex: eligibility.sex ?? 'All',
        healthyVolunteers: eligibility.healthyVolunteers,
        criteriaSnippet: eligibility.eligibilityCriteria?.substring(0, 300),
      },
      locations,
      contact,
      studyDetails,
    });
  }

  return eligible;
}

/**
 * Finds clinical studies that match a patient's eligibility profile.
 */
async function findEligibleStudiesLogic(
  input: FindEligibleStudiesInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<FindEligibleStudiesOutput> {
  logger.debug('Executing findEligibleStudiesLogic', {
    ...appContext,
    toolInput: input,
  });

  const provider = container.resolve<IClinicalTrialsProvider>(
    ClinicalTrialsProvider,
  );

  // Use the condition-specific query field (query.cond) to search only the
  // Conditions/Synonyms index, avoiding false positives from full-text matches
  // (e.g. a cardiovascular study that mentions diabetes in exclusion criteria).
  // Quote multi-word conditions to prevent token splitting.
  // Escape any embedded double quotes to avoid malformed queries.
  const conditionQuery = input.conditions
    .map((c) => {
      const escaped = c.replace(/"/g, '\\"');
      return c.includes(' ') ? `"${escaped}"` : escaped;
    })
    .join(' OR ');

  // Build filter for recruiting status
  const filter = input.recruitingOnly
    ? 'STATUS:Recruiting OR STATUS:"Not yet recruiting"'
    : undefined;

  // Fetch up to 100 candidates; if the query matches more, we surface
  // totalAvailable so the caller knows results were truncated.
  const PAGE_SIZE = 100;
  const searchParams = {
    conditionQuery,
    ...(filter ? { filter } : {}),
    pageSize: PAGE_SIZE,
  };

  logger.info('Searching for studies with criteria', {
    ...appContext,
    searchParams,
  });

  const pagedStudies = await provider.listStudies(searchParams, appContext);
  const totalAvailable = pagedStudies.totalCount;
  const fetched = pagedStudies.studies?.length ?? 0;

  if (totalAvailable && totalAvailable > fetched) {
    logger.warning(
      `Query matched ${totalAvailable} studies but only ${fetched} were evaluated for eligibility`,
      { ...appContext, totalAvailable, fetched },
    );
  }

  logger.info(`Found ${fetched} studies to filter`, {
    ...appContext,
    totalCount: totalAvailable,
  });

  // Filter by eligibility
  const eligibleStudies = filterByEligibility(
    pagedStudies.studies ?? [],
    input,
    appContext,
  );

  logger.info(`${eligibleStudies.length} studies passed eligibility checks`, {
    ...appContext,
  });

  // Rank by relevance
  const rankedStudies = rankStudies(eligibleStudies);

  // Limit results
  const finalStudies = rankedStudies.slice(0, input.maxResults);

  logger.info(
    `Returning ${finalStudies.length} eligible studies (top ${input.maxResults})`,
    {
      ...appContext,
      totalEligible: eligibleStudies.length,
    },
  );

  const wasTruncated = totalAvailable != null && totalAvailable > fetched;

  return {
    eligibleStudies: finalStudies,
    totalMatches: eligibleStudies.length,
    ...(wasTruncated ? { totalAvailable } : {}),
    searchCriteria: {
      conditions: input.conditions,
      location:
        input.location.city ?? input.location.state ?? input.location.country,
      ageRange: `${input.age} years old, ${input.sex}`,
    },
  };
}

function responseFormatter(result: FindEligibleStudiesOutput): ContentBlock[] {
  const { eligibleStudies, totalMatches, totalAvailable, searchCriteria } =
    result;

  const truncationNote =
    totalAvailable != null
      ? `\n> **Note:** ${totalAvailable} studies matched the query but only the first 100 were evaluated for eligibility. Narrow your search for more precise results.\n`
      : '';

  const summary = [
    `# Eligible Clinical Trials`,
    ``,
    `Found **${totalMatches}** matching studies for:`,
    `- **Conditions:** ${searchCriteria.conditions.join(', ')}`,
    `- **Location:** ${searchCriteria.location}`,
    `- **Patient:** ${searchCriteria.ageRange}`,
    truncationNote,
    `Showing top ${eligibleStudies.length} ${eligibleStudies.length === 1 ? 'result' : 'results'}:`,
    ``,
    `---`,
    ``,
  ];

  const studyDetails = eligibleStudies.map((study, idx) => {
    const locationList = study.locations
      .slice(0, 3)
      .map(
        (loc) =>
          `- ${loc.facility ?? 'Unknown facility'} - ${loc.city ?? 'N/A'}, ${loc.state ?? 'N/A'}${loc.distance ? ` (${loc.distance} mi)` : ''}`,
      )
      .join('\n');

    const moreLocations =
      study.locations.length > 3
        ? `- ...and ${study.locations.length - 3} more locations`
        : '';

    return [
      `## ${idx + 1}. ${study.title}`,
      `**NCT ID:** ${study.nctId}`,
      ``,
      `**Match Score:** ${study.matchScore}/100`,
      ``,
      `**Why You Match:**`,
      ...study.matchReasons.map((r) => `- ${r}`),
      ``,
      `**Eligibility Summary:**`,
      `- Age Range: ${study.eligibilityHighlights.ageRange}`,
      `- Sex: ${study.eligibilityHighlights.sex}`,
      `- Healthy Volunteers: ${study.eligibilityHighlights.healthyVolunteers ? 'Yes' : 'No'}`,
      ``,
      study.briefSummary ? `**Study Summary:**\n${study.briefSummary}\n` : '',
      `**Study Details:**`,
      `- Phase: ${study.studyDetails.phase?.join(', ') ?? 'N/A'}`,
      `- Status: ${study.studyDetails.status}`,
      `- Sponsor: ${study.studyDetails.sponsor ?? 'N/A'}`,
      study.studyDetails.enrollmentCount
        ? `- Target Enrollment: ${study.studyDetails.enrollmentCount}`
        : '',
      ``,
      `**Nearby Locations (${study.locations.length}):**`,
      locationList,
      moreLocations,
      ``,
      study.contact
        ? `**Contact:** ${study.contact.name ?? 'N/A'}${study.contact.phone ? ` | ${study.contact.phone}` : ''}${study.contact.email ? ` | ${study.contact.email}` : ''}`
        : '',
      ``,
      `---`,
      ``,
    ]
      .filter(Boolean)
      .join('\n');
  });

  return [
    {
      type: 'text',
      text: summary.join('\n') + studyDetails.join(''),
    },
  ];
}

export const findEligibleStudiesTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: TOOL_ANNOTATIONS,
  logic: withToolAuth(['tool:clinicaltrials:read'], findEligibleStudiesLogic),
  responseFormatter,
};
