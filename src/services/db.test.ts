import { describe, expect, test } from 'bun:test';
import {
  ensureGhostCommandSucceeded,
  getFirstUsablePgpassLine,
  parseConnectionString,
  parseEnvOutput,
  parseGhostPgpassLine,
} from './db';

describe('parseConnectionString', () => {
  test('parses standard postgresql:// URL', () => {
    const result = parseConnectionString(
      'postgresql://user:pass@host.example.com:5432/mydb',
    );
    expect(result).toEqual({
      PGUSER: 'user',
      PGPASSWORD: 'pass',
      PGHOST: 'host.example.com',
      PGPORT: '5432',
      PGDATABASE: 'mydb',
    });
  });

  test('parses URL with encoded special characters in password', () => {
    const result = parseConnectionString(
      'postgresql://user:p%40ss%23word@host:5432/db',
    );
    expect(result.PGPASSWORD).toBe('p@ss#word');
    expect(result.PGUSER).toBe('user');
  });

  test('uses default port when missing', () => {
    const result = parseConnectionString('postgresql://user:pass@host/mydb');
    expect(result.PGPORT).toBe('5432');
  });

  test('handles non-standard port', () => {
    const result = parseConnectionString(
      'postgresql://user:pass@host:15432/mydb',
    );
    expect(result.PGPORT).toBe('15432');
  });
});

describe('parseEnvOutput', () => {
  test('parses standard env output', () => {
    const output = `PGHOST=localhost
PGPORT=5432
PGDATABASE=mydb
PGUSER=admin
PGPASSWORD=secret123`;

    const result = parseEnvOutput(output);
    expect(result).toEqual({
      PGHOST: 'localhost',
      PGPORT: '5432',
      PGDATABASE: 'mydb',
      PGUSER: 'admin',
      PGPASSWORD: 'secret123',
    });
  });

  test('handles values with equals signs', () => {
    const output = `CONNECTION_STRING=host=localhost;port=5432;password=a=b=c`;

    const result = parseEnvOutput(output);
    expect(result).toEqual({
      CONNECTION_STRING: 'host=localhost;port=5432;password=a=b=c',
    });
  });

  test('handles empty lines', () => {
    const output = `KEY1=value1

KEY2=value2

KEY3=value3`;

    const result = parseEnvOutput(output);
    expect(result).toEqual({
      KEY1: 'value1',
      KEY2: 'value2',
      KEY3: 'value3',
    });
  });

  test('handles lines with leading/trailing whitespace', () => {
    const output = `  KEY1=value1  
	KEY2=value2	
KEY3=value3`;

    const result = parseEnvOutput(output);
    expect(result).toEqual({
      KEY1: 'value1',
      KEY2: 'value2',
      KEY3: 'value3',
    });
  });

  test('ignores lines without equals sign', () => {
    const output = `KEY1=value1
this is a comment
KEY2=value2
# another comment
KEY3=value3`;

    const result = parseEnvOutput(output);
    expect(result).toEqual({
      KEY1: 'value1',
      KEY2: 'value2',
      KEY3: 'value3',
    });
  });

  test('handles empty string', () => {
    const result = parseEnvOutput('');
    expect(result).toEqual({});
  });

  test('handles value with spaces', () => {
    const output = `MESSAGE=Hello World
PATH=/usr/local/bin:/usr/bin`;

    const result = parseEnvOutput(output);
    expect(result).toEqual({
      MESSAGE: 'Hello World',
      PATH: '/usr/local/bin:/usr/bin',
    });
  });

  test('handles empty value', () => {
    const output = `EMPTY_VAR=
NON_EMPTY=value`;

    const result = parseEnvOutput(output);
    expect(result).toEqual({
      EMPTY_VAR: '',
      NON_EMPTY: 'value',
    });
  });

  test('handles keys with underscores and numbers', () => {
    const output = `DATABASE_URL_1=postgres://localhost/db1
API_KEY_V2=abc123`;

    const result = parseEnvOutput(output);
    expect(result).toEqual({
      DATABASE_URL_1: 'postgres://localhost/db1',
      API_KEY_V2: 'abc123',
    });
  });

  test('handles realistic tiger output', () => {
    const output = `PGHOST=abc123.tsdb.cloud.timescale.com
PGPORT=30211
PGDATABASE=tsdb
PGUSER=tsdbadmin
PGPASSWORD=supersecretpassword123
PGSSLMODE=require`;

    const result = parseEnvOutput(output);
    expect(result).toEqual({
      PGHOST: 'abc123.tsdb.cloud.timescale.com',
      PGPORT: '30211',
      PGDATABASE: 'tsdb',
      PGUSER: 'tsdbadmin',
      PGPASSWORD: 'supersecretpassword123',
      PGSSLMODE: 'require',
    });
  });

  test('overwrites duplicate keys with last value', () => {
    const output = `KEY=first
KEY=second
KEY=third`;

    const result = parseEnvOutput(output);
    expect(result).toEqual({
      KEY: 'third',
    });
  });
});

describe('parseGhostPgpassLine', () => {
  test('parses a Ghost .pgpass line into PG env vars and DATABASE_URL', () => {
    expect(
      parseGhostPgpassLine(
        'doyxetwy0v.l62qyaesnr.tsdb.cloud.timescale.com:33889:tsdb:tsdbadmin:ngtbf680o9m5gkpi',
      ),
    ).toEqual({
      PGHOST: 'doyxetwy0v.l62qyaesnr.tsdb.cloud.timescale.com',
      PGPORT: '33889',
      PGDATABASE: 'tsdb',
      PGUSER: 'tsdbadmin',
      PGPASSWORD: 'ngtbf680o9m5gkpi',
      DATABASE_URL:
        'postgresql://tsdbadmin:ngtbf680o9m5gkpi@doyxetwy0v.l62qyaesnr.tsdb.cloud.timescale.com:33889/tsdb',
    });
  });

  test('handles passwords containing colons', () => {
    expect(
      parseGhostPgpassLine('host.example.com:5432:mydb:admin:pass:with:colons'),
    ).toEqual({
      PGHOST: 'host.example.com',
      PGPORT: '5432',
      PGDATABASE: 'mydb',
      PGUSER: 'admin',
      PGPASSWORD: 'pass:with:colons',
      DATABASE_URL:
        'postgresql://admin:pass%3Awith%3Acolons@host.example.com:5432/mydb',
    });
  });

  test('handles empty password', () => {
    const result = parseGhostPgpassLine('host:5432:db:user:');
    expect(result.PGPASSWORD).toBe('');
  });

  test('rejects malformed .pgpass lines', () => {
    expect(() => parseGhostPgpassLine('host:5432:db:user')).toThrow(
      'Invalid Ghost .pgpass line',
    );
  });
});

describe('getFirstUsablePgpassLine', () => {
  test('returns the first non-empty non-comment line', () => {
    expect(
      getFirstUsablePgpassLine(
        '\n# generated by ghost\n\nhost:5432:db:user:pass\nother:5432:db:user:pass\n',
      ),
    ).toBe('host:5432:db:user:pass');
  });

  test('returns null when no usable lines exist', () => {
    expect(getFirstUsablePgpassLine('\n# comment only\n\n')).toBeNull();
  });
});

describe('ensureGhostCommandSucceeded', () => {
  test('returns output when ghost command succeeds', () => {
    expect(
      ensureGhostCommandSucceeded({
        command: 'ghost fork',
        exitCode: 0,
        output: '{"id":"fork-123"}',
        errorOutput: '',
      }),
    ).toBe('{"id":"fork-123"}');
  });

  test('throws with stderr when ghost command fails', () => {
    expect(() =>
      ensureGhostCommandSucceeded({
        command: 'ghost fork',
        exitCode: 1,
        output: '',
        errorOutput: 'database not found',
      }),
    ).toThrow('ghost fork failed: database not found');
  });
});
