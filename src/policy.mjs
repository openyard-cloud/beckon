import { join, relative, resolve } from 'node:path';

// Actions that always wait for a button press in Slack, even when the permission mode or the
// repository's allow rules would let them run. Each rule matches the tool name and, for Bash,
// the command text. A command chained with && or ; is checked as a whole, so a risky part
// anywhere in it is enough.

const ARGS = String.raw`[^;&|\n]*`;

// A program in command position: at the start, after ; && || | ( or $(, or after a runner such
// as npx or bundle exec, with optional VAR=value assignments in front. Mentions inside paths,
// grep patterns or commit messages do not count.
const AT = String.raw`(?:^|[;&|(\n]\s*|\$\(\s*|\b(?:npx|bunx|pnpm\s+(?:dlx|exec)|yarn|bundle\s+exec|sudo|time|env)\s+(?:-\S+\s+)*)(?:\w+=\S*\s+)*`;
const cmd = (name) => `${AT}(?:${name})(?:@\\S+)?\\b`;

export const DEFAULT_RULES = [
  {
    label: 'push to a main branch, force push or branch delete',
    tool: '^Bash$',
    match: String.raw`${cmd('git')}(?:\s+-[Cc]\s+\S+)*\s+push\b${ARGS}(\s(main|master|production|prod|release)\b|:(main|master|production|prod)\b|\s--force\b|\s--force-with-lease\b|\s-f\b|\s--delete\b|\s-d\b|\s--mirror\b|\s\+\S)`,
  },
  {
    label: 'merge, release or change repository settings on GitHub',
    tool: '^Bash$',
    match: String.raw`${cmd('gh')}\s+(pr\s+merge|release\s+(create|delete|upload|edit)|repo\s+(delete|archive|rename|edit)|secret\s+(set|delete)|variable\s+(set|delete)|workflow\s+(run|enable|disable)|api\b${ARGS}(-X|--method)\s*(POST|PUT|PATCH|DELETE))`,
  },
  {
    label: 'deploy or change production',
    tool: '^Bash$',
    match: [
      String.raw`${cmd('vercel')}${ARGS}(--prod\b|\bpromote\b|\brollback\b|\bdomains?\s+(add|rm|remove)\b|\benv\s+(add|rm|remove)\b|\bremove\b)`,
      String.raw`${cmd('wrangler')}${ARGS}\b(deploy|publish|rollback|delete|secret\s+(put|delete|bulk)|versions\s+deploy|d1\s+execute\b${ARGS}--remote|d1\s+migrations\s+apply\b${ARGS}--remote|kv\s+\S+\s+(put|delete)|r2\s+object\s+(put|delete))\b`,
      String.raw`${cmd('koyeb')}${ARGS}\b(services?|apps?|deployments?|secrets?|domains?)\s+(update|redeploy|create|delete|pause|resume|cancel)\b`,
      String.raw`${cmd('supabase')}${ARGS}\b(db\s+(push|reset)|migration\s+(up|repair|squash)|functions\s+(deploy|delete)|secrets\s+(set|unset)|projects\s+delete|branches\s+delete)\b`,
      String.raw`${cmd('fly|flyctl')}\s+(deploy|secrets|scale|destroy|apps\s+destroy|machine\s+(destroy|stop))\b`,
      String.raw`${cmd('railway')}\s+(up|redeploy|down|delete)\b`,
      String.raw`${cmd('netlify')}${ARGS}\bdeploy\b${ARGS}--prod\b`,
      String.raw`${cmd('firebase')}${ARGS}\bdeploy\b`,
      String.raw`${cmd('eas')}\s+(submit|update)\b`,
      String.raw`${cmd('heroku')}${ARGS}\b(releases:rollback|ps:scale|apps:destroy|config:(set|unset))\b`,
      String.raw`${cmd('git')}\s+push\s+heroku\b`,
    ].join('|'),
  },
  {
    label: 'release an app or push a patch to users',
    tool: '^Bash$',
    match: [
      String.raw`${cmd('shorebird')}(?:\s+-\S+)*\s+(release|patch|patches\s+(promote|set-track))\b`,
      String.raw`${cmd('fastlane')}(?!\s+(--version|-v|lanes|list|env|actions?|search_plugins)\b)\s+\S`,
      String.raw`${cmd('xcrun')}\s+altool\b${ARGS}--upload`,
      String.raw`${cmd('firebase')}${ARGS}\bappdistribution:distribute\b`,
      String.raw`${cmd('eas')}\s+build\b${ARGS}--auto-submit\b`,
    ].join('|'),
  },
  {
    label: 'publish a package or image',
    tool: '^Bash$',
    match: String.raw`${cmd('npm|pnpm|yarn|bun')}\s+(publish|unpublish|deprecate|dist-tag\s+(add|rm))\b|${cmd('cargo')}\s+publish\b|${cmd('twine')}\s+upload\b|${cmd('docker|podman')}\s+push\b|${cmd('gem')}\s+push\b`,
  },
  {
    label: 'change cloud infrastructure',
    tool: '^Bash$',
    match: String.raw`${cmd('terraform|tofu')}\s+(apply|destroy|import|state\s+(rm|mv))\b|${cmd('kubectl')}${ARGS}\b(apply|delete|replace|scale|rollout|patch|edit|drain|cordon|create)\b|${cmd('helm')}\s+(install|upgrade|uninstall|rollback)\b|${cmd('aws')}\s+\S+\s+(delete|terminate|put|update|create|rm|sync)\S*|${cmd('gcloud')}${ARGS}\b(deploy|delete|update|create)\b|${cmd('az')}${ARGS}\b(delete|create|update|deploy)\b`,
  },
  {
    label: 'connect to a database directly',
    tool: '^Bash$',
    match: String.raw`(^|[\s;&|(])(psql|mysql|mariadb|mongosh?|redis-cli|sqlcmd|clickhouse-client)\b`,
  },
  {
    label: 'run as root or delete outside the worktree',
    tool: '^Bash$',
    match: String.raw`(?:^|[;&|(\n]\s*)sudo\b|${cmd('rm')}${ARGS}(\s-[a-zA-Z]*[rR][a-zA-Z]*|\s--recursive)\b${ARGS}\s("|')?(\/|~|\$HOME|\.\.)`,
  },
  {
    label: 'a connector action that changes something',
    // Reads never get here (see connectorReads): get_deployment is not a deploy, list_shared_drives
    // is not a share, and a SELECT through execute_sql changes nothing.
    tool: String.raw`^mcp__.*(apply_migration|execute_sql|deploy|delete|drop|remove|merge|publish|create_project|pause|restore|reset|rollback|promote|update_project|create_branch|send_message|post_message|send_email|reply|forward|trash|share|invite|schedule_message|transfer|purchase|buy|pay)`,
    match: null,
  },
  {
    // Screen control through Peekaboo (openyard-cloud/Peekaboo): its guard refuses clicks on
    // consequential buttons (Submit, Upload, Distribute, Release, Delete, ...) until they are
    // repeated with confirm set to the button's label. That repeat is what asks here.
    label: 'click a consequential button on screen',
    tool: String.raw`^mcp__.*peekaboo.*__(click|action)$`,
    match: String.raw`"confirm"\s*:`,
  },
  {
    // Peekaboo's own agent clicks step by step inside one call, out of beckon's sight.
    label: "Peekaboo's own agent (it acts without per-step approval)",
    tool: String.raw`^mcp__.*peekaboo.*__agent$`,
    match: null,
  },
  {
    // Browser actions that can submit or confirm something. The guard does not see inside web
    // pages, so these ask every time; reading, navigating and filling fields do not.
    label: 'a browser action that can submit',
    tool: String.raw`^mcp__.*peekaboo.*__browser$`,
    match: String.raw`"action"\s*:\s*"(click|dom_click|press_key|upload_file|handle_dialog|call)"`,
  },
];

// A connector tool that only reads, by the verb its name starts with. Names that also create or
// run something (get_or_create_drive) do not count.
export function readTool(tool) {
  const action = String(tool).split('__').pop().toLowerCase();
  return /^(get|list|search|read|query|fetch|find|view|describe|count|aggregate)(_|$)/.test(action)
    && !/(^|_)(or|and|create|set|run|execute|write|upload|put|post|send|apply|update|delete|remove)(_|$)/.test(action);
}

// Inside a statement that starts with SELECT or WITH, these are what can still write or lock:
// data-changing CTEs, SELECT … INTO (a new table), EXPLAIN ANALYZE (it runs the query) and
// row locks. Every other writing statement is caught by what it starts with.
const SQL_WRITE = /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|into|analy[sz]e)\b|\bfor\s+(no\s+key\s+update|key\s+share|update|share)\b/i;
// Words that may stand before "(" without being a function call.
const SQL_PAREN_WORDS = new Set('as in exists any all some over filter within values using on and or not when then else select from join where with by case is row array between like ilike lateral distinct cast extract materialized numeric decimal varchar char character timestamp timestamptz time interval bit varbit float'.split(' '));
// Functions that only compute or read: any other call asks, since a user-defined function can write.
const SQL_READ_FUNCS = new Set(`count sum avg min max coalesce nullif greatest least lower upper initcap length char_length
  octet_length trim btrim ltrim rtrim substring substr left right replace split_part position strpos concat concat_ws format
  regexp_replace regexp_match regexp_matches regexp_split_to_array string_to_array array_to_string array_position array_remove
  array_append array_length array_agg string_agg unnest generate_series cardinality md5 encode decode to_char to_date
  to_timestamp to_number date_trunc date_part date_bin age now make_interval timezone round floor ceil ceiling abs mod power
  sqrt trunc sign json_agg jsonb_agg json_object_agg jsonb_object_agg json_build_object jsonb_build_object json_build_array
  jsonb_build_array to_json to_jsonb row_to_json json_array_length jsonb_array_length json_array_elements jsonb_array_elements
  jsonb_array_elements_text json_each jsonb_each jsonb_each_text jsonb_object_keys jsonb_typeof jsonb_pretty jsonb_path_query
  row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value percentile_cont
  percentile_disc mode bool_and bool_or every stddev stddev_pop stddev_samp variance corr pg_size_pretty pg_total_relation_size
  pg_relation_size pg_table_size pg_indexes_size pg_database_size pg_typeof format_type obj_description col_description
  current_setting has_table_privilege has_schema_privilege`.split(/\s+/));

/** True only for SQL that can do nothing but read: SELECT/WITH/SHOW/EXPLAIN/VALUES/TABLE statements,
 *  no data-changing clause, and no call to a function outside a known read-only list. */
export function readOnlySql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return false;
  const s = sql
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "''") // dollar-quoted text
    .replace(/'(?:[^']|'')*'/g, "''") // string literals
    .replace(/"(?:[^"]|"")*"/g, 'q') // quoted identifiers
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (/['"$]|\/\*/.test(s.replace(/''/g, ''))) return false; // unbalanced quoting: do not guess
  if (SQL_WRITE.test(s)) return false;
  const stmts = s.split(';').map((x) => x.trim()).filter(Boolean);
  if (!stmts.length || !stmts.every((x) => /^\(*\s*(select|with|show|explain|values|table)\b/i.test(x))) return false;
  for (const [, name] of s.matchAll(/([\w.]+)\s*\(/g)) {
    const n = name.toLowerCase();
    if (n.includes('.') || !(SQL_PAREN_WORDS.has(n) || SQL_READ_FUNCS.has(n))) return false;
  }
  return true;
}

/** A connector call that only reads: a get_/list_/search_… tool, or execute_sql with SQL that only reads. */
export function connectorReads(toolName, input) {
  return /^mcp__/i.test(toolName) && (readTool(toolName) || (/execute_sql$/i.test(toolName) && readOnlySql(input?.query)));
}

function compile(rules) {
  return rules.map((r) => ({
    reads: !!r.reads,
    label: r.label,
    tool: new RegExp(r.tool, 'i'),
    match: r.match ? new RegExp(r.match, 'i') : null,
  }));
}

const COMPILED_DEFAULTS = compile(DEFAULT_RULES);

export function inputText(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  if (toolName === 'Bash' || typeof input.command === 'string') return String(input.command ?? '');
  return JSON.stringify(input);
}

export function matchRule(toolName, input, extraRules = []) {
  const text = inputText(toolName, input);
  // Reading through a connector never asks, also under a project rule such as "every Supabase
  // tool", unless that rule sets "reads": true (for data that must not even be read unasked).
  const reads = connectorReads(toolName, input);
  for (const rule of [...COMPILED_DEFAULTS, ...compile(extraRules)]) {
    if (!rule.tool.test(toolName)) continue;
    if (rule.match && !rule.match.test(text)) continue;
    if (reads && !rule.reads) continue;
    return { label: rule.label };
  }
  return null;
}

// ---- project scope ----

const FILE_FIELDS = ['file_path', 'path', 'notebook_path'];
// An absolute or home path written out in a command: not part of a URL, a relative path or a word.
const PATH_IN_TEXT = /(?<![\w:/.~$}-])(?:~|\$\{?HOME\}?)?\/[^\s'"`;|&<>(){}]*/g;

const inside = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

/** Absolute paths a tool call names: the path fields of file tools, and paths written out in a
 *  Bash command (~ and $HOME expanded, globs cut off). A relative path that climbs out (cd ../..)
 *  is not seen, so this is a guard against wandering off, not a sandbox. */
export function namedPaths(toolName, input, home) {
  if (!input || typeof input !== 'object') return [];
  const expand = (p) => resolve(p.replace(/^(?:~|\$\{?HOME\}?)(?=\/|$)/, home).split(/[*?[]/)[0] || '/');
  if (toolName === 'Bash') {
    return [...String(input.command ?? '').matchAll(PATH_IN_TEXT)].map(([m]) => expand(m));
  }
  return FILE_FIELDS.map((f) => input[f])
    .filter((v) => typeof v === 'string' && /^(?:~|\$\{?HOME\}?)?\//.test(v))
    .map(expand);
}

/** The first folder outside the project that a tool call reaches into: a path inside one of the
 *  guarded folders (the folder that holds the project and its neighbours, beckon's own data) but
 *  in none of the allowed ones (the project, the thread's worktree, folders already allowed). It
 *  returns the folder one level under the guarded one, so one answer covers that whole neighbour. */
export function outsideArea(toolName, input, { home, guarded, allowed }) {
  for (const p of namedPaths(toolName, input, home)) {
    if (allowed.some((a) => inside(p, a))) continue;
    const root = guarded.find((g) => inside(p, g));
    if (!root) continue;
    return p === root ? root : join(root, relative(root, p).split('/')[0]);
  }
  return null;
}
