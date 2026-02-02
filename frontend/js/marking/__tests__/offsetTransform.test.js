/**
 * Tests for offset transform and edit tracker modules.
 * Run in browser via test-runner.html (uses import maps for Lexical).
 */

import { transformOffset, transformMark, transformAndValidateMarks } from '../offsetTransform.js';
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
// diffSingleEdit tests
// ================================================================

describe('diffSingleEdit', () => {
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

  it('detects delete at end', () => {
    const edits = diffSingleEdit('hello world', 'hello');
    expect(edits).toEqual([{ type: 'delete', pos: 5, len: 6 }]);
  });

  it('detects delete at start', () => {
    const edits = diffSingleEdit('hello world', 'world');
    expect(edits).toEqual([{ type: 'delete', pos: 0, len: 6 }]);
  });

  it('detects delete in middle', () => {
    // Algorithm finds: delete "as h" at pos 9 (shares 'h' between "has" and "headache")
    const edits = diffSingleEdit('Patient has headache.', 'Patient headache.');
    expect(edits).toEqual([{ type: 'delete', pos: 9, len: 4 }]);
  });

  it('detects replace (delete + insert)', () => {
    // "headache" -> "migraine" - both end with 'e', so only 7 chars differ
    const edits = diffSingleEdit('Patient has headache.', 'Patient has migraine.');
    expect(edits).toEqual([
      { type: 'delete', pos: 12, len: 7 },
      { type: 'insert', pos: 12, len: 7 },
    ]);
  });

  it('detects single character insert', () => {
    const edits = diffSingleEdit('helo', 'hello');
    expect(edits).toEqual([{ type: 'insert', pos: 3, len: 1 }]);
  });

  it('detects single character delete (backspace)', () => {
    const edits = diffSingleEdit('hello', 'hell');
    expect(edits).toEqual([{ type: 'delete', pos: 4, len: 1 }]);
  });

  it('handles empty to text', () => {
    const edits = diffSingleEdit('', 'hello');
    expect(edits).toEqual([{ type: 'insert', pos: 0, len: 5 }]);
  });

  it('handles text to empty', () => {
    const edits = diffSingleEdit('hello', '');
    expect(edits).toEqual([{ type: 'delete', pos: 0, len: 5 }]);
  });
});

// ================================================================
// transformOffset tests
// ================================================================

describe('transformOffset', () => {
  it('no edits returns same offset', () => {
    expect(transformOffset(22, [])).toBe(22);
  });

  // --- Insert scenarios ---

  it('insert BEFORE offset shifts it forward', () => {
    expect(transformOffset(22, [{ type: 'insert', pos: 12, len: 9 }])).toBe(31);
  });

  it('insert AFTER offset leaves it unchanged', () => {
    expect(transformOffset(22, [{ type: 'insert', pos: 30, len: 5 }])).toBe(22);
  });

  it('insert AT start offset (isEnd=false) shifts it', () => {
    expect(transformOffset(22, [{ type: 'insert', pos: 22, len: 5 }], false)).toBe(27);
  });

  it('insert AT end offset (isEnd=true) does NOT shift it', () => {
    expect(transformOffset(37, [{ type: 'insert', pos: 37, len: 5 }], true)).toBe(37);
  });

  it('insert AT offset (isEnd=true, pos < offset) shifts it', () => {
    expect(transformOffset(37, [{ type: 'insert', pos: 36, len: 5 }], true)).toBe(42);
  });

  // --- Delete scenarios ---

  it('delete BEFORE offset shifts it back', () => {
    expect(transformOffset(22, [{ type: 'delete', pos: 0, len: 8 }])).toBe(14);
  });

  it('delete AFTER offset leaves it unchanged', () => {
    expect(transformOffset(22, [{ type: 'delete', pos: 30, len: 5 }])).toBe(22);
  });

  it('delete OVERLAPPING offset collapses to delete position', () => {
    expect(transformOffset(22, [{ type: 'delete', pos: 18, len: 9 }])).toBe(18);
  });

  it('delete ending exactly at offset shifts it back', () => {
    expect(transformOffset(22, [{ type: 'delete', pos: 14, len: 8 }])).toBe(14);
  });

  // --- Multiple edits ---

  it('multiple sequential edits transform correctly', () => {
    const edits = [
      { type: 'insert', pos: 12, len: 9 },
      { type: 'insert', pos: 50, len: 6 },
    ];
    expect(transformOffset(22, edits)).toBe(31);
  });

  it('insert then delete', () => {
    const edits = [
      { type: 'insert', pos: 5, len: 3 },
      { type: 'delete', pos: 20, len: 2 },
    ];
    expect(transformOffset(22, edits)).toBe(23);
  });

  it('delete then insert at same position (replace)', () => {
    const edits = [
      { type: 'delete', pos: 12, len: 8 },
      { type: 'insert', pos: 12, len: 8 },
    ];
    expect(transformOffset(22, edits)).toBe(22);
  });
});

// ================================================================
// transformMark tests
// ================================================================

describe('transformMark', () => {
  it('transforms both start and end', () => {
    const mark = { start: 22, end: 37, text: 'Pain is severe.', linkId: 'q2' };
    const edits = [{ type: 'insert', pos: 12, len: 9 }];
    const result = transformMark(mark, edits);
    expect(result.start).toBe(31);
    expect(result.end).toBe(46);
    expect(result.text).toBe('Pain is severe.');
    expect(result.linkId).toBe('q2');
  });

  it('handles edit inside mark (start unchanged, end shifts)', () => {
    const mark = { start: 22, end: 37, text: 'Pain is severe.', linkId: 'q2' };
    const edits = [{ type: 'insert', pos: 30, len: 5 }];
    const result = transformMark(mark, edits);
    expect(result.start).toBe(22);
    expect(result.end).toBe(42);
  });
});

// ================================================================
// transformAndValidateMarks tests
// ================================================================

describe('transformAndValidateMarks', () => {
  it('validates marks against current text - all valid', () => {
    const marks = [
      { start: 0, end: 21, text: 'Patient has headache.', linkId: 'q1' },
      { start: 22, end: 37, text: 'Pain is severe.', linkId: 'q2' },
    ];
    const edits = [];
    const currentText = 'Patient has headache. Pain is severe.';
    const results = transformAndValidateMarks(marks, edits, currentText);
    expect(results[0].valid).toBe(true);
    expect(results[1].valid).toBe(true);
  });

  it('insert before marks — both shift and validate', () => {
    const marks = [
      { start: 0, end: 21, text: 'Patient has headache.', linkId: 'q1' },
      { start: 22, end: 37, text: 'Pain is severe.', linkId: 'q2' },
    ];
    const edits = [{ type: 'insert', pos: 0, len: 5 }];
    const currentText = 'XXXX Patient has headache. Pain is severe.';
    const results = transformAndValidateMarks(marks, edits, currentText);
    expect(results[0].start).toBe(5);
    expect(results[0].end).toBe(26);
    expect(results[0].valid).toBe(true);
    expect(results[1].start).toBe(27);
    expect(results[1].end).toBe(42);
    expect(results[1].valid).toBe(true);
  });

  it('edit inside marked text — mark invalid', () => {
    const marks = [
      { start: 0, end: 21, text: 'Patient has headache.', linkId: 'q1' },
    ];
    const edits = [
      { type: 'delete', pos: 12, len: 8 },
      { type: 'insert', pos: 12, len: 8 },
    ];
    const currentText = 'Patient has migraine. Pain is severe.';
    const results = transformAndValidateMarks(marks, edits, currentText);
    expect(results[0].valid).toBe(false);
  });

  it('edit after all marks — marks unchanged and valid', () => {
    const marks = [
      { start: 0, end: 21, text: 'Patient has headache.', linkId: 'q1' },
    ];
    const edits = [{ type: 'insert', pos: 38, len: 11 }];
    const currentText = 'Patient has headache. Pain is severe. No fever.';
    const results = transformAndValidateMarks(marks, edits, currentText);
    expect(results[0].start).toBe(0);
    expect(results[0].end).toBe(21);
    expect(results[0].valid).toBe(true);
  });

  it('duplicate text at different offsets — both correctly placed', () => {
    const marks = [
      { start: 9, end: 28, text: 'Oral administration', linkId: 'med1-route' },
      { start: 54, end: 73, text: 'Oral administration', linkId: 'med2-route' },
    ];
    const edits = [];
    const currentText = 'Aspirin. Oral administration. Metformin. Route: blah. Oral administration. Done.';
    const results = transformAndValidateMarks(marks, edits, currentText);
    expect(results[0].valid).toBe(true);
    expect(results[0].start).toBe(9);
    expect(results[1].valid).toBe(true);
    expect(results[1].start).toBe(54);
  });

  it('text deleted entirely — mark invalid', () => {
    const marks = [
      { start: 0, end: 21, text: 'Patient has headache.', linkId: 'q1' },
    ];
    const edits = [{ type: 'delete', pos: 0, len: 22 }];
    const currentText = 'Pain is severe.';
    const results = transformAndValidateMarks(marks, edits, currentText);
    expect(results[0].valid).toBe(false);
  });
});

// ================================================================
// Integration scenario tests
// ================================================================

describe('full scenarios', () => {
  it('Scenario: user types at end while backend processes', () => {
    const marks = [
      { start: 0, end: 21, text: 'Patient has headache.', linkId: 'q1' },
      { start: 22, end: 37, text: 'Pain is severe.', linkId: 'q2' },
    ];
    const edits = [{ type: 'insert', pos: 37, len: 10 }];
    const currentText = 'Patient has headache. Pain is severe. No fever.';
    const results = transformAndValidateMarks(marks, edits, currentText);
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it('Scenario: user inserts word in first sentence', () => {
    const marks = [
      { start: 0, end: 21, text: 'Patient has headache.', linkId: 'q1' },
      { start: 22, end: 37, text: 'Pain is severe.', linkId: 'q2' },
    ];
    const edits = [{ type: 'insert', pos: 12, len: 9 }];
    const currentText = 'Patient has TERRIBLE headache. Pain is severe.';
    const results = transformAndValidateMarks(marks, edits, currentText);
    expect(results[0].valid).toBe(false);
    expect(results[1].valid).toBe(true);
    expect(results[1].start).toBe(31);
  });

  it('Scenario: user types multiple characters one by one', () => {
    const marks = [{ start: 0, end: 5, text: 'Hello', linkId: 'q1' }];
    const edits = [
      { type: 'insert', pos: 10, len: 1 },
      { type: 'insert', pos: 11, len: 1 },
      { type: 'insert', pos: 12, len: 1 },
    ];
    const currentText = 'Hello worldabc';
    const results = transformAndValidateMarks(marks, edits, currentText);
    expect(results[0].valid).toBe(true);
    expect(results[0].start).toBe(0);
    expect(results[0].end).toBe(5);
  });

  it('Scenario: user backspaces in middle then retypes', () => {
    const marks = [{ start: 22, end: 37, text: 'Pain is severe.', linkId: 'q2' }];
    const edits = [
      { type: 'delete', pos: 12, len: 4 },
      { type: 'insert', pos: 12, len: 4 },
    ];
    const currentText = 'Patient has backache. Pain is severe.';
    const results = transformAndValidateMarks(marks, edits, currentText);
    expect(results[0].valid).toBe(true);
    expect(results[0].start).toBe(22);
    expect(results[0].end).toBe(37);
  });
});

// Run and report
console.log('\n========================================');
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) {
  console.error('TESTS FAILED');
} else {
  console.log('ALL TESTS PASSED');
}

export { passed, failed };
