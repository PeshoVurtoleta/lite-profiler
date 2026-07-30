#!/usr/bin/env node
// @zakkster/lite-profiler CLI: litecap
//
// Inspect, summarize, diff, gate and trace-export a .litecap capture from a
// terminal with no browser. The grammar deliberately mirrors lite-gc-gate:
// verb-first, --format / --json flags, and the same exit-code contract, so a
// user who knows one CLI in the family knows this one.
//
// Usage:
//   litecap inspect   <capture>
//   litecap summarize <capture>                 [--format fmt] [--json out]
//   litecap diff      <baseline> <candidate>    [--format fmt] [--json out]
//   litecap gate      <baseline> <candidate>    [--config tol.json] [--format fmt] [--json out] [--allow-inconclusive]
//   litecap trace     <capture>  [-o out.json]  [--normalize]
//
// --format  console | json | markdown | github   (default: console)
// --json    <path>   also write the JSON envelope to this path
// --config  <path>   gate tolerances: { "tolerances": { "frame.p99": 0.1 } }
// -o        <path>   trace output file (default: stdout)
// --normalize        trace: zero-base timestamps to the first event
//
// Exit codes (identical to lite-gc-gate):
//   0  pass / ok
//   1  fail (a gate regression)
//   2  inconclusive (could not measure — e.g. an empty capture)
//   3  infrastructure error (file missing, bad magic, unsupported version, bad args)

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeCapture } from '../src/litecap.js';
import { summarizeCapture, diffCaptures, checkRegression, DEFAULT_TOLERANCES } from '../src/compare.js';
import { exportChromeTrace } from '../src/trace.js';

const VERBS = ['inspect', 'summarize', 'diff', 'gate', 'trace'];

function usage(err) {
    if (err) process.stderr.write('litecap: ' + err + '\n\n');
    process.stderr.write([
        'Usage:',
        '  litecap inspect   <capture>',
        '  litecap summarize <capture>              [--format fmt] [--json out]',
        '  litecap diff      <baseline> <candidate> [--format fmt] [--json out]',
        '  litecap gate      <baseline> <candidate> [--config tol.json] [--format fmt] [--json out] [--allow-inconclusive]',
        '  litecap trace     <capture> [-o out.json] [--normalize]',
        '',
        '  --format  console | json | markdown | github   (default: console)',
        '  --json    <path>   also write the JSON envelope',
        '  --config  <path>   gate tolerances { "tolerances": {...} }',
        '  -o        <path>   trace output file (default: stdout)',
        '  --normalize        trace: zero-base timestamps',
        '',
        'Exit codes: 0=pass, 1=fail, 2=inconclusive, 3=infrastructure error'
    ].join('\n') + '\n');
    process.exit(3);
}

function die3(msg) { process.stderr.write('litecap: ' + msg + '\n'); process.exit(3); }

function parseArgs(argv) {
    const verb = argv[0];
    if (!verb) usage('missing command');
    if (VERBS.indexOf(verb) === -1) usage('unknown command: ' + verb);
    const args = { verb, positionals: [], format: 'console', flags: {} };
    let i = 1;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '--format') { args.format = argv[++i]; }
        else if (a === '--json') { args.jsonOutPath = argv[++i]; }
        else if (a === '--config') { args.configPath = argv[++i]; }
        else if (a === '-o' || a === '--out') { args.out = argv[++i]; }
        else if (a === '--normalize') { args.flags.normalize = true; }
        else if (a === '--allow-inconclusive') { args.flags.allowInconclusive = true; }
        else if (a[0] === '-') usage('unknown option: ' + a);
        else args.positionals.push(a);
        i++;
    }
    const FMTS = ['console', 'json', 'markdown', 'github'];
    if (FMTS.indexOf(args.format) === -1) usage('unknown --format: ' + args.format);
    return args;
}

function readCapture(path) {
    if (!path) usage('missing <capture> path');
    let bytes;
    try { bytes = readFileSync(resolve(path)); }
    catch (e) { die3('cannot read ' + path + ': ' + e.message); }
    try { return decodeCapture(bytes); }         // Buffer is a Uint8Array view -> decodes directly
    catch (e) { die3('not a valid LiteCap (' + path + '): ' + e.message); }
}

function writeJsonSide(path, obj) {
    if (!path) return;
    try { writeFileSync(path, JSON.stringify(obj, null, 2)); }
    catch (e) { process.stderr.write('litecap: --json write failed: ' + e.message + '\n'); }
}

function num(n) { return Math.round(n * 1000) / 1000; }
function pctStr(p) { return p == null ? 'n/a' : (p >= 0 ? '+' : '') + (p * 100).toFixed(1) + '%'; }

// ---- inspect ---------------------------------------------------------------

function cmdInspect(args) {
    const d = readCapture(args.positionals[0]);
    const spanLanes = (d.spanTags || []).map((t, l) => ({ tag: t, samples: d.spanT0[l] ? d.spanT0[l].length : 0 }));
    const instLanes = (d.instantTags || []).map((t, l) => ({ tag: t, samples: d.instantTimes[l] ? d.instantTimes[l].length : 0 }));
    const envelope = {
        version: d.version, frames: d.count, numPhases: d.numPhases,
        phases: d.tags || [], counters: d.counterTags || [], meta: d.meta || null,
        timeline: d.version >= 4 ? {
            frameBoundaries: d.frameBoundaries ? d.frameBoundaries.length : 0,
            spanLanes, instantLanes: instLanes
        } : null
    };
    if (args.format === 'json') { process.stdout.write(JSON.stringify(envelope, null, 2) + '\n'); }
    else {
        const lines = [];
        lines.push('LiteCap v' + d.version + '  (' + d.count + ' frames)');
        lines.push('  phases:   ' + d.numPhases + (d.tags && d.tags.length ? '  [' + d.tags.join(', ') + ']' : ''));
        lines.push('  counters: ' + (d.counterTags ? d.counterTags.length : 0) + (d.counterTags && d.counterTags.length ? '  [' + d.counterTags.join(', ') + ']' : ''));
        lines.push('  meta:     ' + (d.meta ? JSON.stringify(d.meta) : '(none)'));
        if (d.version >= 4) {
            lines.push('  timeline:');
            lines.push('    frame boundaries: ' + (d.frameBoundaries ? d.frameBoundaries.length : 0));
            lines.push('    span lanes:       ' + spanLanes.length + (spanLanes.length ? '  [' + spanLanes.map((s) => s.tag + '(' + s.samples + ')').join(', ') + ']' : ''));
            lines.push('    instant lanes:    ' + instLanes.length + (instLanes.length ? '  [' + instLanes.map((s) => s.tag + '(' + s.samples + ')').join(', ') + ']' : ''));
        }
        process.stdout.write(lines.join('\n') + '\n');
    }
    writeJsonSide(args.jsonOutPath, envelope);
    process.exit(0);
}

// ---- summarize -------------------------------------------------------------

function cmdSummarize(args) {
    const d = readCapture(args.positionals[0]);
    const s = summarizeCapture(d);
    if (args.format === 'json') { process.stdout.write(JSON.stringify(s, null, 2) + '\n'); }
    else {
        const f = s.frame;
        const lines = [];
        lines.push((s.label || '(capture)') + '  —  ' + s.frameCount + ' frames');
        lines.push('  frame  avg ' + num(f.avg) + 'ms  p99 ' + num(f.p99) + 'ms  fps ' + num(f.fps) + '  class ' + f.frameClass);
        for (const t in s.phases) {
            const p = s.phases[t];
            if (p.count) lines.push('  phase ' + t + '  avg ' + num(p.avg) + 'ms  p99 ' + num(p.p99) + 'ms');
        }
        for (const t in s.counters) {
            const c = s.counters[t];
            if (c.count) lines.push('  counter ' + t + '  sum ' + num(c.sum) + '  avg ' + num(c.avg) + '  max ' + num(c.max));
        }
        process.stdout.write(lines.join('\n') + '\n');
    }
    writeJsonSide(args.jsonOutPath, s);
    process.exit(0);
}

// ---- diff ------------------------------------------------------------------

function cmdDiff(args) {
    const base = readCapture(args.positionals[0]);
    const cand = readCapture(args.positionals[1]);
    if (!args.positionals[1]) usage('diff needs <baseline> and <candidate>');
    const diff = diffCaptures(summarizeCapture(base), summarizeCapture(cand));
    if (args.format === 'json') { process.stdout.write(JSON.stringify(diff, null, 2) + '\n'); }
    else {
        const lines = ['diff  frame:'];
        for (const k in diff.frame) {
            const r = diff.frame[k];
            if (r && typeof r.base === 'number') lines.push('  frame.' + k + '  ' + num(r.base) + ' -> ' + num(r.cand) + '  (' + pctStr(r.pct) + ')');
        }
        for (const t in diff.phases) {
            const row = diff.phases[t];
            if (row.missing) { lines.push('  phase.' + t + '  missing in ' + row.missing); continue; }
            if (row.avg) lines.push('  phase.' + t + '.avg  ' + num(row.avg.base) + ' -> ' + num(row.avg.cand) + '  (' + pctStr(row.avg.pct) + ')');
        }
        for (const t in diff.counters) {
            const row = diff.counters[t];
            if (row.missing) { lines.push('  counter.' + t + '  missing in ' + row.missing); continue; }
            if (row.sum) lines.push('  counter.' + t + '.sum  ' + num(row.sum.base) + ' -> ' + num(row.sum.cand) + '  (' + pctStr(row.sum.pct) + ')');
        }
        process.stdout.write(lines.join('\n') + '\n');
    }
    writeJsonSide(args.jsonOutPath, diff);
    process.exit(0);
}

// ---- gate ------------------------------------------------------------------

function loadTolerances(path) {
    if (!path) return DEFAULT_TOLERANCES;
    let cfg;
    try { cfg = JSON.parse(readFileSync(resolve(path), 'utf8')); }
    catch (e) { die3('failed to load config ' + path + ': ' + e.message); }
    if (!cfg.tolerances || typeof cfg.tolerances !== 'object') die3('config ' + path + ' has no "tolerances" object');
    return cfg.tolerances;
}

// Local path reader for the MEASURABILITY probe only (DP2e). The pass/fail
// verdict itself still comes from checkRegression — this only decides whether
// anything was comparable at all, i.e. inconclusive vs a real verdict.
function readable(summary, path) {
    const p = path.split('.');
    let v;
    if (p[0] === 'frame') v = summary.frame ? summary.frame[p[1]] : undefined;
    else if (p[0] === 'phase') v = summary.phases && summary.phases[p[1]] ? summary.phases[p[1]][p[2]] : undefined;
    else if (p[0] === 'counter') v = summary.counters && summary.counters[p[1]] ? summary.counters[p[1]][p[2]] : undefined;
    return typeof v === 'number' && Number.isFinite(v);
}

function cmdGate(args) {
    if (!args.positionals[1]) usage('gate needs <baseline> and <candidate>');
    const base = readCapture(args.positionals[0]);
    const cand = readCapture(args.positionals[1]);
    const tol = loadTolerances(args.configPath);
    const bs = summarizeCapture(base);
    const cs = summarizeCapture(cand);

    // DP2e — three-state verdict. "Could not measure" is not "passed".
    let verdict, reason = null, report = null;
    if (bs.frameCount === 0 || cs.frameCount === 0) {
        verdict = 'inconclusive';
        reason = 'empty capture (baseline ' + bs.frameCount + ' frames, candidate ' + cs.frameCount + ' frames)';
    } else if (bs.schema !== cs.schema) {
        verdict = 'inconclusive';
        reason = 'summary schema mismatch (baseline ' + bs.schema + ' vs candidate ' + cs.schema + ')';
    } else {
        let anyComparable = false;
        for (const path in tol) if (readable(bs, path) && readable(cs, path)) { anyComparable = true; break; }
        if (!anyComparable) {
            verdict = 'inconclusive';
            reason = 'no configured tolerance metric is present in both captures';
        } else {
            report = checkRegression(bs, cs, tol);   // DP2d — the verdict IS the API's
            verdict = report.ok ? 'pass' : 'fail';
        }
    }

    const envelope = { verdict, reason, tolerances: tol, regressions: report ? report.regressions : [] };

    if (args.format === 'json') {
        process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
    } else if (args.format === 'github') {
        if (verdict === 'pass') process.stdout.write('::notice::litecap gate passed\n');
        else if (verdict === 'inconclusive') process.stdout.write('::warning::litecap gate inconclusive — ' + reason + '\n');
        else for (const r of envelope.regressions) process.stdout.write('::error::' + r.metric + ' ' + num(r.baseline) + ' -> ' + (r.candidate == null ? 'missing' : num(r.candidate)) + '\n');
    } else {
        const head = verdict === 'pass' ? 'PASS' : verdict === 'fail' ? 'FAIL' : 'INCONCLUSIVE';
        const lines = ['litecap gate: ' + head + (reason ? '  (' + reason + ')' : '')];
        if (args.format === 'markdown') lines[0] = '**litecap gate: ' + head + '**' + (reason ? '  (' + reason + ')' : '');
        for (const r of envelope.regressions) {
            const c = r.candidate == null ? 'missing' : num(r.candidate);
            const why = r.reason ? r.reason : (r.change === Infinity ? 'new from 0' : '+' + (r.change * 100).toFixed(1) + '%');
            lines.push('  ' + r.metric + ': ' + num(r.baseline) + ' -> ' + c + '  (' + why + ' > ' + (r.tolerance * 100).toFixed(0) + '%)');
        }
        process.stdout.write(lines.join('\n') + '\n');
    }
    writeJsonSide(args.jsonOutPath, envelope);

    if (verdict === 'pass') process.exit(0);
    if (verdict === 'fail') process.exit(1);
    process.exit(2);   // inconclusive — exit 2 regardless of --allow-inconclusive, for CI to distinguish
}

// ---- trace -----------------------------------------------------------------

function cmdTrace(args) {
    const d = readCapture(args.positionals[0]);
    let trace;
    try { trace = exportChromeTrace(d, { normalize: !!args.flags.normalize }); }
    catch (e) { die3(e.message); }
    const json = JSON.stringify(trace);
    if (args.out) {
        try { writeFileSync(resolve(args.out), json); }
        catch (e) { die3('trace write failed: ' + e.message); }
        process.stdout.write('litecap: wrote ' + trace.traceEvents.length + ' trace events to ' + args.out + '\n');
    } else {
        process.stdout.write(json + '\n');
    }
    process.exit(0);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.verb === 'inspect') cmdInspect(args);
    else if (args.verb === 'summarize') cmdSummarize(args);
    else if (args.verb === 'diff') cmdDiff(args);
    else if (args.verb === 'gate') cmdGate(args);
    else if (args.verb === 'trace') cmdTrace(args);
}

main();
