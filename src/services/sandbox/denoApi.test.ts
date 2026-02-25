import { describe, expect, test } from 'bun:test';
import { denoSlug } from './denoApi.ts';

describe('denoSlug', () => {
  test('generates a slug with prefix and name', () => {
    const slug = denoSlug('hm', 'my-session');
    expect(slug).toStartWith('hm-');
    expect(slug).toContain('my-session');
    expect(slug.length).toBeLessThanOrEqual(32);
  });

  test('respects the 32 character max limit', () => {
    const slug = denoSlug('prefix', 'a-very-long-name-that-exceeds-the-limit');
    expect(slug.length).toBeLessThanOrEqual(32);
  });

  test('handles empty name by using prefix and id only', () => {
    const slug = denoSlug('hm');
    expect(slug).toStartWith('hm-');
    expect(slug.length).toBeLessThanOrEqual(32);
    // Should be prefix + '-' + 10-char nanoid
    expect(slug.length).toBe(13); // 'hm' + '-' + 10 chars
  });

  test('handles undefined name same as empty', () => {
    const slug = denoSlug('hm', undefined);
    expect(slug).toStartWith('hm-');
    expect(slug.length).toBe(13);
  });

  test('sanitizes special characters to hyphens', () => {
    const slug = denoSlug('hm', 'hello@world!foo#bar');
    expect(slug).toStartWith('hm-');
    // Special chars replaced with hyphens, consecutive hyphens collapsed
    expect(slug).not.toMatch(/[^a-z0-9-]/);
    expect(slug.length).toBeLessThanOrEqual(32);
  });

  test('converts uppercase to lowercase', () => {
    const slug = denoSlug('hm', 'MySession');
    expect(slug).toStartWith('hm-');
    expect(slug).not.toMatch(/[A-Z]/);
    expect(slug).toContain('mysession');
  });

  test('strips leading and trailing hyphens from name portion', () => {
    const slug = denoSlug('hm', '-leading-');
    expect(slug).toStartWith('hm-');
    // The sanitized name should not have leading/trailing hyphens
    expect(slug).not.toMatch(/^hm--/);
    expect(slug).toContain('leading');
  });

  test('collapses consecutive hyphens in name', () => {
    const slug = denoSlug('hm', 'a---b');
    expect(slug).toStartWith('hm-');
    expect(slug).toContain('a-b');
  });

  test('generates unique slugs (random suffix differs)', () => {
    const slug1 = denoSlug('hm', 'test');
    const slug2 = denoSlug('hm', 'test');
    expect(slug1).not.toBe(slug2);
  });

  test('generates unique slugs without name', () => {
    const slug1 = denoSlug('hm');
    const slug2 = denoSlug('hm');
    expect(slug1).not.toBe(slug2);
  });

  test('only contains lowercase alphanumeric and hyphens', () => {
    const slug = denoSlug('hm', 'Test_Name.v2!@#$%');
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  test('handles name that sanitizes to empty string', () => {
    const slug = denoSlug('hm', '!!!');
    // After sanitization, name becomes empty, so fallback to prefix-id
    expect(slug).toStartWith('hm-');
    expect(slug.length).toBe(13);
  });

  test('truncates long prefix to fit within 32 chars', () => {
    const slug = denoSlug('a-very-long-prefix-name', 'session');
    expect(slug.length).toBeLessThanOrEqual(32);
  });
});
