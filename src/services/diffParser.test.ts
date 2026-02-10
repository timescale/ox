import { describe, expect, test } from 'bun:test';
import { parseUnifiedDiff } from './diffParser';

describe('parseUnifiedDiff', () => {
  test('should parse multi-file diff', () => {
    const diff = `diff --git a/file1.ts b/file1.ts
index abc..def 100644
--- a/file1.ts
+++ b/file1.ts
@@ -1,3 +1,4 @@
 line1
+added
 line2
diff --git a/file2.ts b/file2.ts
index ghi..jkl 100644
--- a/file2.ts
+++ b/file2.ts
@@ -1 +1 @@
-old
+new`;

    const result = parseUnifiedDiff(diff);
    expect(result).toHaveLength(2);
    expect(result[0]?.path).toBe('file1.ts');
    expect(result[1]?.path).toBe('file2.ts');
    expect(result[0]?.diff).toContain('+added');
    expect(result[1]?.diff).toContain('+new');
  });

  test('should return empty array for no diff', () => {
    expect(parseUnifiedDiff('(no diff)')).toEqual([]);
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  test('should handle renamed files', () => {
    const diff = `diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts`;

    const result = parseUnifiedDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe('new.ts');
  });

  test('should handle single-file diff', () => {
    const diff = `diff --git a/src/main.ts b/src/main.ts
index abc..def 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 export { x };`;

    const result = parseUnifiedDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe('src/main.ts');
    expect(result[0]?.diff).toContain('+const y = 2;');
  });

  test('should handle paths with spaces', () => {
    const diff = `diff --git a/src/my file.ts b/src/my file.ts
index abc..def 100644
--- a/src/my file.ts
+++ b/src/my file.ts
@@ -1 +1 @@
-old
+new`;

    const result = parseUnifiedDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe('src/my file.ts');
  });

  test('should handle binary files', () => {
    const diff = `diff --git a/image.png b/image.png
Binary files /dev/null and b/image.png differ`;

    const result = parseUnifiedDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe('image.png');
  });
});
