#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readWorkflow = (filename) =>
  parse(fs.readFileSync(path.join(repoRoot, '.github/workflows', filename), 'utf8'));
const workflow = readWorkflow('publish.yml');

const fail = (message) => {
  process.stderr.write(`release governance check failed: ${message}\n`);
  process.exitCode = 1;
};

const triggers = workflow.on;
if (!triggers || typeof triggers !== 'object') {
  fail('publish.yml must declare structured triggers');
} else {
  const push = triggers.push;
  if (!push || typeof push !== 'object') {
    fail('publish.yml must retain stable tag publishing');
  } else {
    if ('branches' in push || 'branches-ignore' in push) {
      fail('publish.yml must not publish from branch pushes');
    }
    const tags = Array.isArray(push.tags) ? push.tags : [];
    if (!tags.includes('v*') || !tags.includes('!v*-rc.*')) {
      fail('publish.yml must accept stable tags and reject self-produced RC tags');
    }
  }
  if (!('workflow_dispatch' in triggers)) {
    fail('publish.yml must retain an explicit manual RC trigger');
  }
  if ('pull_request' in triggers || 'pull_request_target' in triggers) {
    fail('publish.yml must never publish from pull request events');
  }
}

const publishJob = workflow.jobs?.publish;
const environment =
  typeof publishJob?.environment === 'string'
    ? publishJob.environment
    : publishJob?.environment?.name;
if (environment !== 'internal-release') {
  fail('the publish job must require the internal-release environment');
}

for (const filename of [
  'ci.yml',
  'codeql.yml',
  'gitleaks.yml',
  'dependency-review.yml',
  'workflow-lint.yml',
]) {
  const candidate = readWorkflow(filename);
  const pullRequest = candidate.on?.pull_request;
  if (!pullRequest || typeof pullRequest !== 'object') {
    fail(`${filename} must run for pull requests`);
    continue;
  }
  const branches = Array.isArray(pullRequest.branches) ? pullRequest.branches : [];
  if (!branches.includes('main')) {
    fail(`${filename} must run for main-targeted pull requests`);
  }
  if ('paths' in pullRequest || 'paths-ignore' in pullRequest) {
    fail(`${filename} must not omit required checks through path filters`);
  }
}

if (!process.exitCode) {
  process.stdout.write('release governance check passed\n');
}
