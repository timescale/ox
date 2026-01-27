import { describe, expect, test } from 'bun:test';
import { parseEnvOutput } from './db';

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
