import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRule } from '../src/policy.mjs';

const bash = (command, extra) => matchRule('Bash', { command }, extra);

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

test('asks before merges, releases, publishing and direct database access', () => {
  for (const c of ['gh pr merge 12 --squash', 'gh release create v1.0.0', 'gh api repos/o/r/issues -X POST -f title=x', 'npm publish', 'pnpm publish --access public', 'docker push me/app', 'psql "$DATABASE_URL" -c "select 1"', 'sudo rm x', 'rm -rf ~/Projects', 'rm -rf /tmp/x', 'rm -r ../other']) {
    assert.ok(bash(c), c);
  }
  for (const c of ['gh pr create --fill', 'gh pr view 3', 'gh api repos/o/r/pulls', 'npm test', 'rm -rf node_modules dist', 'rm file.txt']) {
    assert.equal(bash(c), null, c);
  }
});

test('asks before connector actions that change something', () => {
  assert.ok(matchRule('mcp__supabase__apply_migration', { name: 'x' }));
  assert.ok(matchRule('mcp__claude_ai_Vercel__deploy_to_vercel', {}));
  assert.ok(matchRule('mcp__slack__send_message', {}));
  assert.equal(matchRule('mcp__supabase__list_tables', {}), null);
  assert.equal(matchRule('Read', { file_path: '/etc/passwd' }), null);
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
