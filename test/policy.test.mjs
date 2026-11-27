import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRule, outsideArea, RULE_IDS } from '../src/policy.mjs';

test('paths outside the project are found in commands and file tools', () => {
  const scope = {
    home: '/Users/t',
    guarded: ['/Users/t/Projects', '/Users/t/.beckon'],
    allowed: ['/Users/t/Projects/pickcourt', '/Users/t/.beckon/worktrees/pickcourt/1-2', '/Users/t/Projects/beckon/bin/beckon-secret.mjs'],
  };
  const bash = (command) => outsideArea('Bash', { command }, scope);
  assert.equal(bash('ls /Users/t/Projects/beckon 2>/dev/null | head'), '/Users/t/Projects/beckon');
  assert.equal(bash('sed -n 1,5p ~/Projects/beckon/README.md'), '/Users/t/Projects/beckon');
  assert.equal(bash('cat $HOME/.beckon/env'), '/Users/t/.beckon/env');
  assert.equal(bash('ls ~/Projects'), '/Users/t/Projects');
  assert.equal(bash('grep -rn foo src/a /Users/t/Projects/pickcourt-old/x'), '/Users/t/Projects/pickcourt-old');
  assert.equal(bash('cd /Users/t/.beckon/worktrees/pickcourt/1-2 && grep -rn x apps/'), null);
  assert.equal(bash('node "/Users/t/Projects/beckon/bin/beckon-secret.mjs" --label a'), null, 'the secret helper is allowed');
  assert.equal(bash('ls ~/.claude/projects/-Users-t-Projects-pickcourt/memory'), null);
  assert.equal(bash('curl https://x.com/Users/t/Projects/beckon; sed s/a/b/g f'), null, 'URLs and sed scripts are not paths');
  assert.equal(outsideArea('Read', { file_path: '/Users/t/Projects/vetcode/a b.md' }, scope), '/Users/t/Projects/vetcode');
  assert.equal(outsideArea('Grep', { pattern: 'x', path: '/Users/t/Projects/pickcourt/apps' }, scope), null);
  assert.equal(outsideArea('Glob', { pattern: '**/*.ts', path: '~/.beckon/worktrees/hush/9' }, scope), '/Users/t/.beckon/worktrees');
});

const bash = (command, extra, autoAllow) => matchRule('Bash', { command }, extra, autoAllow);

test('asks before pushes to main, force pushes and branch deletes', () => {
  for (const c of [
    'git push origin main',
    'git push -u origin master',
    'git push origin HEAD:main',
    'git push --force origin feature/x',
    'git push -f',
    'git push origin --delete old-branch',
    'cd app && git push origin main',
  ]) assert.ok(bash(c), c);
  for (const c of ['git push -u origin feature/main-menu', 'git push origin fix/login', 'git push', 'git status']) {
    assert.equal(bash(c), null, c);
  }
});

test('asks before deploys and production changes', () => {
  for (const c of [
    'vercel --prod',
    'npx vercel deploy --prod --yes --cwd apps/web',
    'npx wrangler@4 deploy',
    'wrangler secret put API_KEY',
    'wrangler d1 execute db --remote --command "DELETE FROM users"',
    'koyeb service update app/api --git-sha abc',
    'supabase db push',
    'flyctl deploy',
    'firebase deploy --only hosting',
    'eas submit -p ios',
  ]) assert.ok(bash(c), c);
  for (const c of ['vercel build', 'wrangler dev', 'wrangler d1 execute db --local --command "select 1"', 'supabase start', 'koyeb service list', 'pnpm build']) {
    assert.equal(bash(c), null, c);
  }
});

test('a project can let some default rules run without asking, by id', () => {
  assert.equal(bash('gh pr merge 103 --merge')?.label, 'merge a pull request');
  assert.equal(bash('gh pr merge 103 --merge', [], ['merge']), null, 'merges run on their own');
  assert.equal(bash('gh release create v1.0.0', [], ['merge'])?.label, 'release or change repository settings on GitHub', 'other GitHub changes still ask');
  assert.equal(bash('gh pr merge 1 && git push origin main', [], ['merge'])?.label, 'push to a main branch, force push or branch delete');
  assert.ok(RULE_IDS.includes('merge') && RULE_IDS.includes('deploy'));
});

test('asks before merges, releases, publishing and direct database access', () => {
  for (const c of ['gh pr merge 12 --squash', 'gh release create v1.0.0', 'gh api repos/o/r/issues -X POST -f title=x', 'npm publish', 'pnpm publish --access public', 'docker push me/app', 'psql "$DATABASE_URL" -c "select 1"', 'sudo rm x', 'rm -rf ~/Projects', 'rm -rf /tmp', 'rm -rf /tmp/../Users/me', 'rm -rf /tmp/x ~/Projects', 'rm -rf "/Users/me"', 'rm -r ../other']) {
    assert.ok(bash(c), c);
  }
  for (const c of ['gh pr create --fill', 'gh pr view 3', 'gh api repos/o/r/pulls', 'npm test', 'rm -rf node_modules dist', 'rm file.txt', 'rm -rf /tmp/x /private/tmp/y', 'rm -rf "/var/folders/5y/T/tmp.X"']) {
    assert.equal(bash(c), null, c);
  }
});

test('text a command only carries is not taken for a command', () => {
  // Written into files, a sed script or a PR body: data.
  for (const c of [
    "cat > /tmp/pr.md <<'EOF'\n## Deploy\nnpx wrangler secret put KEY\nwrangler deploy\nEOF\ngh pr create --body-file /tmp/pr.md",
    `sed -i '' 's#"cf:deploy": "a"#"cf:deploy": "next build && wrangler deploy"#' package.json`,
    'gh pr create --title x --body "Run: git push origin main; vercel --prod"',
    "cat > /tmp/g.sh <<'EOF'\nrm -rf /Users/me/x\nEOF",
    'ls # then wrangler deploy',
    "python3 - <<'EOF'\np='notes.md'\ns=open(p).read()+\"\\nSet it with `... | npx wrangler secret put KEY` (no deploy needed).\\n\"\nopen(p,'w').write(s)\nEOF",
    "python3 - <<'EOF'\nsub('README.md', \"\"\"Deploy: Vercel.\"\"\", \"\"\"Deploy: `pnpm cf:deploy && wrangler deploy`.\"\"\")\nEOF",
  ]) assert.equal(bash(c), null, c);
  // Run as code, or quoted arguments of a real command: still asks.
  for (const c of [
    "python3 - <<'EOF'\nimport os\nos.system('x')\nEOF\nwrangler deploy",
    "bash <<'EOF'\nwrangler deploy\nEOF",
    "sh -c 'cd app && wrangler deploy'",
    `node -e 'require("child_process").execSync("x")' && vercel --prod`,
    'echo "$(wrangler deploy)"',
    'npx vercel "--prod"',
    "ssh box 'fly deploy'",
  ]) assert.ok(bash(c), c);
});

test('project rules see the same command text', () => {
  const rule = [{ tool: '^Bash$', match: String.raw`\bplaywright\s+test\b`, label: 'e2e' }];
  assert.ok(bash('pnpm exec playwright test tests/e2e', rule));
  assert.equal(bash("cat > /tmp/c.mjs <<'EOF'\nimport { chromium } from 'playwright';\nEOF\nnode /tmp/c.mjs", rule), null);
});

test('asks before connector actions that change something', () => {
  assert.ok(matchRule('mcp__supabase__apply_migration', { name: 'x' }));
  assert.ok(matchRule('mcp__claude_ai_Vercel__deploy_to_vercel', {}));
  assert.ok(matchRule('mcp__slack__send_message', {}));
  assert.ok(matchRule('mcp__claude_ai_Gmail__reply', {}));
  assert.ok(matchRule('mcp__claude_ai_Google_Drive__share_file', {}));
  assert.equal(matchRule('mcp__peekaboo__click', { confirm: 'Submit for Review', on: 'B12' })?.label, 'click a consequential button on screen');
  assert.equal(matchRule('mcp__peekaboo__action', { on: 'B3', action: 'AXPress', confirm: 'Upload' })?.label, 'click a consequential button on screen');
  assert.equal(matchRule('mcp__peekaboo__click', { on: 'B12' }), null, 'clicks the guard lets through run without asking');
  assert.ok(matchRule('mcp__peekaboo__agent', { task: 'release the app' }));
  assert.equal(matchRule('mcp__peekaboo__browser', { action: 'click', uid: '1_5' })?.label, 'a browser action that can submit');
  assert.ok(matchRule('mcp__peekaboo__browser', { action: 'call', mcp_tool: 'evaluate_script' }));
  for (const action of ['navigate', 'snapshot', 'fill', 'screenshot', 'list_pages']) {
    assert.equal(matchRule('mcp__peekaboo__browser', { action }), null, action);
  }
  assert.equal(matchRule('mcp__claude_ai_Gmail__search_threads', {}), null);
  for (const t of ['mcp__claude_ai_Vercel__get_deployment', 'mcp__claude_ai_Vercel__list_deployments', 'mcp__claude_ai_Google_Drive__list_shared_drives', 'mcp__claude_ai_Google_Drive__get_shared_drive_metadata', 'mcp__claude_ai_Vercel__get_rolling_release']) {
    assert.equal(matchRule(t, {}), null, t);
  }
  assert.ok(matchRule('mcp__claude_ai_Vercel__cancel_deployment', {}), 'cancel_deployment still asks');
  assert.equal(matchRule('mcp__supabase__list_tables', {}), null);
  assert.equal(matchRule('Read', { file_path: '/etc/passwd' }), null);
});

test('a project rule over a whole connector still lets reads through, unless it says reads: true', () => {
  const rule = [{ tool: '^mcp__.*supabase', match: null, label: 'Supabase (production database)' }];
  const call = (tool, input = {}, rules = rule) => matchRule(`mcp__claude_ai_Supabase__${tool}`, input, rules);
  assert.equal(call('execute_sql', { query: "select table_name from information_schema.tables where table_schema='public' and table_name ilike '%view%'" }), null);
  assert.equal(call('list_tables'), null);
  assert.equal(call('get_project'), null);
  assert.equal(call('execute_sql', { query: 'update users set name = 1' })?.label, 'a connector action that changes something');
  assert.equal(call('create_branch')?.label, 'a connector action that changes something');
  assert.equal(call('generate_typescript_types')?.label, 'Supabase (production database)', 'not a read verb: the project rule asks');
  const strict = [{ ...rule[0], reads: true }];
  assert.equal(call('execute_sql', { query: 'select 1' }, strict)?.label, 'Supabase (production database)');
  assert.equal(call('list_tables', {}, strict)?.label, 'Supabase (production database)');
});

test('SQL that only reads runs without asking; anything that could write asks', () => {
  const sql = (query) => matchRule('mcp__claude_ai_Supabase__execute_sql', { project_id: 'p', query });
  for (const q of [
    "with real as (\n select p.* from player_profiles p join auth.users u on u.id=p.auth_id\n where u.email not ilike '%@pickcourt.test' and coalesce(p.name, '') <> ''\n) select count(*) from real",
    'select 1',
    'SELECT id, created_at FROM bookings ORDER BY created_at DESC LIMIT 20;',
    "select date_trunc('day', created_at) d, count(*) from bookings group by 1",
    'explain select * from courts',
    "select 'delete from users' as note -- update in a comment\n",
    'select table_name from information_schema.tables; select count(*) from courts',
    "select row_number() over (partition by venue_id order by created_at) from bookings",
  ]) assert.equal(sql(q), null, q);
  for (const q of [
    'delete from bookings',
    'update users set name = 1',
    'insert into logs values (1)',
    'select * into backup from users',
    'explain analyze delete from users',
    'select 1; drop table users',
    'select delete_everything()',
    'select public.cleanup_users()',
    "select set_config('role', 'service_role', false)",
    "select nextval('seq')",
    'truncate courts',
    'do $$ begin perform 1; end $$',
    'with x as (delete from users returning *) select * from x',
    'select * from users for update',
    "select 'unterminated",
    '',
  ]) assert.ok(sql(q), q);
  assert.ok(matchRule('mcp__claude_ai_Supabase__execute_sql', {}), 'no query: ask');
  assert.ok(matchRule('mcp__claude_ai_Supabase__apply_migration', { query: 'select 1' }), 'migrations always ask');
});

test('asks before releasing an app or pushing a patch to users', () => {
  for (const c of [
    'shorebird patch ios --release-version=1.0.74+110',
    'cd apps/mobile-player && shorebird patch android --release-version=1.0.74+111',
    'shorebird release android --flutter-version 3.47.4',
    'shorebird patches promote --release-version 1.0.0 --patch-number 2',
    'bundle exec fastlane ios beta',
    'fastlane release',
    'xcrun altool --upload-app -f app.ipa -t ios',
    'firebase appdistribution:distribute app.apk --app x',
    'eas build --platform ios --auto-submit',
  ]) assert.ok(bash(c), c);
  for (const c of ['shorebird --version', 'shorebird doctor', 'shorebird preview', 'fastlane --version', 'fastlane lanes', 'flutter build ipa --release']) {
    assert.equal(bash(c), null, c);
  }
});

test('does not ask when a risky name only appears in a path, a pattern or a message', () => {
  for (const c of [
    'tail -8 ~/Library/Application\\ Support/shorebird/logs/x.log | grep patch',
    'grep -rn "vercel --prod" docs',
    'git commit -m "push to main"',
    'cat wrangler.toml',
    'ls ~/.fly/deploy',
  ]) assert.equal(bash(c), null, c);
  for (const c of ['NODE_ENV=production npx vercel --prod', 'echo $(vercel --prod)', 'git -C ../app push origin main']) assert.ok(bash(c), c);
});

test('project rules add to the defaults', () => {
  const extra = [{ tool: '^Bash$', match: 'playwright test', label: 'tests hit production' }];
  assert.deepEqual(bash('pnpm exec playwright test', extra), { label: 'tests hit production' });
  assert.equal(bash('pnpm exec playwright test'), null);
  const writeRule = [{ tool: '^(Edit|Write)$', match: 'migrations/', label: 'migration file' }];
  assert.ok(matchRule('Write', { file_path: 'db/migrations/1.sql' }, writeRule));
});
