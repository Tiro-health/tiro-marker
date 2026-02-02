/**
 * Tests for extractMarks module.
 * Run in browser via test-runner.html.
 */

import { rebuildTextFromHTML, extractMarksFromHTML, validateMarksAgainstText } from '../extractMarks.js';

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
    toContain(expected) {
      if (typeof actual === 'string') {
        if (!actual.includes(expected)) {
          throw new Error(`Expected "${actual}" to contain "${expected}"`);
        }
      } else if (Array.isArray(actual)) {
        if (!actual.includes(expected)) {
          throw new Error(`Expected array to contain ${JSON.stringify(expected)}`);
        }
      } else {
        throw new Error(`toContain requires string or array, got ${typeof actual}`);
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
// rebuildTextFromHTML tests
// ================================================================

describe('rebuildTextFromHTML', () => {
  it('extracts text from simple paragraph', () => {
    const html = '<p>Hello world</p>';
    expect(rebuildTextFromHTML(html)).toBe('Hello world');
  });

  it('extracts text from multiple paragraphs with \\n\\n between them', () => {
    const html = '<p>First paragraph.</p><p>Second paragraph.</p>';
    expect(rebuildTextFromHTML(html)).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('handles BR tags as \\n', () => {
    const html = '<p>Line one<br>Line two</p>';
    expect(rebuildTextFromHTML(html)).toBe('Line one\nLine two');
  });

  it('strips mark tags, keeps content', () => {
    const html = '<p>Patient has <mark data-location="q1.answer">headache</mark>.</p>';
    expect(rebuildTextFromHTML(html)).toBe('Patient has headache.');
  });

  it('handles nested formatting inside marks', () => {
    const html = '<p>Patient has <mark data-location="q1.answer"><strong>severe</strong> headache</mark>.</p>';
    expect(rebuildTextFromHTML(html)).toBe('Patient has severe headache.');
  });

  it('handles headings like paragraphs', () => {
    const html = '<h1>Title</h1><p>Content here.</p>';
    expect(rebuildTextFromHTML(html)).toBe('Title\n\nContent here.');
  });

  it('handles divs like paragraphs', () => {
    const html = '<div>First</div><div>Second</div>';
    expect(rebuildTextFromHTML(html)).toBe('First\n\nSecond');
  });

  it('handles empty paragraphs', () => {
    const html = '<p></p><p>Content</p>';
    expect(rebuildTextFromHTML(html)).toBe('\n\nContent');
  });
});

// ================================================================
// extractMarksFromHTML - single mark tests
// ================================================================

describe('extractMarksFromHTML - single mark', () => {
  it('extracts single mark in paragraph', () => {
    const html = '<p>Patient has <mark data-location="symptoms.answer">headache</mark>.</p>';
    const { marks, plainText } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(1);
    expect(marks[0].linkId).toBe('symptoms.answer');
    expect(marks[0].text).toBe('headache');
    expect(marks[0].start).toBe(12);
    expect(marks[0].end).toBe(20);
    expect(plainText.slice(marks[0].start, marks[0].end)).toBe('headache');
  });

  it('extracts mark at beginning of paragraph', () => {
    const html = '<p><mark data-location="greeting.answer">Hello</mark> world.</p>';
    const { marks, plainText } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(1);
    expect(marks[0].text).toBe('Hello');
    expect(marks[0].start).toBe(0);
    expect(marks[0].end).toBe(5);
    expect(plainText.slice(marks[0].start, marks[0].end)).toBe('Hello');
  });

  it('extracts mark at end of paragraph', () => {
    const html = '<p>Say <mark data-location="word.answer">hello</mark></p>';
    const { marks, plainText } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(1);
    expect(marks[0].text).toBe('hello');
    expect(marks[0].start).toBe(4);
    expect(marks[0].end).toBe(9);
    expect(plainText.slice(marks[0].start, marks[0].end)).toBe('hello');
  });
});

// ================================================================
// extractMarksFromHTML - multiple marks tests
// ================================================================

describe('extractMarksFromHTML - multiple marks', () => {
  it('extracts multiple marks in same paragraph', () => {
    const html = '<p><mark data-location="symptom1.answer">Headache</mark> and <mark data-location="symptom2.answer">fever</mark>.</p>';
    const { marks, plainText } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(2);
    expect(marks[0].text).toBe('Headache');
    expect(marks[0].linkId).toBe('symptom1.answer');
    expect(marks[1].text).toBe('fever');
    expect(marks[1].linkId).toBe('symptom2.answer');

    // Verify offsets match plain text
    expect(plainText.slice(marks[0].start, marks[0].end)).toBe('Headache');
    expect(plainText.slice(marks[1].start, marks[1].end)).toBe('fever');
  });

  it('extracts marks across multiple paragraphs', () => {
    const html = '<p><mark data-location="p1.answer">First mark</mark>.</p><p><mark data-location="p2.answer">Second mark</mark>.</p>';
    const { marks, plainText } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(2);
    expect(marks[0].text).toBe('First mark');
    expect(marks[1].text).toBe('Second mark');

    // Verify offsets account for \n\n between paragraphs
    expect(plainText.slice(marks[0].start, marks[0].end)).toBe('First mark');
    expect(plainText.slice(marks[1].start, marks[1].end)).toBe('Second mark');

    // Second mark should start after "First mark.\n\n"
    expect(marks[1].start).toBe(13); // "First mark." (11) + "\n\n" (2)
  });

  it('handles duplicate text at different positions', () => {
    const html = '<p>Med1: <mark data-location="med1.answer">Oral administration</mark>.</p><p>Med2: <mark data-location="med2.answer">Oral administration</mark>.</p>';
    const { marks, plainText } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(2);
    expect(marks[0].text).toBe('Oral administration');
    expect(marks[1].text).toBe('Oral administration');

    // They should have different offsets
    expect(marks[0].start).not.toBe(marks[1].start);

    // Verify both offsets are correct
    expect(plainText.slice(marks[0].start, marks[0].end)).toBe('Oral administration');
    expect(plainText.slice(marks[1].start, marks[1].end)).toBe('Oral administration');
  });
});

// ================================================================
// extractMarksFromHTML - nested marks tests
// ================================================================

describe('extractMarksFromHTML - nested marks', () => {
  it('extracts nested marks correctly', () => {
    const html = '<p><mark data-location="outer.answer">Patient has <mark data-location="inner.answer">headache</mark></mark>.</p>';
    const { marks, plainText } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(2);

    // Inner mark (headache)
    const innerMark = marks.find(m => m.linkId === 'inner.answer');
    expect(innerMark.text).toBe('headache');
    expect(plainText.slice(innerMark.start, innerMark.end)).toBe('headache');

    // Outer mark (Patient has headache)
    const outerMark = marks.find(m => m.linkId === 'outer.answer');
    expect(outerMark.text).toBe('Patient has headache');
    expect(plainText.slice(outerMark.start, outerMark.end)).toBe('Patient has headache');
  });

  it('handles deeply nested marks', () => {
    const html = '<p><mark data-location="a.answer"><mark data-location="b.answer"><mark data-location="c.answer">text</mark></mark></mark></p>';
    const { marks, plainText } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(3);
    // All should point to the same text
    for (const mark of marks) {
      expect(mark.text).toBe('text');
      expect(plainText.slice(mark.start, mark.end)).toBe('text');
    }
  });
});

// ================================================================
// extractMarksFromHTML - formatting tests
// ================================================================

describe('extractMarksFromHTML - formatting inside marks', () => {
  it('handles bold inside mark', () => {
    const html = '<p><mark data-location="q.answer"><strong>Bold text</strong></mark></p>';
    const { marks, plainText } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(1);
    expect(marks[0].text).toBe('Bold text');
    expect(plainText.slice(marks[0].start, marks[0].end)).toBe('Bold text');
  });

  it('handles italic inside mark', () => {
    const html = '<p><mark data-location="q.answer"><em>Italic text</em></mark></p>';
    const { marks, plainText } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(1);
    expect(marks[0].text).toBe('Italic text');
  });

  it('handles mixed formatting inside mark', () => {
    const html = '<p><mark data-location="q.answer"><strong>Bold</strong> and <em>italic</em></mark></p>';
    const { marks, plainText } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(1);
    expect(marks[0].text).toBe('Bold and italic');
    expect(plainText.slice(marks[0].start, marks[0].end)).toBe('Bold and italic');
  });
});

// ================================================================
// extractMarksFromHTML - BR and heading tests
// ================================================================

describe('extractMarksFromHTML - BR and headings', () => {
  it('handles mark with BR inside', () => {
    const html = '<p><mark data-location="q.answer">Line 1<br>Line 2</mark></p>';
    const { marks, plainText } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(1);
    expect(marks[0].text).toBe('Line 1\nLine 2');
    expect(plainText.slice(marks[0].start, marks[0].end)).toBe('Line 1\nLine 2');
  });

  it('handles marks in headings', () => {
    const html = '<h2><mark data-location="title.answer">Section Title</mark></h2><p>Content.</p>';
    const { marks, plainText } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(1);
    expect(marks[0].text).toBe('Section Title');
    expect(plainText.slice(marks[0].start, marks[0].end)).toBe('Section Title');
  });
});

// ================================================================
// extractMarksFromHTML - whitespace handling
// ================================================================

describe('extractMarksFromHTML - whitespace handling', () => {
  it('trims leading whitespace from mark text', () => {
    const html = '<p><mark data-location="q.answer">  trimmed</mark></p>';
    const { marks } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(1);
    expect(marks[0].text).toBe('trimmed');
  });

  it('trims trailing whitespace from mark text', () => {
    const html = '<p><mark data-location="q.answer">trimmed  </mark></p>';
    const { marks } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(1);
    expect(marks[0].text).toBe('trimmed');
  });

  it('trims both leading and trailing whitespace', () => {
    const html = '<p><mark data-location="q.answer">  trimmed  </mark></p>';
    const { marks } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(1);
    expect(marks[0].text).toBe('trimmed');
  });

  it('skips marks that are only whitespace', () => {
    const html = '<p>Before<mark data-location="q.answer">   </mark>after</p>';
    const { marks } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(0);
  });
});

// ================================================================
// extractMarksFromHTML - filters non-.answer marks
// ================================================================

describe('extractMarksFromHTML - linkId filtering', () => {
  it('only includes marks ending in .answer', () => {
    const html = '<p><mark data-location="group"><mark data-location="q1.answer">text</mark></mark></p>';
    const { marks } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(1);
    expect(marks[0].linkId).toBe('q1.answer');
  });

  it('filters out container group marks', () => {
    const html = '<p><mark data-location="medications"><mark data-location="med1.answer">Aspirin</mark></mark></p>';
    const { marks } = extractMarksFromHTML(html);

    expect(marks).toHaveLength(1);
    expect(marks[0].linkId).toBe('med1.answer');
    expect(marks[0].text).toBe('Aspirin');
  });
});

// ================================================================
// extractMarksFromHTML - list tests (the key fix!)
// ================================================================

describe('extractMarksFromHTML - lists', () => {
  it('handles bullet list items', () => {
    const html = '<ul><li>Item one</li><li>Item two</li></ul>';
    const { plainText } = extractMarksFromHTML(html);
    // Should contain both items
    expect(plainText).toContain('Item one');
    expect(plainText).toContain('Item two');
  });

  it('handles marks in list items', () => {
    const html = `<ul>
      <li><mark data-location="q1.answer">Headache</mark></li>
      <li><mark data-location="q2.answer">Nausea</mark></li>
    </ul>`;
    const { marks, plainText } = extractMarksFromHTML(html);
    expect(marks).toHaveLength(2);
    // Key test: offsets must match the actual plainText
    expect(plainText.slice(marks[0].start, marks[0].end)).toBe('Headache');
    expect(plainText.slice(marks[1].start, marks[1].end)).toBe('Nausea');
  });

  it('handles numbered list items', () => {
    const html = '<ol><li>First</li><li>Second</li><li>Third</li></ol>';
    const { plainText } = extractMarksFromHTML(html);
    expect(plainText).toContain('First');
    expect(plainText).toContain('Second');
    expect(plainText).toContain('Third');
  });

  it('handles marks in numbered list', () => {
    const html = `<ol>
      <li>Take <mark data-location="dose.answer">500mg</mark> aspirin</li>
      <li>Drink <mark data-location="amount.answer">plenty of water</mark></li>
    </ol>`;
    const { marks, plainText } = extractMarksFromHTML(html);
    expect(marks).toHaveLength(2);
    expect(plainText.slice(marks[0].start, marks[0].end)).toBe('500mg');
    expect(plainText.slice(marks[1].start, marks[1].end)).toBe('plenty of water');
  });

  it('handles mixed paragraphs and lists', () => {
    const html = `
      <p>Patient presents with:</p>
      <ul>
        <li><mark data-location="s1.answer">Headache</mark></li>
        <li><mark data-location="s2.answer">Fever</mark></li>
      </ul>
      <p>Assessment: <mark data-location="dx.answer">viral infection</mark></p>
    `;
    const { marks, plainText } = extractMarksFromHTML(html);
    expect(marks).toHaveLength(3);
    // All marks should have correct offsets
    for (const mark of marks) {
      expect(plainText.slice(mark.start, mark.end)).toBe(mark.text);
    }
  });
});

// ================================================================
// validateMarksAgainstText tests
// ================================================================

describe('validateMarksAgainstText', () => {
  it('validates marks that match text', () => {
    const marks = [
      { linkId: 'q1.answer', text: 'headache', start: 12, end: 20 },
    ];
    const text = 'Patient has headache.';

    const validated = validateMarksAgainstText(marks, text);

    expect(validated).toHaveLength(1);
    expect(validated[0].valid).toBe(true);
  });

  it('invalidates marks that do not match text', () => {
    const marks = [
      { linkId: 'q1.answer', text: 'headache', start: 12, end: 20 },
    ];
    const text = 'Patient has migraine.'; // Text changed

    const validated = validateMarksAgainstText(marks, text);

    expect(validated).toHaveLength(1);
    expect(validated[0].valid).toBe(false);
  });

  it('validates multiple marks correctly', () => {
    // "First. Second." - "First" at 0-5, "Second" at 7-13
    const marks = [
      { linkId: 'q1.answer', text: 'First', start: 0, end: 5 },
      { linkId: 'q2.answer', text: 'Second', start: 7, end: 13 },
    ];
    const text = 'First. Second.';

    const validated = validateMarksAgainstText(marks, text);

    expect(validated[0].valid).toBe(true);
    expect(validated[1].valid).toBe(true);
  });
});

// Run and report
console.log('\n========================================');
console.log(`extractMarks Tests: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) {
  console.error('TESTS FAILED');
} else {
  console.log('ALL TESTS PASSED');
}

export { passed, failed };
