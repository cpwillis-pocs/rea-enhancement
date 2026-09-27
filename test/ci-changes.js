'use strict';
// Which CI jobs a PR needs, from the files it changes (read from stdin, one per line). Prints
// GitHub Actions outputs: unit=true|false, e2e=true|false, nodes=<JSON list of Node versions>.
//   docs only (Markdown, docs/, LICENSE, issue/PR templates)  -> neither job
//   only unit tests / shapes / versions record               -> unit (all Nodes), no e2e
//   only e2e tests                                            -> e2e, unit on Node 20 only
//   anything else (the script, package.json, CI, helpers, lint) -> everything
const DOCS = /(\.md$|^docs\/|^LICENSE$|^\.github\/ISSUE_TEMPLATE\/|^\.github\/pull_request_template\.md$)/;
const UNIT_ONLY = /^test\/([^/]+\.test\.js|shapes\/.+|versions\.json)$/;
const E2E_ONLY = /^test\/e2e\/(?!fixtures\.js$)/; // fixtures are shared with unit tests
const ALL_NODES = [20, 22, 24];

const classify = (files) => {
  const code = files.map((f) => f.trim()).filter(Boolean).filter((f) => !DOCS.test(f));
  if (!code.length) return { unit: false, e2e: false, nodes: ALL_NODES };
  if (code.every((f) => UNIT_ONLY.test(f))) return { unit: true, e2e: false, nodes: ALL_NODES };
  if (code.every((f) => E2E_ONLY.test(f))) return { unit: true, e2e: true, nodes: [20] };
  return { unit: true, e2e: true, nodes: ALL_NODES };
};

if (require.main === module) {
  const out = classify(require('fs').readFileSync(0, 'utf8').split('\n'));
  process.stdout.write(`unit=${out.unit}\ne2e=${out.e2e}\nnodes=${JSON.stringify(out.nodes)}\n`);
}
module.exports = { classify };
