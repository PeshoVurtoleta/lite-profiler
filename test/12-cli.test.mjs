import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    Profiler, TimelineRecorder, encodeCapture, encodeTimelineCapture,
    decodeCapture, summarizeCapture, checkRegression
} from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'Litecap.mjs');

let now = 0;
const realNow = performance.now;

/** Build a capture of 8 frames, each `frameMs` long, one phase 'physics'. */
function buildCapture(frameMs) {
    performance.now = () => now;
    const p = new Profiler(64, ['physics']);
    now = 1000;
    for (let f = 0; f < 8; f++) {
        p.beginFrame(); p.begin('physics'); p.end('physics');
        now += frameMs; p.endFrame();
        now += 1;
    }
    const buf = encodeCapture(p, null, { label: 'cap' });
    p.destroy();
    performance.now = realNow;
    return Buffer.from(buf);
}

/** Build a v4 timeline-only capture (one span lane, one instant lane). */
function buildV4Capture() {
    const BIG = 3_600_000;
    const tr = new TimelineRecorder(16, ['work'], ['gc']);
    for (let f = 0; f < 3; f++) {
        tr.recordFrameBoundary(BIG + f * 16);
        tr.beginSpan('work', BIG + f * 16 + 1); tr.endSpan('work', BIG + f * 16 + 4);
        tr.mark('gc', BIG + f * 16 + 8);
    }
    const buf = encodeTimelineCapture(tr, { label: 'tl' });
    tr.destroy();
    return Buffer.from(buf);
}

/** A hand-built, structurally valid v2 capture with ZERO frames. */
function buildEmptyCapture() {
    const b = new ArrayBuffer(14);
    const v = new DataView(b);
    v.setUint8(0, 0x4C); v.setUint8(1, 0x43); v.setUint8(2, 0x41); v.setUint8(3, 0x50); // LCAP
    v.setUint8(4, 2);          // version 2
    v.setUint32(5, 0, true);   // count 0
    v.setUint8(9, 0);          // numPhases 0
    v.setUint32(10, 0, true);  // meta length 0
    return Buffer.from(b);
}

function run(...args) {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

let dir;
const P = (name) => join(dir, name);

before(() => {
    dir = mkdtempSync(join(tmpdir(), 'litecap-cli-'));
    writeFileSync(P('base.litecap'), buildCapture(16));
    writeFileSync(P('same.litecap'), buildCapture(16));   // identical -> gate pass
    writeFileSync(P('slow.litecap'), buildCapture(24));   // +50% avg -> gate fail
    writeFileSync(P('empty.litecap'), buildEmptyCapture());
    writeFileSync(P('v4.litecap'), buildV4Capture());
    writeFileSync(P('garbage.litecap'), Buffer.from('not a capture at all'));
});
after(() => { rmSync(dir, { recursive: true, force: true }); });

describe('litecap CLI', () => {
    it('inspect: exits 0 and reports version + frame count', () => {
        const r = run('inspect', P('base.litecap'));
        assert.equal(r.code, 0);
        assert.match(r.out, /LiteCap v2/);
        assert.match(r.out, /8 frames/);
    });

    it('inspect --format json: emits a parseable envelope', () => {
        const r = run('inspect', '--format', 'json', P('base.litecap'));
        assert.equal(r.code, 0);
        const env = JSON.parse(r.out);
        assert.equal(env.version, 2);
        assert.equal(env.frames, 8);
        assert.deepEqual(env.phases, ['physics']);
    });

    it('summarize: exits 0 and the json round-trips the in-process summary', () => {
        const r = run('summarize', '--format', 'json', P('base.litecap'));
        assert.equal(r.code, 0);
        const cliSummary = JSON.parse(r.out);
        const apiSummary = summarizeCapture(decodeCapture(readFileSync(P('base.litecap'))));
        assert.equal(cliSummary.frameCount, apiSummary.frameCount);
        assert.equal(cliSummary.frame.avg, apiSummary.frame.avg);
    });

    it('diff: exits 0 and reports the per-metric delta', () => {
        const r = run('diff', '--format', 'json', P('base.litecap'), P('slow.litecap'));
        assert.equal(r.code, 0);
        const d = JSON.parse(r.out);
        assert.ok(d.frame.avg.cand > d.frame.avg.base);
    });

    it('gate pass: identical captures exit 0', () => {
        const r = run('gate', P('base.litecap'), P('same.litecap'));
        assert.equal(r.code, 0);
        assert.match(r.out, /PASS/);
    });

    it('gate fail: a +50% regression exits 1', () => {
        const r = run('gate', P('base.litecap'), P('slow.litecap'));
        assert.equal(r.code, 1);
        assert.match(r.out, /FAIL/);
    });

    it('gate inconclusive: an empty capture exits 2 (not 0, not 1)', () => {
        const r = run('gate', P('base.litecap'), P('empty.litecap'));
        assert.equal(r.code, 2);
        assert.match(r.out, /INCONCLUSIVE/);
    });

    it('gate inconclusive: a tolerance metric absent in both exits 2', () => {
        const cfg = P('tol.json');
        writeFileSync(cfg, JSON.stringify({ tolerances: { 'phase.nonexistent.avg': 0.1 } }));
        const r = run('gate', '--config', cfg, P('base.litecap'), P('same.litecap'));
        assert.equal(r.code, 2);
    });

    it('gate verdict == in-process checkRegression (CLI is not a second implementation, DP2d)', () => {
        const bs = summarizeCapture(decodeCapture(readFileSync(P('base.litecap'))));
        const cs = summarizeCapture(decodeCapture(readFileSync(P('slow.litecap'))));
        const api = checkRegression(bs, cs);          // DEFAULT_TOLERANCES
        const cli = run('gate', '--format', 'json', P('base.litecap'), P('slow.litecap'));
        const env = JSON.parse(cli.out);
        assert.equal(env.verdict, api.ok ? 'pass' : 'fail');
        assert.equal(cli.code, api.ok ? 0 : 1);
        assert.deepEqual(
            env.regressions.map((r) => r.metric).sort(),
            api.regressions.map((r) => r.metric).sort()
        );
    });

    it('trace: refuses a v2 capture with no timeline (exit 3)', () => {
        const refused = run('trace', P('base.litecap'));
        assert.equal(refused.code, 3);
        assert.match(refused.err, /no timeline data/);
    });

    it('trace: exports a v4 capture to stdout and to -o file (exit 0)', () => {
        const stdout = run('trace', P('v4.litecap'));
        assert.equal(stdout.code, 0);
        const trace = JSON.parse(stdout.out);
        assert.equal(trace.displayTimeUnit, 'ms');
        assert.ok(trace.traceEvents.some((e) => e.ph === 'X' && e.name === 'work'));

        const outFile = P('out.json');
        const toFile = run('trace', '-o', outFile, P('v4.litecap'));
        assert.equal(toFile.code, 0);
        assert.ok(existsSync(outFile));
        assert.match(toFile.out, /wrote \d+ trace events/);
        JSON.parse(readFileSync(outFile, 'utf8'));   // valid JSON on disk
    });

    it('infrastructure errors exit 3', () => {
        assert.equal(run('inspect', P('does-not-exist.litecap')).code, 3);
        assert.equal(run('inspect', P('garbage.litecap')).code, 3);
        assert.equal(run('bogusverb', P('base.litecap')).code, 3);
        assert.equal(run('summarize').code, 3);                       // missing path
        assert.equal(run('summarize', '--format', 'xml', P('base.litecap')).code, 3);
    });
});
