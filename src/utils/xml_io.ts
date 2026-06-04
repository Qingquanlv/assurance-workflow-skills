/**
 * Minimal XML parser wrapper using the built-in xml2js package.
 * Falls back to a manual regex approach for simple JUnit XML if xml2js is unavailable.
 */
import { execSync } from 'child_process';

// We use xml2js if available, otherwise a lightweight fallback.
let xml2js: typeof import('xml2js') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  xml2js = require('xml2js');
} catch {
  xml2js = null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseXml(xmlContent: string): any {
  if (xml2js) {
    let result: unknown;
    // xml2js.parseString is callback-based; we use parseStringPromise or sync variant
    // Use the synchronous parseString with a callback hack
    let err: Error | null = null;
    xml2js.parseString(xmlContent, { explicitArray: false, mergeAttrs: false }, (e, r) => {
      err = e;
      result = r;
    });
    if (err) throw err;
    return result;
  }

  // Lightweight fallback: enough to extract testcase attributes from JUnit XML
  return parseJunitFallback(xmlContent);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseJunitFallback(xml: string): any {
  const testcases: Record<string, unknown>[] = [];

  const tcRe = /<testcase([^>]*)>([\s\S]*?)<\/testcase>|<testcase([^/]*?)\/>/g;
  let m: RegExpExecArray | null;

  while ((m = tcRe.exec(xml)) !== null) {
    const attrsStr = m[1] ?? m[3] ?? '';
    const inner = m[2] ?? '';
    const attrs = parseAttrs(attrsStr);
    const tc: Record<string, unknown> = { $: attrs };

    const failureMatch = /<failure([^>]*)>([\s\S]*?)<\/failure>/i.exec(inner);
    if (failureMatch) {
      const fAttrs = parseAttrs(failureMatch[1]);
      tc.failure = { ...fAttrs, _: failureMatch[2].trim() };
    }
    const errorMatch = /<error([^>]*)>([\s\S]*?)<\/error>/i.exec(inner);
    if (errorMatch) {
      const eAttrs = parseAttrs(errorMatch[1]);
      tc.error = { ...eAttrs, _: errorMatch[2].trim() };
    }
    const skippedMatch = /<skipped([^>]*)(?:>([\s\S]*?)<\/skipped>|\/>)/i.exec(inner);
    if (skippedMatch) {
      const sAttrs = parseAttrs(skippedMatch[1]);
      tc.skipped = { ...sAttrs, _: (skippedMatch[2] ?? '').trim() };
    }

    testcases.push(tc);
  }

  return { testsuites: { testsuite: { testcase: testcases } } };
}

function parseAttrs(str: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    result[m[1]] = m[2];
  }
  return result;
}

export function checkXml2jsAvailable(): boolean {
  return xml2js !== null;
}

// Installs xml2js if missing (best-effort, only called explicitly)
export function ensureXml2js(): void {
  if (xml2js !== null) return;
  try {
    execSync('npm install xml2js @types/xml2js --save 2>/dev/null', { stdio: 'inherit' });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    xml2js = require('xml2js');
  } catch {
    // fallback will be used
  }
}
