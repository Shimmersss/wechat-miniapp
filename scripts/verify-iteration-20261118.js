#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { applySql, previewSql } = require('./cleanup-demo-units');

const ids = ['de100000-0000-0000-0000-000000000001', 'de100000-0000-0000-0000-000000000004'];
const fingerprint = createHash('sha256').update(ids.join(',')).digest('hex');
const program = readFileSync(require('node:path').join(__dirname, 'sql/verify-iteration-20261118.sql'), 'utf8')
  .replace('/* PREVIEW_QUERY */', () => previewSql)
  .replaceAll('/* APPLY_QUERY */', () => applySql({ count: ids.length, fingerprint }));

// Use the local server explicitly. No cloud connection or remote connection string is accepted.
execFileSync('psql', ['-X', '-h', '127.0.0.1', '-p', '55439', '-d', 'iteration_final', '-v', 'ON_ERROR_STOP=1'],
  { input: program, stdio: ['pipe', 'inherit', 'inherit'] });
