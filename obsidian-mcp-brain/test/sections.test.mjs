import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findHeadings,
  outlineSections,
  readSection,
  replaceSection,
  deleteSection,
  findCheckboxes,
  toggleCheckbox,
} from '../lib/sections.mjs';

describe('findHeadings', () => {
  test('parses ATX headings with level and line number', () => {
    const content = '# Title\ntext\n## Sub\nmore\n### Deep\nend';
    const headings = findHeadings(content);
    assert.deepEqual(
      headings.map(h => ({ text: h.text, level: h.level, line: h.line })),
      [
        { text: 'Title', level: 1, line: 1 },
        { text: 'Sub', level: 2, line: 3 },
        { text: 'Deep', level: 3, line: 5 },
      ],
    );
  });

  test('bodyEndLine stops at next same-or-shallower heading, skipping deeper nested ones', () => {
    const content = '# A\nline2\n## B\nline4\n## C\nline6\n# D\nline8';
    const headings = findHeadings(content);
    const [a, b, c, d] = headings;
    assert.equal(a.bodyEndLine, 6); // "## B"/"## C" are deeper (nested), not a boundary; stops before "# D" (line 7, level 1 <= 1)
    assert.equal(b.bodyEndLine, 4); // stops before "## C" (line 5, level 2 <= 2)
    assert.equal(c.bodyEndLine, 6); // "# D" is same-or-shallower (level 1 <= 2)
    assert.equal(d.bodyEndLine, 8); // EOF
  });

  test('ignores non-ATX lines (Setext-style)', () => {
    const content = 'Title\n=====\ntext';
    assert.deepEqual(findHeadings(content), []);
  });

  test('returns empty array for content with no headings', () => {
    assert.deepEqual(findHeadings('just text\nno headings'), []);
  });

  test('ignores ATX-looking lines inside a fenced code block', () => {
    const content = '# Real\n```\n# not a heading\n```\n## Also Real';
    assert.deepEqual(
      findHeadings(content).map(h => h.text),
      ['Real', 'Also Real'],
    );
  });

  test('ignores fenced blocks using tilde fences and resumes parsing after the closing fence', () => {
    const content = '# A\n~~~\n## fake\n~~~\n## B';
    assert.deepEqual(
      findHeadings(content).map(h => h.text),
      ['A', 'B'],
    );
  });
});

describe('replaceSection', () => {
  test('replaces body up to next same-or-shallower heading, consuming nested subheadings', () => {
    const content = '# A\nold1\nold2\n## B\nkeep';
    const result = replaceSection(content, 'A', 'new1\nnew2');
    assert.equal(result, '# A\nnew1\nnew2');
  });

  test('replaces body up to a sibling heading at the same level', () => {
    const content = '# A\nold\n# Z\nkeep';
    const result = replaceSection(content, 'A', 'new');
    assert.equal(result, '# A\nnew\n# Z\nkeep');
  });

  test('replaces to end of file when heading is last', () => {
    const content = '# A\nkeep\n## B\nold';
    const result = replaceSection(content, 'B', 'new');
    assert.equal(result, '# A\nkeep\n## B\nnew');
  });

  test('deeper nested headings are not a boundary for a shallower one', () => {
    const content = '# A\n### C\nnested\n## B\nkeep';
    const result = replaceSection(content, 'A', 'flat');
    assert.equal(result, '# A\nflat');
  });

  test('throws when heading not found', () => {
    assert.throws(() => replaceSection('# A\ntext', 'Missing', 'x'), /not found/i);
  });

  test('throws with match list when heading is ambiguous', () => {
    const content = '# Dup\na\n## Sub\nb\n# Dup\nc';
    assert.throws(() => replaceSection(content, 'Dup', 'x'), err => {
      assert.match(err.message, /ambiguous/i);
      assert.match(err.message, /line 1/);
      assert.match(err.message, /line 5/);
      return true;
    });
  });

  test('occurrence disambiguates a repeated heading', () => {
    const content = '# Dup\na\n# Dup\nb';
    const result = replaceSection(content, 'Dup', 'z', 2);
    assert.equal(result, '# Dup\na\n# Dup\nz');
  });

  test('throws on out-of-range occurrence', () => {
    const content = '# Dup\na\n# Dup\nb';
    assert.throws(() => replaceSection(content, 'Dup', 'z', 5), /occurrence/i);
  });

  test('occurrence 0 is rejected, not silently treated as "unset"', () => {
    const content = '# Dup\na\n# Dup\nb';
    assert.throws(() => replaceSection(content, 'Dup', 'z', 0), /invalid occurrence/i);
  });

  test('a negative or fractional occurrence is rejected', () => {
    const content = '# A\ntext';
    assert.throws(() => replaceSection(content, 'A', 'z', -1), /invalid occurrence/i);
    assert.throws(() => replaceSection(content, 'A', 'z', 1.5), /invalid occurrence/i);
  });

  test('a fenced heading-looking line is not a section boundary, so the real section consumes it', () => {
    const content = '# A\nold\n```\n# A\n```\nkeep';
    const result = replaceSection(content, 'A', 'new');
    assert.equal(result, '# A\nnew');
  });

  test('leaves the heading line itself untouched', () => {
    const content = '## Exact Heading\nold body';
    const result = replaceSection(content, 'Exact Heading', 'new body');
    assert.ok(result.startsWith('## Exact Heading\n'));
  });
});

describe('deleteSection', () => {
  test('removes the heading line and its body up to the next same-or-shallower heading', () => {
    const content = '# A\nkeep\n# B\ngone\n# C\nkeep';
    const result = deleteSection(content, 'B');
    assert.equal(result, '# A\nkeep\n# C\nkeep');
  });

  test('removes a heading and its nested subsections when it is at EOF', () => {
    const content = '# A\nkeep\n## B\nnested\ntext';
    const result = deleteSection(content, 'B');
    assert.equal(result, '# A\nkeep');
  });

  test('removing the only heading leaves the remainder empty', () => {
    const content = '# A\nbody';
    const result = deleteSection(content, 'A');
    assert.equal(result, '');
  });

  test('throws when heading not found', () => {
    assert.throws(() => deleteSection('# A\ntext', 'Missing'), /not found/i);
  });

  test('throws with match list when heading is ambiguous', () => {
    const content = '# Dup\na\n# Dup\nb';
    assert.throws(() => deleteSection(content, 'Dup'), err => {
      assert.match(err.message, /ambiguous/i);
      assert.match(err.message, /line 1/);
      assert.match(err.message, /line 3/);
      return true;
    });
  });

  test('occurrence disambiguates a repeated heading', () => {
    const content = '# Dup\na\n# Dup\nb\n# Z\nkeep';
    const result = deleteSection(content, 'Dup', 2);
    assert.equal(result, '# Dup\na\n# Z\nkeep');
  });

  test('throws on out-of-range occurrence', () => {
    const content = '# Dup\na\n# Dup\nb';
    assert.throws(() => deleteSection(content, 'Dup', 5), /occurrence/i);
  });
});

describe('findCheckboxes', () => {
  test('parses unchecked and checked boxes with line numbers', () => {
    const content = '- [ ] todo one\n- [x] done one\ntext\n- [X] done two';
    assert.deepEqual(findCheckboxes(content), [
      { text: 'todo one', checked: false, line: 1 },
      { text: 'done one', checked: true, line: 2 },
      { text: 'done two', checked: true, line: 4 },
    ]);
  });

  test('handles asterisk bullets and indentation', () => {
    const content = '  * [ ] indented task';
    assert.deepEqual(findCheckboxes(content), [
      { text: 'indented task', checked: false, line: 1 },
    ]);
  });

  test('returns empty array when there are no checkboxes', () => {
    assert.deepEqual(findCheckboxes('- plain bullet\ntext'), []);
  });

  test('ignores checkbox-looking lines inside a fenced code block', () => {
    const content = '- [ ] real\n```\n- [ ] fake\n```\n- [x] also real';
    assert.deepEqual(findCheckboxes(content).map(b => b.text), ['real', 'also real']);
  });
});

describe('toggleCheckbox', () => {
  test('flips an unchecked box to checked when checked is omitted', () => {
    const result = toggleCheckbox('- [ ] task', 'task');
    assert.equal(result, '- [x] task');
  });

  test('flips a checked box to unchecked when checked is omitted', () => {
    const result = toggleCheckbox('- [x] task', 'task');
    assert.equal(result, '- [ ] task');
  });

  test('sets explicit checked state true', () => {
    const result = toggleCheckbox('- [ ] task', 'task', true);
    assert.equal(result, '- [x] task');
  });

  test('sets explicit checked state false (no-op on already-unchecked box)', () => {
    const result = toggleCheckbox('- [ ] task', 'task', false);
    assert.equal(result, '- [ ] task');
  });

  test('only touches the matched line', () => {
    const content = '- [ ] one\n- [ ] two';
    const result = toggleCheckbox(content, 'two');
    assert.equal(result, '- [ ] one\n- [x] two');
  });

  test('throws when task text not found', () => {
    assert.throws(() => toggleCheckbox('- [ ] task', 'missing'), /not found/i);
  });

  test('throws with match list when task text is ambiguous', () => {
    const content = '- [ ] dup\n- [x] dup';
    assert.throws(() => toggleCheckbox(content, 'dup'), err => {
      assert.match(err.message, /ambiguous/i);
      assert.match(err.message, /line 1/);
      assert.match(err.message, /line 2/);
      return true;
    });
  });

  test('occurrence disambiguates a repeated task', () => {
    const content = '- [ ] dup\n- [ ] dup';
    const result = toggleCheckbox(content, 'dup', undefined, 2);
    assert.equal(result, '- [ ] dup\n- [x] dup');
  });

  test('throws on out-of-range occurrence', () => {
    const content = '- [ ] dup\n- [ ] dup';
    assert.throws(() => toggleCheckbox(content, 'dup', undefined, 5), /occurrence/i);
  });

  test('occurrence 0 is rejected, not silently treated as "unset"', () => {
    const content = '- [ ] dup\n- [ ] dup';
    assert.throws(() => toggleCheckbox(content, 'dup', undefined, 0), /invalid occurrence/i);
  });

  test('a negative or fractional occurrence is rejected', () => {
    assert.throws(() => toggleCheckbox('- [ ] task', 'task', undefined, -1), /invalid occurrence/i);
    assert.throws(() => toggleCheckbox('- [ ] task', 'task', undefined, 1.5), /invalid occurrence/i);
  });
});

describe('line endings', () => {
  test('findHeadings recognises headings in a CRLF note and keeps the text clean', () => {
    const headings = findHeadings('# A\r\nold\r\n## B\r\nx');
    assert.deepEqual(headings.map(h => [h.text, h.level, h.line]), [['A', 1, 1], ['B', 2, 3]]);
  });

  test('replaceSection writes the new body with the note\'s own line ending', () => {
    const result = replaceSection('# A\r\nold\r\n# B\r\nx', 'A', 'new\nline');
    assert.equal(result, '# A\r\nnew\r\nline\r\n# B\r\nx');
  });

  test('replaceSection leaves a body with no line breaks alone in a CRLF note', () => {
    assert.equal(replaceSection('# A\r\nold\r\n# B', 'A', 'new'), '# A\r\nnew\r\n# B');
  });

  test('deleteSection works on a CRLF note', () => {
    assert.equal(deleteSection('# A\r\nkeep\r\n# B\r\ngone\r\n# C\r\nkeep', 'B'), '# A\r\nkeep\r\n# C\r\nkeep');
  });

  test('toggleCheckbox works on a CRLF note', () => {
    assert.equal(toggleCheckbox('- [ ] a\r\n- [ ] b', 'a'), '- [x] a\r\n- [ ] b');
  });

  test('a fenced block in a CRLF note still hides its headings', () => {
    assert.equal(findHeadings('```\r\n# not\r\n```\r\n# Real').length, 1);
  });
});

describe('replaceSection keeps the blank lines after the section', () => {
  test('a single blank line before the next heading is kept', () => {
    assert.equal(replaceSection('# A\nold\n\n# B\nx', 'A', 'new'), '# A\nnew\n\n# B\nx');
  });

  test('several blank lines are kept as they were', () => {
    assert.equal(replaceSection('# A\nold\n\n\n# B', 'A', 'new'), '# A\nnew\n\n\n# B');
  });

  test('a trailing newline in the new content does not add a blank line', () => {
    assert.equal(replaceSection('# A\nold\n\n# B\nx', 'A', 'new\n'), '# A\nnew\n\n# B\nx');
    assert.equal(replaceSection('# A\nold\n# B\nx', 'A', 'new\n\n'), '# A\nnew\n# B\nx');
  });

  test('no blank line is invented where there was none', () => {
    assert.equal(replaceSection('# A\nold\n# B', 'A', 'new'), '# A\nnew\n# B');
  });

  test('the file\'s final newline survives replacing the last section', () => {
    assert.equal(replaceSection('# A\nold\n', 'A', 'new'), '# A\nnew\n');
  });

  test('an empty body leaves the heading followed by whatever blank lines it had', () => {
    assert.equal(replaceSection('# A\nold\n\n# B', 'A', ''), '# A\n\n# B');
    assert.equal(replaceSection('# A\nold\n# B', 'A', ''), '# A\n# B');
  });

  test('blank lines inside the new content are kept', () => {
    assert.equal(replaceSection('# A\nold\n\n# B', 'A', 'one\n\ntwo'), '# A\none\n\ntwo\n\n# B');
  });
});

describe('outlineSections', () => {
  const NOTE = '# A\nx\n## B\ny\n\n# A\nz';

  test('reports totals for the note', () => {
    const o = outlineSections(NOTE);
    assert.equal(o.chars, NOTE.length);
    assert.equal(o.lines, 7);
  });

  test('lists headings in order with level, line range, size and occurrence', () => {
    const o = outlineSections(NOTE);
    assert.deepEqual(o.headings, [
      { text: 'A', level: 1, line: 1, endLine: 4, chars: 12, occurrence: 1, total: 2 },
      { text: 'B', level: 2, line: 3, endLine: 4, chars: 6, occurrence: 1, total: 1 },
      { text: 'A', level: 1, line: 6, endLine: 7, chars: 5, occurrence: 2, total: 2 },
    ]);
  });

  test('a section\'s size includes its sub-sections and excludes trailing blank lines', () => {
    const o = outlineSections('# A\nbody\n## Sub\nmore\n\n\n# Z\nend');
    assert.equal(o.headings[0].chars, '# A\nbody\n## Sub\nmore'.length);
    assert.equal(o.headings[0].endLine, 4);
  });

  test('headings inside fenced code are not listed', () => {
    assert.deepEqual(outlineSections('```\n# not\n```\n# Real').headings.map(h => h.text), ['Real']);
  });

  test('a note with no headings has an empty list', () => {
    assert.deepEqual(outlineSections('just text\nmore').headings, []);
  });

  test('an empty note has no lines', () => {
    assert.deepEqual(outlineSections(''), { chars: 0, lines: 0, headings: [] });
  });

  test('a trailing newline does not count as a line', () => {
    assert.equal(outlineSections('# A\nx\n').lines, 2);
  });
});

describe('readSection', () => {
  const NOTE = '# A\nx\n## B\ny\n\n# A\nz\n';

  test('returns the heading line and the content, sub-sections included', () => {
    assert.equal(readSection(NOTE, 'A', 1), '# A\nx\n## B\ny');
  });

  test('returns a nested section on its own', () => {
    assert.equal(readSection(NOTE, 'B'), '## B\ny');
  });

  test('occurrence picks among repeated headings', () => {
    assert.equal(readSection(NOTE, 'A', 2), '# A\nz');
  });

  test('an ambiguous heading without an occurrence lists the matches, as edit-note does', () => {
    assert.throws(() => readSection(NOTE, 'A'), err => {
      assert.match(err.message, /ambiguous/i);
      assert.match(err.message, /line 1/);
      assert.match(err.message, /line 6/);
      return true;
    });
  });

  test('an unknown heading is an error', () => {
    assert.throws(() => readSection(NOTE, 'Nope'), /not found/i);
  });

  test('a bad occurrence is an error', () => {
    assert.throws(() => readSection(NOTE, 'A', 0), /invalid occurrence/i);
    assert.throws(() => readSection(NOTE, 'A', 3), /invalid occurrence/i);
  });

  test('the size in the outline is the length of what readSection returns', () => {
    for (const h of outlineSections(NOTE).headings) {
      assert.equal(readSection(NOTE, h.text, h.occurrence).length, h.chars);
    }
  });

  test('works on a CRLF note', () => {
    assert.equal(readSection('# A\r\nx\r\n# B\r\ny', 'A'), '# A\r\nx');
  });
});
