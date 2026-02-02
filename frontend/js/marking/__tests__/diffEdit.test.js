/**
 * Tests for diffEdit module.
 * Run in browser via test-runner.html.
 */

import { diffSingleEdit } from '../diffEdit.js';

// Simple test runner
let passed = 0;
let failed = 0;

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toBeNull() {
      if (actual !== null) {
        throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
      }
    },
    toEqual(expected) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
  };
}

function it(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ================================================================
// Insert tests
// ================================================================

describe('diffSingleEdit - Insert', () => {
  it('returns null for identical text', () => {
    expect(diffSingleEdit('hello', 'hello')).toBeNull();
  });

  it('detects insert at end', () => {
    const edits = diffSingleEdit('hello', 'hello world');
    expect(edits).toEqual([{ type: 'insert', pos: 5, len: 6 }]);
  });

  it('detects insert at start', () => {
    const edits = diffSingleEdit('world', 'hello world');
    expect(edits).toEqual([{ type: 'insert', pos: 0, len: 6 }]);
  });

  it('detects insert in middle', () => {
    const edits = diffSingleEdit(
      'Patient has headache.',
      'Patient has TERRIBLE headache.'
    );
    expect(edits).toEqual([{ type: 'insert', pos: 12, len: 9 }]);
  });

  it('detects single character insert', () => {
    const edits = diffSingleEdit('helo', 'hello');
    expect(edits).toEqual([{ type: 'insert', pos: 3, len: 1 }]);
  });

  it('detects insert at very end', () => {
    const edits = diffSingleEdit('hello', 'hello!');
    expect(edits).toEqual([{ type: 'insert', pos: 5, len: 1 }]);
  });
});

// ================================================================
// Delete tests
// ================================================================

describe('diffSingleEdit - Delete', () => {
  it('detects delete at end', () => {
    const edits = diffSingleEdit('hello world', 'hello');
    expect(edits).toEqual([{ type: 'delete', pos: 5, len: 6 }]);
  });

  it('detects delete at start', () => {
    const edits = diffSingleEdit('hello world', 'world');
    expect(edits).toEqual([{ type: 'delete', pos: 0, len: 6 }]);
  });

  it('detects delete in middle', () => {
    // "Patient has headache." -> "Patient headache."
    // Algorithm finds: delete "as h" at pos 9 (shares 'h' between "has" and "headache")
    const edits = diffSingleEdit('Patient has headache.', 'Patient headache.');
    expect(edits).toEqual([{ type: 'delete', pos: 9, len: 4 }]);
  });

  it('detects single character delete (backspace)', () => {
    const edits = diffSingleEdit('hello', 'hell');
    expect(edits).toEqual([{ type: 'delete', pos: 4, len: 1 }]);
  });

  it('detects delete at very start', () => {
    const edits = diffSingleEdit('hello', 'ello');
    expect(edits).toEqual([{ type: 'delete', pos: 0, len: 1 }]);
  });
});

// ================================================================
// Replace tests
// ================================================================

describe('diffSingleEdit - Replace', () => {
  it('detects replace (delete + insert)', () => {
    // "headache" -> "migraine" - both end with 'e', so only 7 chars differ
    const edits = diffSingleEdit('Patient has headache.', 'Patient has migraine.');
    expect(edits).toEqual([
      { type: 'delete', pos: 12, len: 7 },
      { type: 'insert', pos: 12, len: 7 },
    ]);
  });

  it('detects replace with different lengths', () => {
    const edits = diffSingleEdit('hello world', 'hello universe');
    expect(edits).toEqual([
      { type: 'delete', pos: 6, len: 5 },
      { type: 'insert', pos: 6, len: 8 },
    ]);
  });

  it('detects single char replace', () => {
    const edits = diffSingleEdit('cat', 'car');
    expect(edits).toEqual([
      { type: 'delete', pos: 2, len: 1 },
      { type: 'insert', pos: 2, len: 1 },
    ]);
  });
});

// ================================================================
// Empty string cases
// ================================================================

describe('diffSingleEdit - Empty strings', () => {
  it('handles empty to text', () => {
    const edits = diffSingleEdit('', 'hello');
    expect(edits).toEqual([{ type: 'insert', pos: 0, len: 5 }]);
  });

  it('handles text to empty', () => {
    const edits = diffSingleEdit('hello', '');
    expect(edits).toEqual([{ type: 'delete', pos: 0, len: 5 }]);
  });

  it('handles empty to empty', () => {
    expect(diffSingleEdit('', '')).toBeNull();
  });
});

// ================================================================
// Single char operations
// ================================================================

describe('diffSingleEdit - Single character operations', () => {
  it('single char insert at beginning', () => {
    const edits = diffSingleEdit('bc', 'abc');
    expect(edits).toEqual([{ type: 'insert', pos: 0, len: 1 }]);
  });

  it('single char insert at end', () => {
    const edits = diffSingleEdit('ab', 'abc');
    expect(edits).toEqual([{ type: 'insert', pos: 2, len: 1 }]);
  });

  it('single char delete from beginning', () => {
    const edits = diffSingleEdit('abc', 'bc');
    expect(edits).toEqual([{ type: 'delete', pos: 0, len: 1 }]);
  });

  it('single char delete from end', () => {
    const edits = diffSingleEdit('abc', 'ab');
    expect(edits).toEqual([{ type: 'delete', pos: 2, len: 1 }]);
  });

  it('single char replace', () => {
    const edits = diffSingleEdit('abc', 'aXc');
    expect(edits).toEqual([
      { type: 'delete', pos: 1, len: 1 },
      { type: 'insert', pos: 1, len: 1 },
    ]);
  });
});

// ================================================================
// Edge cases
// ================================================================

describe('diffSingleEdit - Edge cases', () => {
  it('handles repeated characters', () => {
    const edits = diffSingleEdit('aaa', 'aaaa');
    expect(edits).toEqual([{ type: 'insert', pos: 3, len: 1 }]);
  });

  it('handles whitespace changes', () => {
    const edits = diffSingleEdit('hello world', 'hello  world');
    expect(edits).toEqual([{ type: 'insert', pos: 6, len: 1 }]);
  });

  it('handles newline insert', () => {
    const edits = diffSingleEdit('hello', 'hello\n');
    expect(edits).toEqual([{ type: 'insert', pos: 5, len: 1 }]);
  });

  it('handles newline delete', () => {
    const edits = diffSingleEdit('hello\nworld', 'helloworld');
    expect(edits).toEqual([{ type: 'delete', pos: 5, len: 1 }]);
  });
});

// Run and report
console.log('\n========================================');
console.log(`diffEdit Tests: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) {
  console.error('TESTS FAILED');
} else {
  console.log('ALL TESTS PASSED');
}

export { passed, failed };
