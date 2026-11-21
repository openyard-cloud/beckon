// Actions that always wait for a button press in Slack, even when the permission mode or the
// repository's allow rules would let them run. Each rule matches the tool name and, for Bash,
// the command text. A command chained with && or ; is checked as a whole, so a risky part
// anywhere in it is enough.

const ARGS = String.raw`[^;&|\n]*`;

export const DEFAULT_RULES = [
  {
    label: 'push to a main branch, force push or branch delete',
    tool: '^Bash$',
    match: String.raw`\bgit\b${ARGS}\bpush\b${ARGS}(\s(main|master|production|prod|release)\b|:(main|master|production|prod)\b|\s--force\b|\s--force-with-lease\b|\s-f\b|\s--delete\b|\s-d\b|\s--mirror\b|\s\+\S)`,
  },
  {
    label: 'merge, release or change repository settings on GitHub',
    tool: '^Bash$',
    match: String.raw`\bgh\s+(pr\s+merge|release\s+(create|delete|upload|edit)|repo\s+(delete|archive|rename|edit)|secret\s+(set|delete)|variable\s+(set|delete)|workflow\s+(run|enable|disable)|api\b${ARGS}(-X|--method)\s*(POST|PUT|PATCH|DELETE))`,
  },
  {
    label: 'deploy or change production',
    tool: '^Bash$',
    match: [
      String.raw`\bvercel\b${ARGS}(--prod\b|\bpromote\b|\brollback\b|\bdomains?\s+(add|rm|remove)\b|\benv\s+(add|rm|remove)\b|\bremove\b)`,
      String.raw`\bwrangler\b${ARGS}\b(deploy|publish|rollback|delete|secret\s+(put|delete|bulk)|versions\s+deploy|d1\s+execute\b${ARGS}--remote|d1\s+migrations\s+apply\b${ARGS}--remote|kv\s+\S+\s+(put|delete)|r2\s+object\s+(put|delete))\b`,
      String.raw`\bkoyeb\b${ARGS}\b(services?|apps?|deployments?|secrets?|domains?)\s+(update|redeploy|create|delete|pause|resume|cancel)\b`,
      String.raw`\bsupabase\b${ARGS}\b(db\s+(push|reset)|migration\s+(up|repair|squash)|functions\s+(deploy|delete)|secrets\s+(set|unset)|projects\s+delete|branches\s+delete)\b`,
      String.raw`\bfly(ctl)?\s+(deploy|secrets|scale|destroy|apps\s+destroy|machine\s+(destroy|stop))\b`,
      String.raw`\brailway\s+(up|redeploy|down|delete)\b`,
      String.raw`\bnetlify\b${ARGS}\bdeploy\b${ARGS}--prod\b`,
      String.raw`\bfirebase\b${ARGS}\bdeploy\b`,
      String.raw`\beas\s+(submit|update)\b`,
      String.raw`\bheroku\b${ARGS}\b(releases:rollback|ps:scale|apps:destroy|config:(set|unset))\b`,
      String.raw`\bgit\s+push\s+heroku\b`,
    ].join('|'),
  },
  {
    label: 'publish a package or image',
    tool: '^Bash$',
    match: String.raw`\b(npm|pnpm|yarn|bun)\s+(publish|unpublish|deprecate|dist-tag\s+(add|rm))\b|\bcargo\s+publish\b|\btwine\s+upload\b|\b(docker|podman)\s+push\b|\bgem\s+push\b`,
  },
  {
    label: 'change cloud infrastructure',
    tool: '^Bash$',
    match: String.raw`\b(terraform|tofu)\s+(apply|destroy|import|state\s+(rm|mv))\b|\bkubectl\b${ARGS}\b(apply|delete|replace|scale|rollout|patch|edit|drain|cordon|create)\b|\bhelm\s+(install|upgrade|uninstall|rollback)\b|\baws\s+\S+\s+(delete|terminate|put|update|create|rm|sync)\S*|\bgcloud\b${ARGS}\b(deploy|delete|update|create)\b|\baz\b${ARGS}\b(delete|create|update|deploy)\b`,
  },
  {
    label: 'connect to a database directly',
    tool: '^Bash$',
    match: String.raw`(^|[\s;&|(])(psql|mysql|mariadb|mongosh?|redis-cli|sqlcmd|clickhouse-client)\b`,
  },
  {
    label: 'run as root or delete outside the worktree',
    tool: '^Bash$',
    match: String.raw`\bsudo\b|\brm\b${ARGS}(\s-[a-zA-Z]*[rR][a-zA-Z]*|\s--recursive)\b${ARGS}\s("|')?(\/|~|\$HOME|\.\.)`,
  },
  {
    label: 'a connector action that changes something',
    tool: String.raw`^mcp__.*(apply_migration|execute_sql|deploy|delete|drop|remove|merge|publish|create_project|pause|restore|reset|rollback|promote|update_project|create_branch|send_message|post_message|send_email|transfer|purchase|buy|pay)`,
    match: null,
  },
];

function compile(rules) {
  return rules.map((r) => ({
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
  for (const rule of [...COMPILED_DEFAULTS, ...compile(extraRules)]) {
    if (!rule.tool.test(toolName)) continue;
    if (rule.match && !rule.match.test(text)) continue;
    return { label: rule.label };
  }
  return null;
}
