import { Window } from 'happy-dom';
import { buildSnapshotFromDocument } from '../extension/content-core.module.js';

function makeFixture() {
  const nav = Array.from({ length: 30 }, (_, i) => `<a href="/nav/${i}">Navigation item ${i}</a>`).join('\n');
  const filters = Array.from(
    { length: 40 },
    (_, i) => `<label>Filter ${i}<input placeholder="Filter ${i}" value="value ${i}" /></label>`
  ).join('\n');
  const cards = Array.from(
    { length: 120 },
    (_, i) => `
      <article>
        <h2>Result card ${i}</h2>
        <p>${'Verbose descriptive copy for benchmark comparison. '.repeat(10)}</p>
        <button aria-label="Open result ${i}">Open</button>
        <a href="/result/${i}">Details for result ${i}</a>
      </article>`
  ).join('\n');

  return `
    <title>Compact snapshot benchmark fixture</title>
    <header><h1>Benchmark Page</h1><p>${'Header content '.repeat(80)}</p></header>
    <nav>${nav}</nav>
    <main>
      <form aria-label="Search filters">${filters}</form>
      <section aria-label="Results">${cards}</section>
    </main>
    <footer>${'Footer legal copy '.repeat(120)}</footer>
  `;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

const window = new Window({ url: 'https://example.test/benchmark' });
window.document.write(makeFixture());
const document = window.document;

const compact = buildSnapshotFromDocument(document, { mode: 'compact' });
const scopedCompact = buildSnapshotFromDocument(document, { mode: 'compact', scope: 'main' });
const full = buildSnapshotFromDocument(document, { mode: 'full' });
const compactBytes = byteLength(compact);
const scopedCompactBytes = byteLength(scopedCompact);
const fullBytes = byteLength(full);
const reduction = 1 - compactBytes / fullBytes;
const scopedReduction = 1 - scopedCompactBytes / fullBytes;

const result = {
  compactBytes,
  scopedCompactBytes,
  fullBytes,
  reductionPercent: Number((reduction * 100).toFixed(2)),
  scopedReductionPercent: Number((scopedReduction * 100).toFixed(2)),
  compactElements: compact.elements.length,
  scopedCompactElements: scopedCompact.elements.length,
  fullElements: full.elements.length,
  compactOmittedElements: compact.omittedElements,
  scopedCompactOmittedElements: scopedCompact.omittedElements,
  fullOmittedElements: full.omittedElements,
  scopedCompactScopeApplied: scopedCompact.scopeApplied
};

console.log(JSON.stringify(result, null, 2));
if (reduction < 0.5) {
  console.error(`Compact snapshot reduction ${result.reductionPercent}% is below required 50%.`);
  process.exit(1);
}
