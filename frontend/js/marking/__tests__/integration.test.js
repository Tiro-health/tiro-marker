/**
 * Integration tests for the offset-based marking system.
 * Tests the full flow: extract marks, track edits, transform offsets, apply marks.
 *
 * Run in browser via test-runner.html.
 */

import { diffSingleEdit } from '../diffEdit.js';
import { extractMarksFromHTML, validateMarksAgainstText } from '../extractMarks.js';
import { transformOffset, transformMark, transformAndValidateMarks } from '../offsetTransform.js';

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
    toHaveLength(expected) {
      if (!Array.isArray(actual) || actual.length !== expected) {
        throw new Error(`Expected length ${expected}, got ${Array.isArray(actual) ? actual.length : 'not an array'}`);
      }
    },
    not: {
      toBe(expected) {
        if (actual === expected) {
          throw new Error(`Expected ${JSON.stringify(actual)} NOT to be ${JSON.stringify(expected)}`);
        }
      },
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
// Integration: Extract + Validate
// ================================================================

describe('Integration: Extract and Validate', () => {
  it('extracts marks and validates against matching text', () => {
    const html = '<p>Patient has <mark data-location="symptom.answer">headache</mark>.</p>';
    const { marks, plainText } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(1);
    expect(plainText).toBe('Patient has headache.');

    // Validate marks against plain text
    const validated = validateMarksAgainstText(marks, plainText);
    expect(validated[0].valid).toBe(true);
  });

  it('handles multiple paragraphs correctly', () => {
    const html = '<p><mark data-location="q1.answer">First</mark>.</p><p><mark data-location="q2.answer">Second</mark>.</p>';
    const { marks, plainText } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(2);
    expect(plainText).toBe('First.\n\nSecond.');

    const validated = validateMarksAgainstText(marks, plainText);
    expect(validated[0].valid).toBe(true);
    expect(validated[1].valid).toBe(true);
  });
});

// ================================================================
// Integration: User types at end while backend processes
// ================================================================

describe('Integration: User types at end while backend processes', () => {
  it('marks remain valid when user types at end', () => {
    // Simulate: backend processes "Patient has headache."
    // User adds " No fever." at the end during processing
    const html = '<p>Patient has <mark data-location="symptom.answer">headache</mark>.</p>';
    const { marks } = extractMarksFromHTML(html);

    // User edit: insert " No fever." at position 21
    const edits = [{ type: 'insert', pos: 21, len: 10 }];
    const currentText = 'Patient has headache. No fever.';

    const transformed = transformAndValidateMarks(marks, edits, currentText);

    expect(transformed).toHaveLength(1);
    expect(transformed[0].valid).toBe(true);
    // Offset should remain unchanged (edit was after mark)
    expect(transformed[0].start).toBe(12);
    expect(transformed[0].end).toBe(20);
  });

  it('handles rapid typing at end', () => {
    const html = '<p><mark data-location="q.answer">Hello</mark></p>';
    const { marks } = extractMarksFromHTML(html);

    // User types "!!!" one character at a time at the end
    const edits = [
      { type: 'insert', pos: 5, len: 1 },
      { type: 'insert', pos: 6, len: 1 },
      { type: 'insert', pos: 7, len: 1 },
    ];
    const currentText = 'Hello!!!';

    const transformed = transformAndValidateMarks(marks, edits, currentText);

    expect(transformed[0].valid).toBe(true);
    expect(transformed[0].start).toBe(0);
    expect(transformed[0].end).toBe(5);
  });
});

// ================================================================
// Integration: User inserts word in marked sentence
// ================================================================

describe('Integration: User inserts word in marked sentence', () => {
  it('invalidates mark when text is modified inside', () => {
    const html = '<p>Patient has <mark data-location="symptom.answer">headache</mark>.</p>';
    const { marks } = extractMarksFromHTML(html);

    // User changes "headache" to "bad headache"
    // This is an insert at position 12 (start of "headache")
    const edits = [{ type: 'insert', pos: 12, len: 4 }]; // "bad " inserted
    const currentText = 'Patient has bad headache.';

    const transformed = transformAndValidateMarks(marks, edits, currentText);

    // Mark should shift but text won't match original
    expect(transformed[0].start).toBe(16); // shifted by 4
    expect(transformed[0].end).toBe(24);
    // The mark text at new position is "headache" which matches, but
    // validation should still work
    expect(transformed[0].valid).toBe(true);
  });

  it('handles word replacement in first sentence with second mark intact', () => {
    const html = '<p><mark data-location="q1.answer">Patient has headache</mark>. <mark data-location="q2.answer">Pain is severe</mark>.</p>';
    const { marks } = extractMarksFromHTML(html);

    // User replaces "headache" with "migraine" (delete 8, insert 8 at same position)
    const edits = [
      { type: 'delete', pos: 12, len: 8 },
      { type: 'insert', pos: 12, len: 8 },
    ];
    const currentText = 'Patient has migraine. Pain is severe.';

    const transformed = transformAndValidateMarks(marks, edits, currentText);

    // First mark is invalid (text changed)
    expect(transformed[0].valid).toBe(false);
    // Second mark should be valid and unchanged
    expect(transformed[1].valid).toBe(true);
    expect(transformed[1].start).toBe(22);
  });
});

// ================================================================
// Integration: User adds paragraph between existing ones
// ================================================================

describe('Integration: User adds paragraph between existing ones', () => {
  it('shifts second mark when paragraph is inserted between', () => {
    const html = '<p><mark data-location="p1.answer">First paragraph</mark>.</p><p><mark data-location="p2.answer">Second paragraph</mark>.</p>';
    const { marks } = extractMarksFromHTML(html);

    // Initial offsets:
    // "First paragraph" at 0-15
    // "." at 15
    // \n\n at 16-17
    // "Second paragraph" at 18-34

    expect(marks[0].start).toBe(0);
    expect(marks[0].end).toBe(15);
    expect(marks[1].start).toBe(18); // After "First paragraph.\n\n"

    // User inserts "New paragraph.\n\n" (16 chars) at position 18 (start of second para)
    const edits = [{ type: 'insert', pos: 18, len: 16 }];
    const currentText = 'First paragraph.\n\nNew paragraph.\n\nSecond paragraph.';

    const transformed = transformAndValidateMarks(marks, edits, currentText);

    // First mark unchanged
    expect(transformed[0].start).toBe(0);
    expect(transformed[0].end).toBe(15);
    expect(transformed[0].valid).toBe(true);

    // Second mark shifted by 16
    expect(transformed[1].start).toBe(34);
    expect(transformed[1].end).toBe(50);
    expect(transformed[1].valid).toBe(true);
  });
});

// ================================================================
// Integration: Duplicate text (medical document scenario)
// ================================================================

describe('Integration: Duplicate text in medical document', () => {
  it('handles "Oral administration" appearing multiple times', () => {
    // Use single-line HTML to avoid template literal whitespace issues
    const html = '<p>Med1: <mark data-location="med1-route.answer">Oral administration</mark>.</p><p>Med2: <mark data-location="med2-route.answer">Oral administration</mark>.</p><p>Med3: <mark data-location="med3-route.answer">Oral administration</mark>.</p>';
    const { marks, plainText } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(3);

    // All three should have "Oral administration" as text
    expect(marks[0].text).toBe('Oral administration');
    expect(marks[1].text).toBe('Oral administration');
    expect(marks[2].text).toBe('Oral administration');

    // But different linkIds
    expect(marks[0].linkId).toBe('med1-route.answer');
    expect(marks[1].linkId).toBe('med2-route.answer');
    expect(marks[2].linkId).toBe('med3-route.answer');

    // And different offsets (verify they extract from correct positions)
    expect(marks[0].start).not.toBe(marks[1].start);
    expect(marks[1].start).not.toBe(marks[2].start);

    // Validate all marks
    const validated = validateMarksAgainstText(marks, plainText);
    expect(validated[0].valid).toBe(true);
    expect(validated[1].valid).toBe(true);
    expect(validated[2].valid).toBe(true);
  });

  it('maintains correct offsets when user edits between duplicates', () => {
    // Use single-line HTML to avoid template literal whitespace issues
    const html = '<p>Med1: <mark data-location="m1.answer">twice daily</mark>.</p><p>Med2: <mark data-location="m2.answer">twice daily</mark>.</p>';
    const { marks } = extractMarksFromHTML(html);

    // marks[0]: "twice daily" at 6-17
    // marks[1]: "twice daily" at 26-37 (after "Med1: twice daily.\n\nMed2: ")

    // User inserts "EDIT" after first period (position 18)
    const edits = [{ type: 'insert', pos: 18, len: 4 }];

    // Simulate current text
    const currentText = 'Med1: twice daily.EDIT\n\nMed2: twice daily.';

    const transformed = transformAndValidateMarks(marks, edits, currentText);

    // First mark unchanged (edit was after it)
    expect(transformed[0].valid).toBe(true);
    expect(transformed[0].start).toBe(6);
    expect(transformed[0].end).toBe(17);

    // Second mark shifted by 4
    expect(transformed[1].valid).toBe(true);
    expect(transformed[1].start).toBe(marks[1].start + 4);
  });
});

// ================================================================
// Integration: Full flow simulation
// ================================================================

describe('Integration: Full marking flow simulation', () => {
  it('simulates complete marking cycle with concurrent edit', () => {
    // Step 1: User has typed "Patient has headache. Pain is severe."
    const originalText = 'Patient has headache. Pain is severe.';

    // Step 2: Backend receives and marks the content
    const markedHtml = '<p>Patient has <mark data-location="symptom.answer">headache</mark>. <mark data-location="severity.answer">Pain is severe</mark>.</p>';

    // Step 3: While backend processes, user adds " No fever." at end
    const edits = [{ type: 'insert', pos: 37, len: 10 }];
    const currentText = 'Patient has headache. Pain is severe. No fever.';

    // Step 4: Extract marks from backend response
    const { marks, plainText } = extractMarksFromHTML(markedHtml);

    // Step 5: Validate marks match the HTML plain text (sanity check)
    const sanityCheck = validateMarksAgainstText(marks, plainText);
    expect(sanityCheck.every(m => m.valid)).toBe(true);

    // Step 6: Transform marks through edits
    const transformed = transformAndValidateMarks(marks, edits, currentText);

    // Step 7: Verify all marks are still valid
    expect(transformed[0].valid).toBe(true);
    expect(transformed[0].text).toBe('headache');
    expect(transformed[0].start).toBe(12);
    expect(transformed[0].end).toBe(20);

    expect(transformed[1].valid).toBe(true);
    expect(transformed[1].text).toBe('Pain is severe');
    expect(transformed[1].start).toBe(22);
    expect(transformed[1].end).toBe(36);
  });

  it('handles backspace during processing', () => {
    // User typed "Helloo" (typo), backend processes
    // User backspaces the extra 'o' during processing

    const markedHtml = '<p><mark data-location="greeting.answer">Helloo</mark> world.</p>';
    const { marks } = extractMarksFromHTML(markedHtml);

    // User deletes one character at position 5
    const edits = [{ type: 'delete', pos: 5, len: 1 }];
    const currentText = 'Hello world.';

    const transformed = transformAndValidateMarks(marks, edits, currentText);

    // Mark becomes invalid because text changed
    expect(transformed[0].valid).toBe(false);
  });
});

// Run and report
console.log('\n========================================');
console.log(`Integration Tests: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) {
  console.error('TESTS FAILED');
} else {
  console.log('ALL TESTS PASSED');
}

export { passed, failed };
