import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import { selectToolsForProfile } from '../src/tool-profiles.js';
import { TOOLS } from '../src/index.js';

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('native adapter audit documentation', () => {
  it('places the exact breaking backend warning at the top of the 2.7.0 entry', () => {
    expect(read('CHANGELOG.md')).toMatch(
      /## (?:Unreleased - 2\.7\.0|2\.7\.0 - \d{4}-\d{2}-\d{2})\r?\n\r?\n\*\*BREAKING:\*\* the default backend is now Vikunja 2\.7 native MCP\. Servers older than 2\.7 must set VIKUNJA_MCP_BACKEND=rest\./,
    );
  });

  it.each(['README.md', 'skills/vikunja-fastmcp/SKILL.md'])(
    'documents Windows PowerShell credentials and receipt times in %s',
    (file) => {
      const text = read(file);
      expect(text).toContain('required unless `VIKUNJA_API_TOKEN_FILE` is used');
      expect(text).toContain('%LOCALAPPDATA%\\vikunja-fastmcp\\native-api-token.dpapi');
      expect(text).toContain('empty value disables the default');
      expect(text).toContain('PowerShell');
      expect(text).toContain('powershell.exe');
      expect(text).toContain('recordedAt');
    },
  );

  it.each(['README.md', 'skills/vikunja-fastmcp/SKILL.md'])(
    'documents exactly the native campaign tool list in %s',
    (file) => {
      const text = read(file);
      const section = text.split('### Native profile tools\n')[1].split('These typed tools')[0];
      const listed = [...section.matchAll(/^- `(\w+)`/gm)].map((match) => match[1]);
      expect(listed.filter((name) => !['find_action', 'do_action'].includes(name))).toEqual(
        selectToolsForProfile(TOOLS, 'native')
          .map((tool) => tool.name)
          .sort()
          .sort((a, b) => listed.indexOf(a) - listed.indexOf(b)),
      );
      expect(text).toContain(
        'non-native profiles only; in native mode use `find_action` / `do_action`',
      );
      for (const name of [
        'vikunja_notifications',
        'vikunja_account_email',
        'vikunja_admin_users',
        'vikunja_external_migration',
        'vikunja_projects',
        'vikunja_labels',
        'vikunja_users',
        'vikunja_teams',
        'vikunja_filters',
        'vikunja_task_reminders',
        'vikunja_auth',
      ]) {
        expect(text).toContain(`\`${name}\``);
        expect(listed).not.toContain(name);
      }
    },
  );
});
