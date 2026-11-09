/**
 * @fileoverview ClinicalTrials.gov REST API v2 client with retry, rate limiting, and timeout.
 * @module services/clinical-trials/clinical-trials-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  internalError,
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  requestCancelled,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createPacer, httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import {
  type AreaLookup,
  buildExtendedIndex,
  buildFieldIndex,
  type ExtendedIndex,
  type ExtendedName,
  type FieldIndex,
  type FieldIndexEntry,
  indexOnlyNames,
  isArrayType,
  isSortable,
  isStruct,
  missesRecordTier,
  nearestPieces,
  resolveName,
  searchAreaNames,
  searchFields,
} from './field-search.js';
import { geoFilterShapeMessage } from './geo-filter-message.js';
import type {
  CountParams,
  FieldNode,
  FieldValueStats,
  PagedStudiesResponse,
  SearchAreaGroup,
  SearchParams,
  Study,
} from './types.js';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
/**
 * Transport codes of a connection that dropped mid-request, retried like a 5xx.
 * Bun's fetch carries the code on the rejection itself, Node's only on its
 * `cause`. A refused connection (`ECONNREFUSED`) is not among them.
 */
const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT']);
/** Least time between two request starts — ClinicalTrials.gov allows about one a second. */
const MIN_INTERVAL_MS = 1000;
/**
 * Most time one tool call or resource read spends on ClinicalTrials.gov: every
 * request it chains, each attempt, backoff, and wait for a request slot. Under
 * the MCP SDK clients' 60 s default request timeout, so a hung upstream ends
 * the call with this server's own `retry_deadline_exceeded` rather than the
 * client's untyped timeout. Measured from the call's first reach into the
 * service; each attempt also stops at `CT_REQUEST_TIMEOUT_MS`.
 */
const CALL_BUDGET_MS = 50_000;
/**
 * Timeout for each read behind the second AREA[] and `sort` tier —
 * `/studies/metadata?includeIndexedOnly=true` (~198 KB) and
 * `/studies/search-areas` (~25 KB). Measured 2026-11-03 at 0.16–0.31 s and
 * 0.12–0.66 s; 5 s is several times the slowest. Each read gets one attempt;
 * the pacer starts the two a gap apart and they are awaited together, so a
 * call that misses the record tier waits at most two gaps plus this before its
 * own request — a hung read cannot spend the call's budget on a correction the
 * call can do without.
 */
const EXTENDED_READ_TIMEOUT_MS = 5000;
/**
 * Longest request target — URL path plus query string — ClinicalTrials.gov
 * serves. Measured 2026-11-02: 8,177 bytes is answered and 8,178 gets HTTP 414
 * from its nginx front end, whether the bytes are NCT IDs, `query.term`, or
 * `filter.advanced` — nginx's 8,192-byte request line less `GET `, ` HTTP/1.1`,
 * and CRLF. There is no POST search to move a long list out of the URL.
 */
const UPSTREAM_MAX_REQUEST_TARGET_BYTES = 8177;
/**
 * Bytes an ID-fitted search keeps free for its paging parameters, so the same
 * criteria fit the same IDs on every page of a walk: `&pageSize=1000`,
 * `&countTotal=false`, and `&pageToken=` take 42, leaving 214 for the token.
 * The longest tokens measured (2026-11-02) ran 100 characters under a two-key
 * date sort, and a walk's tokens kept one length from page to page.
 */
const PAGING_RESERVE_BYTES = 256;
/**
 * ClinicalTrials.gov uses 99999999 as a sentinel for "unknown enrollment
 * count". The filter below excludes studies carrying the sentinel by
 * default — `RANGE[5000, MAX]` and `EnrollmentCount:desc` otherwise surface
 * sentinel-polluted results that look like the largest trials but aren't.
 *
 * Stated as a negated single-sided range rather than a bounded one. An
 * `AREA[Field]RANGE[…]` predicate matches only studies that publish the field,
 * so the bounded form `RANGE[0, 99999998]` excluded a second, unintended set:
 * every study carrying no `EnrollmentCount` at all. Expanded-access records
 * never publish one, so every compassionate-use query answered zero. The
 * negation excludes only what sits at or above the sentinel boundary and needs
 * no `MISSING` arm.
 */
const ENROLLMENT_SENTINEL_FILTER = 'NOT AREA[EnrollmentCount]RANGE[99999999, MAX]';

/**
 * Colloquial / legacy field labels that map unambiguously to a canonical v2
 * piece. ClinicalTrials.gov's UI and legacy facets surface labels like
 * "Recruitment Status" that aren't API v2 piece names, so models reach for them
 * by reflex. Applied in normalizeFields as an auto-correct (mirroring the
 * case/whitespace fix) so the call succeeds instead of erroring with a
 * did-you-mean. Keyed by lowercased, separator-stripped input — a Map, since a
 * caller's `constructor` would otherwise read an object literal's prototype.
 */
const KNOWN_FIELD_RENAMES = new Map([
  ['recruitmentstatus', 'OverallStatus'],
  ['recruitingstatus', 'OverallStatus'],
]);

/**
 * The bracket rule, stated once. `AREA[…]`/`RANGE[…]` expressions are accepted
 * by the free-text query params (`query.term`, `query.cond`, …) exactly as they
 * are by `filter.advanced` — verified against the live API, which returns
 * identical totals for the same expression in either. Only a bracket *outside*
 * such an expression fails, so calling brackets advancedFilter-only would route
 * a working query away from the param it would have worked in.
 */
const BRACKET_RULE =
  '`[ ]` are valid only as part of an AREA[FieldName]value or RANGE[min, max] expression, which the free-text params accept as well as advancedFilter; a stray bracket fails.';

/**
 * The expression forms a `query_parse_error` quotes — in its message
 * (BRACKET_RULE, describeQueryParseError) and in the `query_parse_error`
 * recovery hint the tools declare — passed as the throw's `literals`, which the
 * declared hint keeps when the framework fills it. content[] renders each as a
 * code span instead of `AREA\[FieldName\]value`, so a caller copying one
 * carries no Markdown escape into its next call.
 */
const PARSE_ERROR_LITERALS = ['AREA[FieldName]value', 'RANGE[min, max]', 'AREA[…]', 'RANGE[…]'];

/**
 * Reduce an upstream Essie/ANTLR parse-error body to one actionable sentence.
 *
 * The quoted token means something different in each shape, so extracting "the
 * quoted thing" and calling it the offender misreports several of them:
 *
 * | Upstream shape | Quoted token is |
 * |:--|:--|
 * | `extraneous input 'X' expecting …` | a stray X in the input |
 * | `no viable alternative at input 'X'` | the span that failed to parse |
 * | `token recognition error at: 'X'` | the unparseable literal (e.g. an unterminated quote) |
 * | `mismatched input 'X' expecting 'Y'` | the token found — `<EOF>` means input ran out with Y still due |
 * | `missing 'Y' at 'X'` | the token the parser **wanted**, so Y is the unclosed delimiter |
 *
 * `<EOF>` is a position rather than a token, so it never makes a usable
 * offender. The `expecting {…}` grammar dump is dropped throughout — the token
 * list is noise to a caller. An unrecognized shape keeps the upstream
 * explanation (often specific, e.g. "Search scope must be `Study` or
 * `Location`") rather than being replaced by a content-free sentence.
 */
function describeQueryParseError(text: string): string {
  const tail = 'Free-text fields otherwise take plain words plus AND, OR, NOT.';
  const unclosedNote =
    "Every '(' needs a matching ')', and an AREA[…] or RANGE[…] expression needs its ']'.";

  // `missing 'Y' at 'X'` quotes what the parser expected, never what the caller
  // typed — reporting Y as the offender names a character absent from the input.
  const missing = text.match(/missing '(.+?)' at /)?.[1];
  if (missing) {
    return `Query syntax error: the query is missing a closing '${missing}'. ${unclosedNote} ${tail}`;
  }

  // Same unclosed-delimiter condition reached by a different rule: input ended
  // while a delimiter was still due.
  if (text.includes("mismatched input '<EOF>'")) {
    const expected = text.match(/mismatched input '<EOF>' expecting '(.+?)'/)?.[1];
    return expected
      ? `Query syntax error: the query ends before its closing '${expected}'. ${unclosedNote} ${tail}`
      : `Query syntax error: the query ends mid-expression, leaving a '(' or '[' unclosed. ${unclosedNote} ${tail}`;
  }

  const offender =
    text.match(/mismatched input '(.+?)'/)?.[1] ??
    text.match(/extraneous input '(.+?)'/)?.[1] ??
    text.match(/no viable alternative at input '(.+?)'/)?.[1] ??
    text.match(/token recognition error at: '(.+?)'/)?.[1];
  if (offender) {
    // State only the rule the offending token actually violates — leading a
    // stray ')' with the bracket rule reads as a non-sequitur.
    const rule = /[[\]]/.test(offender)
      ? BRACKET_RULE
      : /[()]/.test(offender)
        ? "Parentheses only group sub-expressions and must be matched; a stray '(' or ')' fails."
        : 'Check for an unbalanced quote, bracket, or parenthesis.';
    return `Query syntax error near '${offender}'. ${rule} ${tail}`;
  }

  // Unrecognized shape — preserve whatever upstream said, minus any grammar dump.
  const detail = text
    .replace(/^Error parsing query in [^:]*:\s*/, '')
    .split(/\s*expecting [{(]/)[0]
    ?.trim();
  return detail
    ? `Query syntax error: ${detail}. Free-text fields take plain words plus AND, OR, NOT.`
    : 'Query syntax error: the upstream parser rejected the query. Free-text fields take plain words plus AND, OR, NOT.';
}

/** An AREA[] or RANGE[] term upstream refused for the field it names, and how. */
export type AreaRejection =
  /** No field by that name. */
  | { kind: 'unknown'; name: string }
  /** A field AREA[] cannot match a value in, such as the group LeadSponsor. */
  | { kind: 'unsearchable'; name: string }
  /** A field named inside `SEARCH[Location](…)` that is not a field of a site, such as OverallStatus. */
  | { kind: 'location-scope'; name: string }
  /** RANGE[] on one field whose type takes no range, named by its metadata path. */
  | { kind: 'range-type'; path: string }
  /** RANGE[] spanning several fields: a bare RANGE[], or one after a search area. */
  | { kind: 'range-fields' };

/**
 * Read an upstream refusal of the field an AREA[] or RANGE[] term names out of
 * a 400 body, whatever parameter's `Error parsing query in <where>:` leads it:
 *
 * | Body | Kind |
 * |:--|:--|
 * | `Unknown area name: \`X\`` | `unknown` — no field X; inside `SEARCH[Location](…)` also a search area such as LocationSearch |
 * | `This type of query is not allowed for X` | `unsearchable` — every `STRUCT` piece probed (LeadSponsor, SponsorCollaboratorsModule, DesignInfo) |
 * | `` `X` is outside Location scope `` | `location-scope` — the first field inside the wrapper that no site holds (OverallStatus, Phase, NumLocations) |
 * | `RANGE is not supported for <type> field <path>` | `range-type` — a field neither date, number, nor age (`nct`, `text`, `boolean`, an enum's own type such as `Phase`, the group `Sponsor`) |
 * | `RANGE is not supported for multiple (N) fields` | `range-fields` |
 *
 * Undefined for any other body: `Search scope must be \`Study\` or \`Location\``
 * and `Cannot parse number for \`…\` field` (a RANGE bound, not its field) stay
 * the parse error they are.
 */
export function parseAreaRejection(text: string): AreaRejection | undefined {
  const unknown = text.match(/Unknown area name:\s*`([^`]+)`/)?.[1];
  if (unknown) return { kind: 'unknown', name: unknown };
  const unsearchable = text.match(/This type of query is not allowed for ([\w-]+)/)?.[1];
  if (unsearchable) return { kind: 'unsearchable', name: unsearchable };
  const outside = text.match(/`([^`]+)` is outside Location scope/)?.[1];
  if (outside) return { kind: 'location-scope', name: outside };
  if (/RANGE is not supported for multiple \(\d+\) fields/.test(text))
    return { kind: 'range-fields' };
  const rangePath = text.match(/RANGE is not supported for \S+ field (\S+)/)?.[1];
  return rangePath ? { kind: 'range-type', path: rangePath } : undefined;
}

/**
 * Read the metadata type out of `/stats/field/values`' refusal to count a field,
 * `Unsupported field type: <T>` (`Mesh` for ConditionMesh, `GeoPoint` for
 * LocationGeoPoint), which names the type and never the field. Undefined for
 * any other body.
 */
export function parseUnsupportedFieldType(text: string): string | undefined {
  return text.match(/Unsupported field type:\s*(\w+)/)?.[1];
}

/** `text` closed with a full stop, so a sentence can follow it. */
function closed(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

/** Names single-quoted and comma-joined, as every field-name message lists them. */
function quoted(names: readonly string[]): string {
  return names.map((n) => `'${n}'`).join(', ');
}

/** The `'X' — did you mean …?` clause a rejected name carries beside its nearest pieces. */
function didYouMean(name: string, near: readonly string[]): string {
  return `'${name}' — did you mean ${quoted(near)}?`;
}

/**
 * The message for an AREA[] name upstream does not know or refuses, carrying
 * the nearest searchable pieces in the same `'X' — did you mean …?` form an
 * invalid `fields` entry gets. It sets no hint: the `field_invalid` hint each
 * tool declares, to look the name up, fits this kind alone.
 */
function describeAreaRejection(
  { kind, name }: Extract<AreaRejection, { kind: 'unknown' | 'unsearchable' }>,
  upstream: string,
  near: string[],
): string {
  const lead =
    kind === 'unknown'
      ? `${upstream} '${name}' is not a recognized AREA[]-compatible field.`
      : `${closed(upstream)} '${name}' cannot be searched by value with AREA[].`;
  const suggestion = near.length > 0 ? ` ${didYouMean(name, near)}` : '';
  return `${lead}${suggestion} Call clinicaltrials_get_field_definitions to look up valid PascalCase piece names.`;
}

/**
 * The fields `SEARCH[Location](…)` holds: those of one site, every piece under
 * the record's `Location[]` node. Upstream decides by that place in the record,
 * not by the name — NumLocations is refused, the index-only LocationCountryCode
 * accepted — so a refusal lists these rather than ranking a did-you-mean, which
 * would offer site fields for a study-level count whose name shares their token.
 */
const SITE_FIELDS =
  'LocationFacility, LocationCity, LocationState, LocationZip, LocationCountry, LocationStatus, and the LocationContact… fields';
const LOCATION_WRAPPER = 'SEARCH[Location](…)';
/** A study-level term joined beside the site wrapper, where it applies to the whole study. */
const BESIDE_LOCATION_WRAPPER =
  'AREA[OverallStatus]RECRUITING AND SEARCH[Location](AREA[LocationCity]Seattle)';

/**
 * A field named inside `SEARCH[Location](…)` that no site holds. The explicit
 * hint replaces the declared `field_invalid` one, which sends the caller to
 * look up a name it already has right.
 */
function outsideLocationScope(name: string, upstream: string): McpError {
  const area = `AREA[${name}]`;
  return validationError(
    `${closed(upstream)} ${LOCATION_WRAPPER} holds only the fields of one site — ${SITE_FIELDS} — so '${name}', a field of the study, goes beside it, joined with AND: ${BESIDE_LOCATION_WRAPPER}.`,
    {
      reason: 'field_invalid',
      invalid: [name],
      recovery: {
        hint: `Move ${area} out of ${LOCATION_WRAPPER} and join it beside the wrapper with AND, as in ${BESIDE_LOCATION_WRAPPER}. For one site's own recruiting status, use AREA[LocationStatus] inside the wrapper.`,
      },
    },
    { literals: [area, LOCATION_WRAPPER, BESIDE_LOCATION_WRAPPER, 'AREA[LocationStatus]'] },
  );
}

/**
 * A search area named inside `SEARCH[Location](…)`, which upstream answers
 * `Unknown area name` there though the name works outside the wrapper — so
 * no did-you-mean applies.
 */
function searchAreaInLocationScope(name: string, upstream: string): McpError {
  const area = `AREA[${name}]`;
  return validationError(
    `${closed(upstream)} '${name}' is a search area, and search areas go outside ${LOCATION_WRAPPER}, which holds only the fields of one site: ${SITE_FIELDS}.`,
    {
      reason: 'field_invalid',
      invalid: [name],
      recovery: {
        hint: `Move ${area} out of ${LOCATION_WRAPPER} and join it beside the wrapper with AND, or name a site field such as AREA[LocationCity] inside the wrapper.`,
      },
    },
    { literals: [area, LOCATION_WRAPPER, 'AREA[LocationCity]'] },
  );
}

/**
 * The field types RANGE[] takes, one field of each: every date, integer, and
 * age (`NormalizedTime`) type, whatever its `sourceType`; every other type is
 * refused with `RANGE is not supported for <type> field` (probed 2026-11-09).
 */
const RANGE_FIELD_TYPES = 'date, numeric, and age fields (StartDate, EnrollmentCount, MinimumAge)';
const ENUM_VALUES_OR = 'AREA[Phase]PHASE2 OR AREA[Phase]PHASE3';
const DATE_RANGE = 'AREA[StartDate]RANGE[2020-01-01, MAX]';
/**
 * NCT IDs are assigned in first-posting order, not first-submission order, so
 * a range of IDs stands for a StudyFirstPostDate window.
 */
const NCT_ID_PATH = 'protocolSection.identificationModule.nctId';
const FIRST_POSTED_RANGE = 'AREA[StudyFirstPostDate]RANGE[2017-01-01, 2018-12-31]';

/**
 * RANGE[] on one field whose type takes no range. `entry` is the field the
 * upstream path names, `STRUCT` groups included; without it the path stands in
 * for the piece. A group takes no value either, since AREA[] refuses it.
 */
function rangeTypeUnsupported(
  path: string,
  entry: FieldIndexEntry | undefined,
  upstream: string,
): McpError {
  const piece = entry?.piece ?? path;
  const valueRule = `Any other field takes a value, and an enum several values OR-joined: ${ENUM_VALUES_OR}.`;
  const { tail, hint } =
    path === NCT_ID_PATH
      ? {
          tail: `${valueRule} NCT IDs follow first-posting order, so bound StudyFirstPostDate instead: ${FIRST_POSTED_RANGE}.`,
          hint: `Bound the first posting date instead of the NCT ID, since NCT IDs are assigned in first-posting order: ${FIRST_POSTED_RANGE}.`,
        }
      : entry && isStruct(entry)
        ? {
            tail: `'${piece}' is a group of fields, which AREA[] refuses whatever follows it.`,
            hint: `Name one of the leaf pieces of '${piece}' instead; clinicaltrials_get_field_definitions with mode="drill" and path="${path}" lists them.`,
          }
        : {
            tail: valueRule,
            hint: `Match '${piece}' by value instead of by range, OR-joining several values of an enum as in ${ENUM_VALUES_OR}; keep RANGE[] for ${RANGE_FIELD_TYPES}.`,
          };
  return validationError(
    `${closed(upstream)} '${piece}' takes no RANGE[]: RANGE[] takes ${RANGE_FIELD_TYPES}. ${tail}`,
    { reason: 'field_invalid', invalid: [piece], recovery: { hint } },
    { literals: ['RANGE[]', 'AREA[]', ENUM_VALUES_OR, FIRST_POSTED_RANGE] },
  );
}

/** RANGE[] spanning several fields, which names no one field to blame. */
function rangeOnSeveralFields(upstream: string): McpError {
  return validationError(
    `${closed(upstream)} A bare RANGE[], or one after a search area, spans several fields; RANGE[] needs AREA[Field] naming one of the ${RANGE_FIELD_TYPES}.`,
    {
      reason: 'field_invalid',
      recovery: {
        hint: `Name one field before the range with AREA[Field], as in ${DATE_RANGE}; RANGE[] takes ${RANGE_FIELD_TYPES}.`,
      },
    },
    { literals: ['RANGE[]', 'AREA[Field]', DATE_RANGE] },
  );
}

/** The shape and cap ClinicalTrials.gov enforces on `sort`, stated once. */
const SORT_SHAPE =
  'Format must be FieldName:asc or FieldName:desc (e.g. "LastUpdatePostDate:desc", "EnrollmentCount:asc"). Max 2 fields comma-separated.';

/** What ClinicalTrials.gov sorts on (see isSortable), stated once for both rejections that name a field. */
const SORTABLE_GUIDANCE =
  'Sort on a date or numeric field (e.g. LastUpdatePostDate, EnrollmentCount), or use "@relevance".';

/** One sort item as the caller wrote it, and as it is sent. */
interface SortCorrection {
  from: string;
  to: string;
}

/**
 * Split one `sort` item into its field name and direction suffix (`:asc` /
 * `:desc`, empty when the caller gave none), surrounding whitespace trimmed.
 */
function parseSortItem(item: string): { name: string; suffix: string } {
  const trimmed = item.trim();
  const colon = trimmed.indexOf(':');
  return colon === -1
    ? { name: trimmed, suffix: '' }
    : { name: trimmed.slice(0, colon), suffix: trimmed.slice(colon) };
}

/**
 * Split a `sort` value into its comma-separated items (see parseSortItem).
 * `@relevance` names no field, so it lands in `name` and the field-name fold
 * leaves it alone — no lookup matches it.
 */
function parseSortItems(sort: string): Array<{ name: string; suffix: string }> {
  return sort.split(',').map(parseSortItem);
}

/** An `asc`/`desc` suffix lowercased, the only case upstream accepts; any other suffix as written. */
function sortDirection(suffix: string): string {
  const lowered = suffix.toLowerCase();
  return lowered === ':asc' || lowered === ':desc' ? lowered : suffix;
}

/**
 * Rewrite each sort item that names relevance in another spelling —
 * `relevance`, `Relevance:desc`, `@Relevance` — to `@relevance`, the only one
 * upstream accepts, with its direction lowercased. Upstream answers a bare
 * `relevance` with `Unknown sort field` and `@Relevance` with `incorrect
 * format`, and no record piece, index-only piece, or search area is named
 * relevance in any case, so the rewrite has one reading. It reads no metadata,
 * so it also runs with the field index unavailable or disabled, and it runs
 * ahead of the `filterIds` fit: `@` encodes as `%40`, so `relevance` grows from
 * 9 bytes to 12, and the fit must measure what goes out. Every other item is
 * left byte-identical.
 */
function rewriteRelevance(sort: string): { corrections: SortCorrection[]; sort: string } {
  const corrections: SortCorrection[] = [];
  const items = sort.split(',').map((raw) => {
    const { name, suffix } = parseSortItem(raw);
    if ((name.startsWith('@') ? name.slice(1) : name).toLowerCase() !== 'relevance') return raw;
    const item = `@relevance${sortDirection(suffix)}`;
    if (item !== `${name}${suffix}`) corrections.push({ from: `${name}${suffix}`, to: item });
    return item;
  });
  return { corrections, sort: items.join(',') };
}

/**
 * A request target's size as the upstream front end counts it. Every character
 * is ASCII once the URL is encoded, so its length is its byte count.
 */
function requestTargetBytes(url: URL): number {
  return url.pathname.length + url.search.length;
}

/** Bytes `value` occupies in a query string, encoded as `URLSearchParams` encodes it (`|` → `%7C`). */
function queryEncodedBytes(value: string): number {
  return new URLSearchParams({ v: value }).toString().length - 'v='.length;
}

/**
 * The call's budget ran out. `data.deadlineMs` is the whole call's budget,
 * never the share one request had left; `path` names the request it cut off.
 */
function deadlineExceeded(path?: string, cause?: unknown): McpError {
  return timeout(
    `ClinicalTrials.gov did not answer within this call's ${CALL_BUDGET_MS} ms time budget, which covers every request, retry, and wait the call makes.`,
    { reason: 'retry_deadline_exceeded', deadlineMs: CALL_BUDGET_MS, ...(path ? { path } : {}) },
    cause === undefined ? undefined : { cause },
  );
}

/** Whether `err` is the framework retry ladder's own deadline expiry. */
function isRetryDeadline(err: unknown): err is McpError {
  return (
    err instanceof McpError &&
    err.code === JsonRpcErrorCode.Timeout &&
    err.data?.reason === 'retry_deadline_exceeded'
  );
}

/**
 * The error a request ends with once every attempt failed in a way a retry may
 * clear, built from the last of them: a 429 is a rate limit, a 504 an upstream
 * timeout, and anything else — another 5xx, an HTML page in place of JSON, a
 * dropped or timed-out connection — an outage. `status` is undefined for a
 * failure that carried no HTTP status.
 */
function exhausted(
  path: string,
  lastError: string,
  status: number | undefined,
  retries: number,
): McpError {
  if (status === 429) {
    return rateLimited(`Rate limited by ClinicalTrials.gov after ${retries} retries`, {
      path,
      lastError,
      reason: 'rate_limited',
    });
  }
  if (status === 504) {
    return timeout('ClinicalTrials.gov timed out (HTTP 504) on every attempt', {
      path,
      lastError,
      lastStatus: status,
      reason: 'upstream_timeout',
    });
  }
  return serviceUnavailable('ClinicalTrials.gov API unavailable after retries', {
    path,
    lastError,
    ...(status !== undefined ? { lastStatus: status } : {}),
  });
}

/**
 * A fetch rejection a retry may clear: a timeout or abort that neither the
 * caller nor the call's budget raised, or a connection that dropped. Anything
 * else a fetch throws — an invalid URL, a refused connection — fails the same
 * way on every attempt.
 */
function isTransientFetchError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { name, code, cause } = err as {
    cause?: { code?: unknown };
    code?: unknown;
    name?: unknown;
  };
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const transport = code ?? cause?.code;
  return typeof transport === 'string' && TRANSIENT_NETWORK_CODES.has(transport);
}

/**
 * One attempt's outcome: the parsed body, or a failure a retry may clear,
 * already shaped as the error the request ends with should it be the last.
 * Every other failure is thrown.
 */
type AttemptOutcome<T> = { ok: true; value: T } | { failure: McpError; ok: false };

/**
 * Mark each stat as multi-valued by checking the metadata tree for an array
 * marker (`[]`, e.g. `Phase[]`, `Location[]`) — the durable source of
 * cardinality. Two shapes qualify: the leaf's own node type is array-typed,
 * or an ancestor object on its path is (`LocationCountry` is scalar `text`,
 * but sits under `locations: Location[]`, so a study carries one per site).
 * Note: the stat's own `type` (`ENUM`/`STRING`) is the value domain, not the
 * array marker, so the metadata tree is the only signal.
 */
function annotateMultiValued(stats: FieldValueStats[], { byPiece }: FieldIndex): void {
  for (const stat of stats) {
    const entry = byPiece.get(stat.piece);
    if (entry && (isArrayType(entry.type) || entry.hasArrayAncestor)) stat.multiValued = true;
  }
}

/**
 * The `field_invalid` for `/stats/field/values`' `Unsupported field type: <T>`,
 * which names the type and never the field. The requested pieces whose
 * metadata `type`, `[]` stripped, is T are the ones named (`GeoPoint` →
 * LocationGeoPoint); without an index, a lone requested field is the one.
 */
function describeUnsupportedType(
  type: string,
  fields: string[],
  index: FieldIndex | undefined,
  cause: unknown,
): McpError {
  const typed = fields.filter((f) => index?.byPiece.get(f)?.type?.replace(/\[\]$/, '') === type);
  const invalid = typed.length > 0 ? typed : fields.length === 1 ? fields : [];
  const lead =
    invalid.length > 0
      ? `Invalid field for value statistics: ${quoted(invalid)} ${invalid.length === 1 ? 'has' : 'have'} type ${type}, which ClinicalTrials.gov does not count.`
      : `Invalid field for value statistics: ClinicalTrials.gov does not count fields of type ${type}, and does not say which of ${quoted(fields)} has it.`;
  return validationError(
    `${lead} It counts values in leaf pieces of other types: a group of fields such as LeadSponsor or ConditionMesh is refused the same way, and its leaf pieces (LeadSponsorName, ConditionMeshTerm) are counted.`,
    { reason: 'field_invalid', ...(invalid.length > 0 ? { invalid } : {}) },
    { cause },
  );
}

/** A search page, plus the `filterIds` its request had no room for. */
export interface SearchStudiesResult extends PagedStudiesResponse {
  /** Trailing `filterIds` left out of the request, in order. Absent when every ID went out. */
  deferredIds?: string[];
}

/** Constructor options for overriding retry/backoff/validation behavior (primarily for tests). */
export interface ClinicalTrialsServiceOptions {
  baseBackoffMs?: number;
  /** Timeout for each read behind the second AREA[] and `sort` tier; defaults to EXTENDED_READ_TIMEOUT_MS. */
  extendedReadTimeoutMs?: number;
  maxBackoffMs?: number;
  maxRetries?: number;
  /**
   * Whether to validate `fields` against the cached metadata index before
   * making API calls, and to correct and suggest AREA[] field names from it.
   * Defaults to true; lazy-fetches /studies/metadata on first use, then caches
   * the index in-memory.
   */
  validateFieldsLocally?: boolean;
}

export class ClinicalTrialsService {
  /**
   * The per-call page cap (`CT_MAX_PAGE_SIZE`, 1–1000) for a caller's own page
   * request — `clinicaltrials_search_studies` serves at most this many studies
   * per page and discloses the cut. Every `searchStudies` call sends the
   * `pageSize` it is given unchanged, so internal fetches sized by their own
   * input (the results ID batch, the eligibility candidate fetch) never lose
   * studies to it.
   */
  readonly maxPageSize: number;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly extendedReadTimeoutMs: number;
  private readonly validateFieldsLocally: boolean;
  /**
   * Every request's slot: starts at least MIN_INTERVAL_MS apart, in arrival
   * order, whichever call or retry they belong to. A request that leaves the
   * queue — its call cancelled or out of budget — spends no gap.
   */
  private readonly pacer = createPacer({
    name: 'clinicaltrials.gov',
    minStartGapMs: MIN_INTERVAL_MS,
  });
  /** When each call's budget runs out, set the first time the call reaches the service. */
  private readonly deadlineByCall = new WeakMap<Context, number>();
  /**
   * The field index, loaded once for the process and kept: the load in flight
   * or its success, cleared when it fails so the next call loads afresh.
   */
  private fieldIndexLoad: Promise<FieldIndex> | undefined;
  /** Each call's one attempt at the field index, shared by every consumer in that call. */
  private readonly fieldIndexByCall = new WeakMap<Context, Promise<FieldIndex>>();
  /**
   * The two reads behind the second tier, each kept once it succeeds and
   * cleared when it fails, so a source that is down costs only its own re-read.
   */
  private indexOnlyRead: Promise<ExtendedName[]> | undefined;
  private searchAreasRead: Promise<ExtendedName[]> | undefined;
  /** Each call's one attempt at the second tier, shared by every consumer in that call. */
  private readonly extendedByCall = new WeakMap<Context, Promise<ExtendedIndex | undefined>>();

  constructor(config: ServerConfig, options: ClinicalTrialsServiceOptions = {}) {
    this.baseUrl = config.apiBaseUrl;
    this.timeoutMs = config.requestTimeoutMs;
    this.maxPageSize = config.maxPageSize;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.extendedReadTimeoutMs = options.extendedReadTimeoutMs ?? EXTENDED_READ_TIMEOUT_MS;
    this.validateFieldsLocally = options.validateFieldsLocally ?? true;
  }

  /**
   * Search studies with query, filters, pagination, and field selection. A
   * `filterIds` list is fitted to one request first: the leading IDs that fit
   * beside every other parameter go out, and the rest come back unqueried in
   * `deferredIds` (see fitFilterIds). A relevance sort is spelled as upstream
   * accepts it before the fit (rewriteRelevance); every other correction comes
   * after it and never lengthens the request.
   */
  async searchStudies(params: SearchParams, ctx: Context): Promise<SearchStudiesResult> {
    const sortCorrections: SortCorrection[] = [];
    if (params.sort) {
      const relevance = rewriteRelevance(params.sort);
      sortCorrections.push(...relevance.corrections);
      params = { ...params, sort: relevance.sort };
    }
    let deferredIds: string[] = [];
    if (params.filterIds?.length) {
      const fit = this.fitFilterIds(params.filterIds, params);
      params = { ...params, filterIds: fit.sent };
      deferredIds = fit.deferred;
    }
    if (this.validateFieldsLocally && params.fields?.length) {
      const normalized = await this.normalizeFields(params.fields, ctx);
      await this.validateFields(normalized, ctx, 'projection');
      params = { ...params, fields: normalized };
    }
    if (this.validateFieldsLocally && params.sort) {
      const folded = await this.normalizeSort(params.sort, ctx);
      sortCorrections.push(...folded.corrections);
      params = { ...params, sort: folded.sort };
    }
    if (sortCorrections.length > 0) {
      ctx.log.notice('Sort field auto-corrected', { corrections: sortCorrections });
    }
    const q = this.buildSearchQuery(params);
    ctx.log.debug('searchStudies', { paramKeys: Object.keys(q), deferred: deferredIds.length });
    const page = await this.fetchJson<PagedStudiesResponse>('/studies', q, ctx);
    return deferredIds.length > 0 ? { ...page, deferredIds } : page;
  }

  /**
   * Count the studies matching a query and filters. Upstream answers
   * `pageSize=0` with its default page of ten full studies, so the count asks
   * for one study projected to `NCTId` — the total rides the same response.
   * The fixed projection skips local field validation, which would otherwise
   * fetch `/studies/metadata` on a fresh server's first count.
   */
  async countStudies(params: CountParams, ctx: Context): Promise<number> {
    const q = this.buildSearchQuery({
      ...params,
      countTotal: true,
      pageSize: 1,
      fields: ['NCTId'],
    });
    ctx.log.debug('countStudies', { paramKeys: Object.keys(q) });
    const { totalCount } = await this.fetchJson<PagedStudiesResponse>('/studies', q, ctx);
    return totalCount ?? 0;
  }

  /** Fetch a single study by NCT ID. */
  getStudy(nctId: string, ctx: Context): Promise<Study> {
    ctx.log.debug('getStudy', { nctId });
    return this.fetchJson<Study>(`/studies/${encodeURIComponent(nctId)}`, {}, ctx, {
      studyId: nctId,
    });
  }

  /**
   * Fetch multiple studies by NCT IDs in a single request. Returns
   * identification and results section data.
   *
   * `NCTIdAlias` is requested alongside `NCTId` because the endpoint resolves a
   * previous (alias) ID to its canonical record silently: the record comes back
   * under an ID the caller never asked for, and the alias list is the only thing
   * tying it to the ID they did ask for.
   *
   * A batch of 20 IDs (the results tool's per-call cap) comes to about 400
   * bytes of the request-target limit, so the ID fit in searchStudies never
   * defers one here.
   */
  async getStudiesBatch(nctIds: string[], ctx: Context): Promise<Study[]> {
    ctx.log.debug('getStudiesBatch', { count: nctIds.length });
    const response = await this.searchStudies(
      {
        filterIds: nctIds,
        fields: ['NCTId', 'NCTIdAlias', 'BriefTitle', 'HasResults', 'ResultsSection'],
        pageSize: nctIds.length,
        // ID-targeted lookups must never filter the caller's selection.
        includeUnknownEnrollment: true,
      },
      ctx,
    );
    return response.studies;
  }

  /** Get field definitions (metadata tree) from the data model. */
  getMetadata(includeIndexedOnly: boolean, ctx: Context): Promise<FieldNode[]> {
    ctx.log.debug('getMetadata', { includeIndexedOnly });
    const params: Record<string, string> = {};
    if (includeIndexedOnly) params.includeIndexedOnly = 'true';
    return this.fetchJson<FieldNode[]>('/studies/metadata', params, ctx, { jsonFormat: false });
  }

  /**
   * Get field value statistics for the specified fields. Upstream counts leaf
   * pieces only, so validateFields refuses a group of fields locally, naming its
   * leaves. The 400 upstream answers any other type it cannot count with — a
   * leaf such as LocationGeoPoint, or a group when no index checked the call —
   * is translated to the same `field_invalid` (describeUnsupportedType).
   */
  async getFieldValues(fields: string[], ctx: Context): Promise<FieldValueStats[]> {
    ctx.log.debug('getFieldValues', { fields });
    let index: FieldIndex | undefined;
    if (this.validateFieldsLocally) {
      fields = await this.normalizeFields(fields, ctx);
      index = await this.validateFields(fields, ctx, 'statistics');
    }
    try {
      const stats = await this.fetchJson<FieldValueStats[]>(
        '/stats/field/values',
        { fields: fields.join('|') },
        ctx,
        { jsonFormat: false },
      );
      // Flag multi-valued fields so callers can read the per-value counts
      // correctly — array-type fields (e.g. Phase, Condition) let one study carry
      // several values, so buckets sum above the study total. Reads the index
      // validateFields checked the call against, so this adds no round-trip;
      // skipped without one (local validation disabled or metadata unavailable).
      if (index) annotateMultiValued(stats, index);
      return stats;
    } catch (err) {
      const unsupportedType =
        err instanceof McpError ? parseUnsupportedFieldType(err.message) : undefined;
      if (unsupportedType) {
        throw describeUnsupportedType(unsupportedType, fields, index, err);
      }
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        // Upstream reports only the first bad name ("Unknown piece name of field
        // path: X"); extract X so we blame only that field. When multi-field
        // requests fail, other inputs may also be bad — upstream doesn't say,
        // so we note that in the error text.
        const match = err.message.match(/Unknown piece name of field path:\s*(\S+)/i);
        const badName = match?.[1];
        const message = badName
          ? fields.length > 1 && !fields.every((f) => f === badName)
            ? `Invalid field name: '${badName}'. Other submitted fields (${fields
                .filter((f) => f !== badName)
                .join(
                  ', ',
                )}) may also be invalid — upstream reports only the first offender. Re-run without '${badName}' to verify the rest.`
            : `Invalid field name: '${badName}'.`
          : `Invalid field name(s): ${fields.join(', ')}.`;
        throw validationError(
          `${message} Use PascalCase piece names like OverallStatus, Phase, StudyType, InterventionType, LeadSponsorClass, Sex, StdAge. Call clinicaltrials_get_field_definitions to browse the full field tree.`,
          { reason: 'field_invalid' },
        );
      }
      throw err;
    }
  }

  /**
   * Search the field model by keyword, returning ranked matches with paths and
   * types plus the pre-cap match total for accurate truncation disclosure.
   */
  async searchFieldDefinitions(
    query: string,
    limit: number,
    ctx: Context,
  ): Promise<{ entries: FieldIndexEntry[]; total: number }> {
    ctx.log.debug('searchFieldDefinitions', { query, limit });
    const { entries } = await this.getFieldIndex(ctx);
    return searchFields(query, entries, limit);
  }

  /**
   * The AREA[] name index (see buildAreaIndex), built with the cached field
   * index, and the loader for the second tier behind it — the index-only pieces
   * and search areas — scoped to this call. Undefined when local validation is
   * disabled or /studies/metadata cannot be fetched — AREA[] names then reach
   * upstream as written.
   *
   * @throws the caller's cancellation, which never passes for an unavailable index.
   */
  async getAreaIndex(ctx: Context): Promise<AreaLookup | undefined> {
    const index = await this.areaFieldIndex(ctx);
    return index && { ...index.area, extended: () => this.getExtendedIndex(index, ctx) };
  }

  /* ------------------------------------------------------------------ */
  /*  Internal                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The field index for the AREA[] lookups — the name rewrite, and the names
   * and suggestions on an upstream rejection — or undefined, with a warning,
   * when local validation is disabled or /studies/metadata cannot be fetched.
   *
   * @throws the caller's cancellation, which never passes for an unavailable index.
   */
  private async areaFieldIndex(ctx: Context): Promise<FieldIndex | undefined> {
    if (!this.validateFieldsLocally) return undefined;
    try {
      return await this.getFieldIndex(ctx);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log.warning('AREA[] field-name lookup skipped — metadata unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * The record entry at a metadata path as upstream names it in a rejection
   * (`protocolSection.designModule.phases` → Phase, `hasResults` → HasResults),
   * `STRUCT` groups included (LeadSponsor). Undefined when the index is
   * unavailable or holds no such path, such as an index-only piece's. Runs on
   * the error path of a call whose AREA[] text already loaded the index, so it
   * normally costs no request, and it fails open: a metadata failure never
   * replaces the rejection being described.
   *
   * @throws the caller's cancellation.
   */
  private async entryAtPath(path: string, ctx: Context): Promise<FieldIndexEntry | undefined> {
    const index = await this.areaFieldIndex(ctx);
    const piece = index?.paths.exact.get(path);
    return piece === undefined ? undefined : index?.byPiece.get(piece);
  }

  /**
   * The second tier for this call, read when a name misses the record tier:
   * one attempt per call, shared by every consumer in it — the AREA[] rewrite,
   * the sort fold, the suggestions on an upstream rejection — so a read that
   * failed is not retried before the call ends, and the next call that needs it
   * reads it afresh. Undefined when either read fails, which leaves the call
   * exactly as it would be with the record tier alone.
   *
   * @throws the caller's cancellation, never passed off as an unavailable tier.
   */
  private getExtendedIndex(index: FieldIndex, ctx: Context): Promise<ExtendedIndex | undefined> {
    let attempt = this.extendedByCall.get(ctx);
    if (!attempt) {
      attempt = this.loadExtendedIndex(index, ctx);
      this.extendedByCall.set(ctx, attempt);
    }
    return attempt;
  }

  /**
   * The reads run on their own signal and timeout (readReference); this call's
   * wait on them ends with its cancellation or its budget, and a call with no
   * budget left starts neither. A budget that ends the wait degrades the call
   * like a failed read, and its next request reports the expiry.
   */
  private async loadExtendedIndex(
    index: FieldIndex,
    ctx: Context,
  ): Promise<ExtendedIndex | undefined> {
    try {
      const [indexOnly, areas] = await this.untilCallEnds(
        () => Promise.all([this.readIndexOnly(ctx), this.readSearchAreas(ctx)]),
        ctx,
      );
      return buildExtendedIndex(index.entries, [...indexOnly, ...areas]);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log.warning('Index-only piece and search-area lookup skipped — read failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private readIndexOnly(ctx: Context): Promise<ExtendedName[]> {
    this.indexOnlyRead ??= this.readReference<FieldNode[]>(
      '/studies/metadata',
      { includeIndexedOnly: 'true' },
      ctx,
    )
      .then(indexOnlyNames)
      .catch((err: unknown) => {
        this.indexOnlyRead = undefined;
        throw err;
      });
    return this.indexOnlyRead;
  }

  private readSearchAreas(ctx: Context): Promise<ExtendedName[]> {
    this.searchAreasRead ??= this.readReference<SearchAreaGroup[]>('/studies/search-areas', {}, ctx)
      .then(searchAreaNames)
      .catch((err: unknown) => {
        this.searchAreasRead = undefined;
        throw err;
      });
    return this.searchAreasRead;
  }

  /**
   * One attempt at a reference read behind the second tier, under its own short
   * timeout. It runs on a context of its own — its own signal and budget, never
   * the caller's: concurrent callers await the same read, so one caller
   * cancelling or running out of time must not fail it for the rest. Each
   * caller's wait ends on its own instead (untilCallEnds), and the read stays
   * bounded by its timeout.
   */
  private readReference<T>(path: string, params: Record<string, string>, ctx: Context): Promise<T> {
    return this.fetchJson<T>(
      path,
      params,
      { ...ctx, signal: new AbortController().signal },
      { jsonFormat: false, maxRetries: 0, timeoutMs: this.extendedReadTimeoutMs },
    );
  }

  /**
   * The field index for this call: one attempt per call, shared by every
   * consumer in it — field normalization and validation, the sort fold, the
   * AREA[] lookup, the multi-value flags — so a load that failed is not retried
   * before the call ends, and the next call loads afresh.
   */
  private getFieldIndex(ctx: Context): Promise<FieldIndex> {
    let attempt = this.fieldIndexByCall.get(ctx);
    if (!attempt) {
      attempt = this.awaitFieldIndex(ctx);
      this.fieldIndexByCall.set(ctx, attempt);
    }
    return attempt;
  }

  /**
   * Wait on the process-wide field index. The first call to need it loads it on
   * its own context — its signal and its budget — and every other call waits
   * on that load until the load settles or the waiting call ends. A load that
   * ended with the call running it — cancelled, or out of budget — is no answer
   * for a call still live and within its own budget, which starts the load
   * again on its own.
   */
  private async awaitFieldIndex(ctx: Context): Promise<FieldIndex> {
    for (;;) {
      try {
        return await this.untilCallEnds(
          () => (this.fieldIndexLoad ??= this.loadFieldIndex(ctx)),
          ctx,
        );
      } catch (err) {
        const othersEnd =
          !ctx.signal.aborted &&
          err instanceof McpError &&
          (err.code === JsonRpcErrorCode.RequestCancelled ||
            (isRetryDeadline(err) && this.remainingMs(ctx) > 0));
        if (!othersEnd) throw err;
      }
    }
  }

  /** Fetch /studies/metadata and build the field index from it, dropping a failed load. */
  private async loadFieldIndex(ctx: Context): Promise<FieldIndex> {
    try {
      const index = buildFieldIndex(await this.getMetadata(false, ctx));
      ctx.log.debug('Field index built', {
        entryCount: index.entries.length,
        caseFoldable: index.caseFold.size,
        areaNames: index.area.names.size,
      });
      return index;
    } catch (err) {
      this.fieldIndexLoad = undefined;
      throw err;
    }
  }

  /** Milliseconds left of `ctx`'s budget, starting it on the call's first reach into the service. */
  private remainingMs(ctx: Context): number {
    let deadlineAt = this.deadlineByCall.get(ctx);
    if (deadlineAt === undefined) {
      deadlineAt = Date.now() + CALL_BUDGET_MS;
      this.deadlineByCall.set(ctx, deadlineAt);
    }
    return Math.max(0, deadlineAt - Date.now());
  }

  /**
   * `start()`'s outcome, or the end of the call waiting on it — its caller
   * cancelling, or its budget running out — whichever comes first. Only the
   * wait ends: the work runs on, since other calls may be awaiting it. A call
   * already over never calls `start`, so nothing is sent on its behalf.
   */
  private untilCallEnds<T>(start: () => Promise<T>, ctx: Context): Promise<T> {
    const { signal } = ctx;
    if (signal.aborted) return Promise.reject(requestCancelled('Request cancelled by caller'));
    const remainingMs = this.remainingMs(ctx);
    if (remainingMs === 0) return Promise.reject(deadlineExceeded());
    const work = start();
    return new Promise<T>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        done();
        reject(requestCancelled('Request cancelled by caller'));
      };
      const timer = setTimeout(() => {
        done();
        reject(deadlineExceeded());
      }, remainingMs);
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => {
          done();
          resolve(value);
        },
        (err: unknown) => {
          done();
          reject(err);
        },
      );
    });
  }

  /**
   * Apply unambiguous fixes to field names before validation: trim the
   * surrounding whitespace, fold a case-only miss to its piece, map a metadata
   * path — as clinicaltrials_get_field_definitions prints it, or in another
   * case — to its piece (`protocolSection.statusModule.overallStatus` →
   * `OverallStatus`), and apply the legacy renames. Each yields a name no longer
   * than the one it replaces. Returns the corrected list — anything still
   * invalid falls through to validateFields and surfaces the structured
   * did-you-mean error. Logs corrections via ctx.log.notice so operators can
   * spot recurring LLM mistakes without forcing a tool-call round-trip.
   */
  private async normalizeFields(fields: string[], ctx: Context): Promise<string[]> {
    let index: FieldIndex;
    try {
      index = await this.getFieldIndex(ctx);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      // Fall through silently — validateFields runs next and emits the
      // metadata-unavailable warning + fail-open behavior on the same failure.
      return fields;
    }
    const { byPiece, caseFold, paths } = index;
    const corrections: Array<{ from: string; to: string }> = [];
    const normalized = fields.map((f) => {
      if (byPiece.has(f)) return f;
      const trimmed = f.trim();
      if (trimmed !== f && byPiece.has(trimmed)) {
        corrections.push({ from: f, to: trimmed });
        return trimmed;
      }
      const lowered = trimmed.toLowerCase();
      const corrected =
        caseFold.get(lowered) ??
        paths.exact.get(trimmed) ??
        paths.fold.get(lowered) ??
        KNOWN_FIELD_RENAMES.get(lowered.replace(/[\s_]+/g, ''));
      if (corrected) {
        corrections.push({ from: f, to: corrected });
        return corrected;
      }
      return f;
    });
    if (corrections.length > 0) {
      ctx.log.notice('Field names auto-corrected', { corrections });
    }
    return normalized;
  }

  /**
   * Apply the same unambiguous fixes normalizeFields makes for `fields` to the
   * field name inside `sort`, reusing the one case-fold index: trim the
   * surrounding whitespace, case-fold the name, lowercase an `asc`/`desc`
   * suffix. Each is a shape ClinicalTrials.gov rejects outright — a space after
   * a comma, `enrollmentCount:desc`, `EnrollmentCount:DESC` — so correcting
   * them here spends no round-trip on a pure casing or spacing mistake.
   *
   * A name the record pieces leave unresolved is looked up among the
   * index-only pieces and their alt names the same way (`numlocations:desc` →
   * `NumLocations:desc`); upstream sorts on those. Never among the search areas,
   * which it refuses to sort on.
   *
   * Normalization never rejects. The metadata index knows which pieces exist,
   * and isSortable which types upstream sorts on, but a type list drifts, so an
   * unsortable name (`BriefTitle`) is left for upstream to judge and its
   * rejection is translated in the 400 handler. `@relevance` matches no entry
   * and passes through untouched; rewriteRelevance has already spelled it.
   * Returns the corrections for searchStudies to log beside the relevance ones.
   */
  private async normalizeSort(
    sort: string,
    ctx: Context,
  ): Promise<{ corrections: SortCorrection[]; sort: string }> {
    let index: FieldIndex;
    try {
      index = await this.getFieldIndex(ctx);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      // Same fail-open as normalizeFields — the request still reaches upstream.
      return { corrections: [], sort };
    }
    /** The record tier: a piece as written, else the piece its case fold names. */
    const record = (name: string) =>
      index.byPiece.has(name) ? name : index.caseFold.get(name.toLowerCase());
    const items = parseSortItems(sort);
    const missed = items.some(({ name }) => name !== '' && !name.startsWith('@') && !record(name));
    const extended = missed ? (await this.getExtendedIndex(index, ctx))?.sort : undefined;
    const corrections: SortCorrection[] = [];
    const normalized = items
      .map(({ name, suffix }) => {
        const folded = record(name) ?? (extended && resolveName(name, extended)) ?? name;
        const original = `${name}${suffix}`;
        const item = `${folded}${sortDirection(suffix)}`;
        if (item !== original) corrections.push({ from: original, to: item });
        return item;
      })
      .join(',');
    return { corrections, sort: normalized };
  }

  /**
   * The sort items upstream refused, each with its nearest pieces that sort —
   * record pieces and index-only pieces alike filtered by isSortable, so
   * following a suggestion never draws `Unsupported sort field type` in turn,
   * led by any index-only piece the name is a near miss of. `unknown` blames
   * the items absent from the record pieces and the index-only names;
   * `unsortable` the items the index knows and marks unsortable
   * (`StartDateStruct`). The second tier is read only when an item misses the
   * record tier, and once per call, so it is already loaded by the sort fold.
   * Fails open to none: this runs on an error path where the index may be
   * unavailable or disabled, and no suggestion is better than a metadata fetch
   * that throws over the real error.
   *
   * @throws the caller's cancellation.
   */
  private async suggestSortFields(
    sort: string,
    rejected: 'unknown' | 'unsortable',
    ctx: Context,
  ): Promise<Array<{ name: string; near: string[] }>> {
    if (!this.validateFieldsLocally) return [];
    let index: FieldIndex;
    try {
      index = await this.getFieldIndex(ctx);
    } catch {
      return [];
    }
    const names = parseSortItems(sort)
      .map(({ name }) => name)
      .filter((name) => name.length > 0 && !name.startsWith('@'));
    const extended = names.some((name) => !index.byPiece.has(name))
      ? await this.getExtendedIndex(index, ctx)
      : undefined;
    const indexOnly = extended?.extras.filter((e) => e.kind === 'index-only') ?? [];
    const blamed = names.filter((name) => {
      if (rejected === 'unknown') {
        return !index.byPiece.has(name) && !extended?.sort.names.has(name);
      }
      const type =
        index.byPiece.get(name)?.type ?? indexOnly.find((e) => e.names.includes(name))?.type;
      return type !== undefined && !isSortable(type);
    });
    if (blamed.length === 0) return [];
    const entries = index.entries.filter((e) => isSortable(e.type));
    const extras = indexOnly.filter((e) => isSortable(e.type));
    return blamed
      .map((name) => ({ name, near: nearestPieces(name, entries, 3, extras) }))
      .filter(({ near }) => near.length > 0);
  }

  /**
   * The `field_invalid` for an AREA[] or RANGE[] term upstream refused (see
   * parseAreaRejection).
   *
   * A name upstream does not know, or refuses as a group, keeps the declared
   * hint and gets up to three AREA[]-searchable pieces nearest it, led by any
   * index-only piece or search area it is a near miss of when the record tier
   * misses it — drawn from the AREA index, so no suggestion is a `STRUCT` piece
   * upstream would refuse in turn. A listed search area upstream does not know
   * was named inside `SEARCH[Location](…)`, the one place it is unknown, and is
   * told so with no did-you-mean. Every other kind is a valid field in the
   * wrong place, which the declared hint (look the name up) misdirects, so each
   * carries a hint of its own. The lookups read the index the caller's AREA[]
   * text already loaded and fail open: this runs on an error path, where a
   * metadata failure must not replace the real error.
   *
   * @throws the caller's cancellation.
   */
  private async describeRejectedTerm(
    rejection: AreaRejection,
    text: string,
    ctx: Context,
  ): Promise<McpError> {
    const upstream = text.trim();
    switch (rejection.kind) {
      case 'location-scope':
        return outsideLocationScope(rejection.name, upstream);
      case 'range-type':
        return rangeTypeUnsupported(
          rejection.path,
          await this.entryAtPath(rejection.path, ctx),
          upstream,
        );
      case 'range-fields':
        return rangeOnSeveralFields(upstream);
      case 'unknown':
      case 'unsearchable': {
        const { name } = rejection;
        const area = await this.getAreaIndex(ctx);
        const extended =
          area?.extended && missesRecordTier(name, area) ? await area.extended() : undefined;
        const searchArea = extended?.extras.some(
          (e) => e.kind === 'search-area' && e.names.includes(name),
        );
        if (rejection.kind === 'unknown' && searchArea) {
          return searchAreaInLocationScope(name, upstream);
        }
        const near = area ? nearestPieces(name, area.entries, 3, extended?.extras) : [];
        return validationError(describeAreaRejection(rejection, upstream, near), {
          reason: 'field_invalid',
          invalid: [name],
          ...(near.length > 0 ? { suggestions: Object.fromEntries([[name, near]]) } : {}),
        });
      }
    }
  }

  /**
   * Reduce an upstream `sort` rejection to one actionable sentence. The 2-item
   * cap, an unsortable field type, and an unrecognized field name are three
   * different things for a caller to fix, so each is told apart by its own
   * upstream phrase rather than collapsed into one message.
   */
  private async describeSortRejection(sort: string, text: string, ctx: Context): Promise<string> {
    const lead = `Invalid value for \`sort\`: '${sort}'.`;

    const cap = text.match(/must contain no more than (\d+) items/i)?.[1];
    if (cap) {
      return `${lead} It names ${sort.split(',').length} fields; ClinicalTrials.gov accepts at most ${cap}. ${SORT_SHAPE}`;
    }

    const blame = async (rejected: 'unknown' | 'unsortable') =>
      (await this.suggestSortFields(sort, rejected, ctx))
        .map(({ name, near }) => ` ${didYouMean(name, near)}`)
        .join('');

    // The field exists but its data type is not sortable — say what to sort on
    // instead, and which sortable pieces sit nearest the one sent.
    const unsortableType = text.match(/Unsupported sort field type:\s*(\S+)/i)?.[1];
    if (unsortableType) {
      return `${lead} ClinicalTrials.gov does not sort on ${unsortableType} fields.${await blame('unsortable')} ${SORTABLE_GUIDANCE} ${SORT_SHAPE}`;
    }

    return `${lead} ClinicalTrials.gov does not recognize the sort field name.${await blame('unknown')} ${SORTABLE_GUIDANCE} ${SORT_SHAPE} Call clinicaltrials_get_field_definitions to look up sortable PascalCase field names.`;
  }

  /**
   * Reject invalid field names locally with did-you-mean suggestions, and
   * return the index the call was checked against — undefined when it cannot
   * be loaded, which lets the request through unchecked. A dotted name no
   * metadata path matches is ranked on its last segment
   * (`protocolSection.designModule.phase` → `Phase`): ranked whole, its
   * enclosing module and section outrank the leaf.
   *
   * `projection` is a search's `fields`, which takes every piece, groups
   * included. `statistics` is clinicaltrials_get_field_values, which upstream
   * answers for leaf pieces only (`Unsupported field type`): a requested group
   * is refused with its direct leaf pieces as its suggestions — or, when it
   * holds only groups, with its clinicaltrials_get_field_definitions drill
   * path — and no did-you-mean there names a group.
   *
   * @throws the caller's cancellation, never logged as unavailable metadata.
   */
  private async validateFields(
    fields: string[],
    ctx: Context,
    use: 'projection' | 'statistics',
  ): Promise<FieldIndex | undefined> {
    let index: FieldIndex;
    try {
      index = await this.getFieldIndex(ctx);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      // Fail open — if the metadata index can't be built, fall through to the
      // upstream API and let its error handling surface any problem. Worst case,
      // the agent gets the same error it would have without pre-validation.
      ctx.log.warning('Field validation skipped — metadata unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
    const unknown = fields.filter((f) => !index.byPiece.has(f));
    const groups =
      use === 'statistics'
        ? fields.flatMap((f) => {
            const entry = index.byPiece.get(f);
            return entry && isStruct(entry) ? [entry] : [];
          })
        : [];
    if (unknown.length === 0 && groups.length === 0) return index;

    const pool = use === 'statistics' ? index.area.entries : index.entries;
    const near = unknown.map(
      (f) => [f, nearestPieces(f.split('.').filter(Boolean).pop() ?? f, pool, 3)] as const,
    );
    const leaves = groups.map(
      (group) =>
        [
          group,
          index.entries
            .filter((e) => !isStruct(e) && e.path === `${group.path}.${e.name}`)
            .map((e) => e.piece),
        ] as const,
    );

    const parts: string[] = [];
    if (unknown.length > 0) {
      parts.push(
        unknown.length === 1
          ? `Invalid field name: '${unknown[0]}'.`
          : `Invalid field names: ${quoted(unknown)}.`,
      );
      for (const [f, pieces] of near) {
        if (pieces.length > 0) parts.push(didYouMean(f, pieces));
      }
    }
    for (const [{ piece, path }, pieces] of leaves) {
      parts.push(
        pieces.length > 0
          ? `'${piece}' is a group of fields; ClinicalTrials.gov counts values in its leaf pieces only: ${quoted(pieces)}.`
          : `'${piece}' holds only groups of fields; call clinicaltrials_get_field_definitions with mode="drill" and path="${path}" to find its leaf pieces.`,
      );
    }
    const refused = new Set([...unknown, ...groups.map((g) => g.piece)]);
    const suggestions = Object.fromEntries(
      [...near, ...leaves.map(([group, pieces]) => [group.piece, pieces] as const)].filter(
        ([, pieces]) => pieces.length > 0,
      ),
    );

    throw validationError(parts.join(' '), {
      reason: 'field_invalid',
      invalid: fields.filter((f) => refused.has(f)),
      ...(Object.keys(suggestions).length > 0 ? { suggestions } : {}),
    });
  }

  private buildSearchQuery(params: SearchParams): Record<string, string> {
    const q: Record<string, string> = {};
    if (params.queryTerm) q['query.term'] = params.queryTerm;
    if (params.queryCond) q['query.cond'] = params.queryCond;
    if (params.queryIntr) q['query.intr'] = params.queryIntr;
    if (params.queryLocn) q['query.locn'] = params.queryLocn;
    if (params.querySpons) q['query.spons'] = params.querySpons;
    if (params.queryTitles) q['query.titles'] = params.queryTitles;
    if (params.queryOutc) q['query.outc'] = params.queryOutc;
    if (params.filterOverallStatus?.length)
      q['filter.overallStatus'] = params.filterOverallStatus.join('|');
    if (params.filterGeo) q['filter.geo'] = params.filterGeo;
    if (params.filterIds?.length) q['filter.ids'] = params.filterIds.join('|');
    const advancedParts: string[] = [];
    if (params.filterAdvanced) advancedParts.push(params.filterAdvanced);
    if (!params.includeUnknownEnrollment) advancedParts.push(ENROLLMENT_SENTINEL_FILTER);
    if (advancedParts.length > 0) {
      q['filter.advanced'] =
        advancedParts.length === 1
          ? advancedParts.join('')
          : advancedParts.map((p) => `(${p})`).join(' AND ');
    }
    if (params.fields?.length) q.fields = params.fields.join('|');
    if (params.sort) q.sort = params.sort;
    if (params.countTotal !== undefined) q.countTotal = String(params.countTotal);
    if (params.pageSize !== undefined) q.pageSize = String(params.pageSize);
    if (params.pageToken) q.pageToken = params.pageToken;
    return q;
  }

  /**
   * Split an ID list into the leading run one request carries and the rest.
   *
   * Measured on the request as it is built and encoded, from the params as
   * given — after the relevance rewrite, the one correction that lengthens a
   * request (`relevance` → `@relevance`, see rewriteRelevance), and before
   * field and sort normalization, which only trims, case-folds, maps a metadata
   * path to its piece, and applies the legacy field renames, each to an equal or
   * shorter name, so the request sent is never longer than the one measured, and
   * the fit does not shift between pages when the metadata index is reachable
   * for one page and not the next. The paging parameters stay out of the
   * measurement, covered by PAGING_RESERVE_BYTES: upstream accepts a pageToken
   * replayed against a different ID set without complaint, so a fit that moved
   * with the token would skip or repeat studies silently. The list never leaves
   * the request empty — that would widen an ID lookup to the whole registry.
   *
   * When the other parameters leave no room for even one ID beside the reserve,
   * the first ID still goes out alone as long as this page's whole request
   * fits: refusing it would refuse a request upstream answers. The fit is then
   * one ID on every page, and a page whose token runs it past the limit fails.
   *
   * @throws request_too_long when the request carrying only the first ID is
   * still past the limit.
   */
  private fitFilterIds(
    ids: string[],
    params: SearchParams,
  ): { deferred: string[]; sent: string[] } {
    const budget = UPSTREAM_MAX_REQUEST_TARGET_BYTES - PAGING_RESERVE_BYTES;
    const criteria = {
      ...params,
      countTotal: undefined,
      pageSize: undefined,
      pageToken: undefined,
    };
    const first = ids.slice(0, 1);
    let bytes = requestTargetBytes(
      this.buildUrl('/studies', this.buildSearchQuery({ ...criteria, filterIds: first })),
    );
    if (bytes > budget) {
      const requestBytes = requestTargetBytes(
        this.buildUrl('/studies', this.buildSearchQuery({ ...params, filterIds: first })),
      );
      if (requestBytes <= UPSTREAM_MAX_REQUEST_TARGET_BYTES) {
        return { sent: first, deferred: ids.slice(1) };
      }
      throw validationError(
        `${ids.length === 1 ? 'The NCT ID does not fit' : `None of the ${ids.length} NCT IDs fits`} in one ClinicalTrials.gov request beside the other search parameters: with a single ID the request needs ${requestBytes} bytes, and the registry accepts at most ${UPSTREAM_MAX_REQUEST_TARGET_BYTES}.`,
        {
          reason: 'request_too_long',
          requestBytes,
          maxRequestBytes: UPSTREAM_MAX_REQUEST_TARGET_BYTES,
          recovery: {
            hint: 'Shorten query, the other free-text queries, or advancedFilter, or request fewer fields — together they leave no room in the request for an NCT ID.',
          },
        },
      );
    }
    let sent = 1;
    for (const id of ids.slice(1)) {
      bytes += queryEncodedBytes(`|${id}`);
      if (bytes > budget) break;
      sent++;
    }
    return { sent: ids.slice(0, sent), deferred: ids.slice(sent) };
  }

  /** The request URL for a path and its query params; a blank value is left out. */
  private buildUrl(path: string, params: Record<string, string>, jsonFormat = true): URL {
    const url = new URL(`${this.baseUrl}${path}`);
    if (jsonFormat) url.searchParams.set('format', 'json');
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }
    return url;
  }

  /**
   * GET `path` and parse its JSON, retrying transient failures and translating
   * upstream rejections into typed errors. `studyId` marks the single-study
   * route, the only one whose 404 means a study is missing; `maxRetries` and
   * `timeoutMs` override the service's own for a read that must stay short.
   *
   * Each attempt waits its turn in the pacer and stops at `timeoutMs`; the
   * whole request — attempts, backoffs, and waits — stops when the call's
   * budget does, and a call with none left sends nothing. A 429, a 5xx, HTML in
   * place of JSON, and a dropped or timed-out connection are retried, and the
   * last attempt that ran to an outcome decides the error the request ends
   * with: a budget that runs out after a 429 reports the rate limit, any other
   * expiry `retry_deadline_exceeded`. The caller's cancellation outranks both.
   */
  private async fetchJson<T>(
    path: string,
    params: Record<string, string>,
    ctx: Context,
    {
      jsonFormat = true,
      maxRetries = this.maxRetries,
      studyId,
      timeoutMs = this.timeoutMs,
    }: { jsonFormat?: boolean; maxRetries?: number; studyId?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    const url = this.buildUrl(path, params, jsonFormat);
    if (ctx.signal.aborted) throw requestCancelled('Request cancelled by caller', { path });
    const deadlineMs = this.remainingMs(ctx);
    if (deadlineMs === 0) throw deadlineExceeded(path);

    /** The failure of the last attempt that ran to an outcome; one the deadline cut off leaves it. */
    let lastFailure: McpError | undefined;

    /**
     * One request, already holding its pacer slot. `signal` aborts for the
     * caller or the call's budget, which the retry ladder tells apart; the
     * attempt's own timeout is the only abort it reports as its outcome.
     */
    const attempt = async (signal: AbortSignal): Promise<AttemptOutcome<T>> => {
      const attemptTimeout = new AbortController();
      const timer = setTimeout(
        () => attemptTimeout.abort(new DOMException('The operation timed out.', 'TimeoutError')),
        timeoutMs,
      );
      try {
        const res = await fetch(url, {
          signal: AbortSignal.any([signal, attemptTimeout.signal]),
          headers: { Accept: 'application/json' },
        });

        if (res.ok) {
          const ct = res.headers.get('content-type') ?? '';
          if (!ct.includes('json')) {
            const text = await res.text();
            if (text.includes('<html') || text.includes('<!DOCTYPE')) {
              const lastError = 'Error: API returned HTML instead of JSON';
              return { ok: false, failure: exhausted(path, lastError, undefined, maxRetries) };
            }
            return { ok: true, value: JSON.parse(text) as T };
          }
          return { ok: true, value: (await res.json()) as T };
        }

        if (res.status === 404) {
          if (studyId !== undefined) {
            throw notFound(`Study ${studyId} not found`, { reason: 'study_not_found' });
          }
          // Every other endpoint (/stats/field/values, /studies/metadata,
          // /studies/search-areas) — surface the upstream body so callers can
          // extract specific offenders instead of getting a generic "not found"
          // that loses which input was bad, or blames a study no one named.
          const text = (await res.text()).trim();
          throw notFound(text || `Not found: ${path}`);
        }
        if (res.status === 400) {
          const text = await res.text();
          // Upstream enum errors reference internal API param names (e.g. `overallStatus`)
          // rather than the tool's input param names (e.g. `statusFilter`). Translate so
          // error messages name the param the caller actually used.
          if (text.includes('Invalid value in parameter')) {
            // Maps upstream filter.* param name → { toolParam, pieceName for clinicaltrials_get_field_values }
            // Note: `phase` is intentionally absent — phaseFilter routes through filter.advanced
            // (AREA[Phase]value) so the API never emits "Invalid value in parameter `phase`".
            // A Map, since the name comes from the body and `constructor` would
            // otherwise read an object literal's prototype.
            const upstreamParamInfo = new Map([
              ['overallStatus', { toolParam: 'statusFilter', pieceName: 'OverallStatus' }],
            ]);
            const match = text.match(/Invalid value in parameter\s+`([^`]+)`:\s*`([^`]+)`/i);
            const upstreamParam = match?.[1];
            const badValue = match?.[2];
            const info = upstreamParam ? upstreamParamInfo.get(upstreamParam) : undefined;
            const paramRef = info ? `\`${info.toolParam}\`` : 'the filter parameter';
            const pieceName = info?.pieceName ?? 'OverallStatus';
            const valueRef = badValue ? ` '${badValue}' is not a valid value.` : '';
            // The argument the caller sends next, a code span in content[] rather than `fields=\["…"\]`.
            const valuesCall = `fields=["${pieceName}"]`;
            throw validationError(
              `Invalid value for ${paramRef}.${valueRef} Call clinicaltrials_get_field_values with ${valuesCall} to discover valid enum values.`,
              {
                reason: 'enum_invalid',
                recovery: {
                  hint: `Call clinicaltrials_get_field_values with ${valuesCall} to see valid values.`,
                },
                ...(info ? { param: info.toolParam } : {}),
                ...(badValue ? { value: badValue } : {}),
              },
              { literals: [valuesCall] },
            );
          }
          if (text.includes('contains invalid field name')) {
            const match = text.match(/invalid field name: ['"]([^'"]+)['"]/);
            const offender = match
              ? ` '${match[1]}' is likely a module name — use one of its piece names instead (e.g., DesignPrimaryPurpose, DesignInterventionModel, LeadSponsorName).`
              : ' Use PascalCase piece names (e.g., DesignPrimaryPurpose, DesignInterventionModel, LeadSponsorName), not module names.';
            throw validationError(
              `${text.trim()}${offender} Call clinicaltrials_get_field_definitions to browse valid piece names.`,
              { reason: 'field_invalid' },
            );
          }
          // A rejected cursor arrives as one of two bodies: `Incorrect pageToken
          // format` for a token the registry never issued (invented, truncated,
          // edited), and `The data have probably changed while you were
          // paginating…` for one issued before a data refresh — and for a fresh
          // token with a character altered, so that message names both causes.
          // Gated on a sent token so the reason never attaches to a request
          // that had none.
          if (params.pageToken) {
            if (/incorrect pageToken format/i.test(text)) {
              throw validationError(
                'ClinicalTrials.gov rejected pageToken as malformed: it is not a token the registry issued (an invented, truncated, or edited value fails this way).',
                { reason: 'page_token_invalid' },
              );
            }
            if (text.includes('changed while you were paginating')) {
              throw validationError(
                'ClinicalTrials.gov cannot resume pagination from this pageToken: it was issued before a data refresh, or it was altered after it was issued.',
                { reason: 'page_token_invalid' },
              );
            }
          }
          if (text.includes('incorrect format')) {
            if (studyId !== undefined) {
              throw notFound(
                `Study ${studyId} not found. Verify the NCT ID exists on ClinicalTrials.gov.`,
                { reason: 'study_not_found' },
              );
            }
            // Upstream names the offending parameter in backticks — `Parameter
            // \`filter.geo\` has incorrect format`, `Item 1 in parameter \`sort\`
            // has incorrect format`. Read the name from the body instead of
            // inferring it from which params were sent: a request carrying both a
            // sort and a geoFilter is answered naming only the malformed one, so
            // presence alone blames whichever check runs first. Falls back to
            // presence when the body names nothing.
            const namedParam = text.match(/parameter\s+`([^`]+)`/i)?.[1];
            const blamed = (param: 'filter.geo' | 'sort' | 'filter.ids') =>
              namedParam === undefined ? params[param] !== undefined : namedParam === param;

            // geoFilter is a hand-built string with a non-obvious shape, so it is
            // the parameter a model most often gets wrong — name the shape rather
            // than echoing the upstream body.
            const geo = params['filter.geo'];
            if (geo && blamed('filter.geo')) {
              throw validationError(geoFilterShapeMessage(geo), { reason: 'geo_invalid' });
            }
            if (params.sort && blamed('sort')) {
              throw validationError(`Invalid value for \`sort\`: '${params.sort}'. ${SORT_SHAPE}`, {
                reason: 'sort_invalid',
                value: params.sort,
              });
            }
            // filter.ids rejection — the API may reject IDs that match the
            // regex but don't exist (e.g. NCT00000000). Surface the actual
            // IDs so the caller knows which ones failed.
            const ids = params['filter.ids'];
            if (ids && blamed('filter.ids')) {
              const idList = ids.split('|').join(', ');
              throw notFound(
                `Study ID(s) not found or rejected by API: ${idList}. Verify the NCT IDs exist on ClinicalTrials.gov.`,
                { reason: 'ids_not_found' },
              );
            }
            throw validationError(`Invalid request format. API response: ${text}`);
          }
          // The other three sort rejections. The backtick extraction above runs
          // only inside the `incorrect format` branch, so a body that never
          // reaches it is recognized by its own phrase instead — including the
          // 2-item cap, which does name `sort` in backticks but through a phrase
          // that branch never sees. Gated on a sort having been sent:
          // ClinicalTrials.gov emits these strings for no other parameter.
          if (
            params.sort &&
            (text.includes('Unknown sort field') ||
              text.includes('Unsupported sort field type') ||
              /parameter\s+`sort`\s+must contain no more than/i.test(text))
          ) {
            throw validationError(await this.describeSortRejection(params.sort, text, ctx), {
              reason: 'sort_invalid',
              value: params.sort,
            });
          }
          // Essie parser errors share the `Error parsing query in <where>: …` prefix,
          // where <where> names the parameter (`advanced filter`, `Conditions or
          // disease`, `Other terms`) and is the only part that varies with it.
          // Several shapes show up:
          //   1. A refusal of the field an AREA[] or RANGE[] term names, read by
          //      parseAreaRejection: `Unknown area name: \`X\``; `This type of
          //      query is not allowed for X` (a STRUCT piece); `\`X\` is outside
          //      Location scope` (a study-level field inside SEARCH[Location](…));
          //      `RANGE is not supported for <type> field <path>` and `… for
          //      multiple (N) fields`. Each is a field mistake, not a syntax error.
          //   2. `Allowed values for enum field \`<path>\` are \`V1\`, \`V2\`, …` — invalid enum
          //      value in a caller's AREA[] expression (advancedFilter or a query parameter;
          //      phaseFilter entries are validated in the tool handlers before any request)
          //   3. ANTLR syntax errors from a stray bracket, unbalanced parens, or an
          //      unterminated quote in a free-text field — several distinct shapes,
          //      each read by describeQueryParseError (the catch-all below), which
          //      keeps any other upstream sentence (`Search scope must be …`).
          // Only the search route parses a query. Read elsewhere, the shape would
          // send a second-tier read's own failure back into the suggestion path
          // that awaits it.
          if (path === '/studies' && text.startsWith('Error parsing query in')) {
            const rejected = parseAreaRejection(text);
            if (rejected) throw await this.describeRejectedTerm(rejected, text, ctx);
            const enumMatch = text.match(/Allowed values for enum field\s+`([^`]+)`\s+are\s+(.+)/i);
            if (enumMatch) {
              const fieldPath = enumMatch[1] ?? '';
              const rawValues = enumMatch[2] ?? '';
              // Extract backtick-quoted values: `NA`, `EARLY_PHASE1`, …
              const validValues = [...rawValues.matchAll(/`([^`]+)`/g)].flatMap((m) => m[1] ?? []);
              const piece = (await this.entryAtPath(fieldPath, ctx))?.piece;
              const area = piece && `AREA[${piece}]`;
              const valuesStr = validValues.length > 0 ? validValues.join(', ') : rawValues.trim();
              throw validationError(
                area
                  ? `Invalid value in an ${area} expression. Valid values: ${valuesStr}.`
                  : `Invalid value in an AREA[] expression for enum field \`${fieldPath}\`. Valid values: ${valuesStr}.`,
                {
                  reason: 'enum_invalid',
                  recovery: {
                    hint: area
                      ? `Use one of the valid values inside ${area}: ${valuesStr}.`
                      : `Use one of the valid values: ${valuesStr}.`,
                  },
                  validValues,
                },
                // The values to send back, and the expression they go in.
                { literals: area ? [area, ...validValues] : validValues },
              );
            }
            // ANTLR catch-all — see describeQueryParseError for why each shape
            // needs its own reading of the quoted token.
            throw validationError(
              describeQueryParseError(text),
              { reason: 'query_parse_error' },
              { literals: PARSE_ERROR_LITERALS },
            );
          }
          throw validationError(text || `Bad request: ${path}`);
        }

        // A request target past the upstream limit. Final, not retried — the
        // same URL fails the same way — and the nginx error page that comes
        // with it says nothing a caller can act on, so only the sizes go back.
        if (res.status === 414) {
          const requestBytes = requestTargetBytes(url);
          throw validationError(
            `ClinicalTrials.gov rejected the request as too long (HTTP 414): its URL path and query string come to ${requestBytes} bytes, and the registry accepts at most ${UPSTREAM_MAX_REQUEST_TARGET_BYTES}.`,
            {
              reason: 'request_too_long',
              requestBytes,
              maxRequestBytes: UPSTREAM_MAX_REQUEST_TARGET_BYTES,
            },
          );
        }

        if (RETRYABLE_STATUS.has(res.status)) {
          const lastError = `Error: HTTP ${res.status}`;
          return { ok: false, failure: exhausted(path, lastError, res.status, maxRetries) };
        }

        throw await httpErrorFromResponse(res, { service: 'ClinicalTrials.gov' });
      } catch (err) {
        // An abort on `signal` is the caller's or the budget's, for the ladder
        // to classify; any other failure a retry cannot clear is final.
        if (err instanceof McpError || signal.aborted || !isTransientFetchError(err)) throw err;
        return { ok: false, failure: exhausted(path, String(err), undefined, maxRetries) };
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      return await withRetry(
        async ({ signal }) => {
          const outcome = await this.pacer.run(attempt, { signal });
          if (outcome.ok) return outcome.value;
          lastFailure = outcome.failure;
          throw outcome.failure;
        },
        {
          maxRetries,
          baseDelayMs: this.baseBackoffMs,
          maxDelayMs: this.maxBackoffMs,
          deadlineMs,
          signal: ctx.signal,
          context: ctx,
          operation: `ClinicalTrials.gov ${path}`,
          isTransient: (err) => err === lastFailure,
        },
      );
    } catch (err) {
      if (ctx.signal.aborted) {
        throw requestCancelled('Request cancelled by caller', { path }, { cause: err });
      }
      if (isRetryDeadline(err)) {
        // An answer that arrived as the budget ran out is still the answer.
        if (err.cause instanceof McpError && err.cause !== lastFailure) throw err.cause;
        if (lastFailure?.data?.reason === 'rate_limited') {
          throw rateLimited(
            `Rate limited by ClinicalTrials.gov until this call's ${CALL_BUDGET_MS} ms time budget ran out`,
            lastFailure.data,
            { cause: err },
          );
        }
        throw deadlineExceeded(path, err);
      }
      // Retries spent: the last failure as this server words it, not the retry
      // helper's rewrap of it with an attempt count.
      if (lastFailure !== undefined && err instanceof Error && err.cause === lastFailure) {
        throw lastFailure;
      }
      throw err;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Init / Accessor                                                    */
/* ------------------------------------------------------------------ */

let _service: ClinicalTrialsService | undefined;

/** Initialize the ClinicalTrials service. Call from createApp setup(). */
export function initClinicalTrialsService(): void {
  _service = new ClinicalTrialsService(getServerConfig());
}

/** Get the initialized ClinicalTrials service instance. */
export function getClinicalTrialsService(): ClinicalTrialsService {
  if (!_service)
    throw internalError(
      'ClinicalTrialsService not initialized — call initClinicalTrialsService() in setup()',
    );
  return _service;
}
