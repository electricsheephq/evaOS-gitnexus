import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') callback(null, '', '');
  }),
  execFileSync: vi.fn(() => {
    throw new Error('not found');
  }),
}));

describe('doctor --integrations', () => {
  let home: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-integration-doctor-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    await Promise.all([
      fs.mkdir(path.join(home, '.claude'), { recursive: true }),
      fs.mkdir(path.join(home, '.codex'), { recursive: true }),
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    await fs.rm(home, { recursive: true, force: true });
  });

  async function writeMatchingMcp() {
    const entry = { command: '/opt/gitnexus-wrapper', args: ['mcp'], env: { SECRET: 'hidden' } };
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { gitnexus: entry },
        projects: { '/repo': { mcpServers: { gitnexus: entry } } },
      }),
    );
    await fs.writeFile(
      path.join(home, '.codex', 'config.toml'),
      '[mcp_servers.gitnexus]\ncommand = "/opt/gitnexus-wrapper"\nargs = ["mcp"]\n\n[mcp_servers.gitnexus.env]\nSECRET = "hidden"\n',
    );
  }

  it('reports matching MCP entries and a freshly installed Claude hook bundle as current', async () => {
    await writeMatchingMcp();
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['claude'], hooksOnly: true });
    const { buildIntegrationDoctorReport } = await import('../../src/cli/integration-doctor.js');
    const report = await buildIntegrationDoctorReport(home);

    expect(report.mcp).toEqual({
      status: 'consistent',
      codexConfigured: true,
      claudeConfiguredEntries: 2,
    });
    expect(report.hooks).toEqual({ claude: 'current', obsoleteSessionStart: false });
    expect(JSON.stringify(report)).not.toContain('/opt/gitnexus-wrapper');
    expect(JSON.stringify(report)).not.toContain('hidden');
  });

  it('distinguishes a stale hook from a missing hook', async () => {
    await writeMatchingMcp();
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['claude'], hooksOnly: true });
    const adapter = path.join(home, '.claude', 'hooks', 'gitnexus', 'gitnexus-hook.cjs');
    await fs.appendFile(adapter, '\n// stale\n');
    const { buildIntegrationDoctorReport } = await import('../../src/cli/integration-doctor.js');
    await expect(buildIntegrationDoctorReport(home)).resolves.toMatchObject({
      hooks: { claude: 'stale' },
    });
    await fs.rm(adapter);
    await expect(buildIntegrationDoctorReport(home)).resolves.toMatchObject({
      hooks: { claude: 'missing' },
    });
  });

  it('reports a sanitized MCP mismatch without returning config values', async () => {
    await writeMatchingMcp();
    const claudePath = path.join(home, '.claude.json');
    const config = JSON.parse(await fs.readFile(claudePath, 'utf8'));
    config.projects['/repo'].mcpServers.gitnexus.command = '/other-runtime';
    await fs.writeFile(claudePath, JSON.stringify(config));
    const { buildIntegrationDoctorReport } = await import('../../src/cli/integration-doctor.js');
    const report = await buildIntegrationDoctorReport(home);
    expect(report.mcp.status).toBe('mismatch');
    expect(JSON.stringify(report)).not.toContain('/other-runtime');
  });
});
