'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const JSZip = require('jszip');
const { convert } = require('../src/converter.js');
const HwpxConvert = require('../src/hwpx-convert.js');

const DEPS = { JSZip, DOMParser, XMLSerializer, convert };

const FIXTURE = path.join(__dirname, 'fixtures', 'sample.hwpx');
const PY_REFERENCE = path.join(__dirname, 'fixtures', 'sample_py_out.hwpx');

async function blobToBuffer(blob) {
  if (blob && typeof blob.arrayBuffer === 'function') {
    return Buffer.from(await blob.arrayBuffer());
  }
  return Buffer.from(blob); // Uint8Array fallback
}

async function makeMiniHwpx(sectionXml) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });
  zip.file('Contents/section0.xml', sectionXml, { compression: 'DEFLATE' });
  const u8 = await zip.generateAsync({ type: 'uint8array' });
  return Buffer.from(u8);
}

async function readScripts(zipBuffer) {
  const zip = await JSZip.loadAsync(zipBuffer);
  const names = Object.keys(zip.files)
    .filter((n) => n.startsWith('Contents/section') && n.endsWith('.xml'))
    .sort();
  const scripts = [];
  for (const n of names) {
    const xml = await zip.file(n).async('string');
    const re = /<hp:script>([\s\S]*?)<\/hp:script>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      scripts.push(decodeEntities(m[1]));
    }
  }
  return scripts;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

test('변환 엔진 sanity: frac → over', () => {
  assert.strictEqual(convert('$$\\frac{a}{b}$$'), '{a} over {b}');
});

test('숫자 달러 판별: $100$ 은 변환 안 함, $x$ 류는 변환', () => {
  const { shouldConvertDollarBody } = HwpxConvert._internal;
  assert.strictEqual(shouldConvertDollarBody('100'), false);
  assert.strictEqual(shouldConvertDollarBody('1,000.50'), false);
  assert.strictEqual(shouldConvertDollarBody('x^2'), true);
  assert.strictEqual(shouldConvertDollarBody('abc'), true);
  // 글자+프라임 짧은 수식: S', x' (상대론 관성계/축) 도 변환 대상
  assert.strictEqual(shouldConvertDollarBody("S'"), true);
  assert.strictEqual(shouldConvertDollarBody("x'"), true);
  assert.strictEqual(shouldConvertDollarBody("S''"), true);
  assert.strictEqual(shouldConvertDollarBody("it's"), false); // 프라임형 아닌 일반 어포스트로피는 제외
});

test('ID 생성기: 기존 최대 id+1 부터, 최소 1000000', () => {
  const { makeIdGenerator } = HwpxConvert._internal;
  const g1 = makeIdGenerator(new Set(['5', '1685648523', '997662250']));
  assert.strictEqual(g1.next(), '1685648524');
  const g2 = makeIdGenerator(new Set(['3', '7']));
  assert.strictEqual(g2.next(), '1000000');
});

test('LaTeX 구간 탐지: 4종 구분자 + 숫자 달러 skip', () => {
  const { findLatexSpans } = HwpxConvert._internal;
  const stats = { skippedNumericDollars: 0 };
  const text = '분수 $$\\frac{a}{b}$$ 인라인 $x^2$ 가격 $100$ 블록 \\[a+b\\] 인라 \\(c\\)';
  const spans = findLatexSpans(text, stats);
  assert.strictEqual(spans.length, 4, '수식 구간 4개');
  assert.strictEqual(stats.skippedNumericDollars, 1, '$100$ 한 개 skip');
});

test('E2E: 픽스처 변환 결과가 파이썬 도구 출력과 동일한 수식 script', async () => {
  const buf = fs.readFileSync(FIXTURE);
  const { blob, stats } = await HwpxConvert.convertArrayBuffer(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    DEPS
  );
  const outBuf = await blobToBuffer(blob);

  assert.strictEqual(stats.equations, 4, '수식 4개 변환');
  assert.strictEqual(stats.skippedNumericDollars, 1, '$100$ skip');
  assert.strictEqual(stats.sectionsChanged, 1, 'section 1개 변경');

  const jsScripts = await readScripts(outBuf);
  const pyScripts = await readScripts(fs.readFileSync(PY_REFERENCE));
  assert.deepStrictEqual(jsScripts, pyScripts, 'JS 변환 script == 파이썬 변환 script');
});

test('E2E: 출력 ZIP 구조 — mimetype 첫 항목 + STORED, $100$ 텍스트 보존', async () => {
  const buf = fs.readFileSync(FIXTURE);
  const { blob } = await HwpxConvert.convertArrayBuffer(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    DEPS
  );
  const outBuf = await blobToBuffer(blob);

  // mimetype 위치/압축 확인은 raw ZIP 헤더로 검사
  // (Local File Header: 시그니처 PK\x03\x04, offset 8~9 = 압축방식, 30~ = 파일명)
  assert.strictEqual(outBuf.readUInt32LE(0), 0x04034b50, 'ZIP local header 시그니처');
  const firstNameLen = outBuf.readUInt16LE(26);
  const firstName = outBuf.slice(30, 30 + firstNameLen).toString('utf8');
  assert.strictEqual(firstName, 'mimetype', '첫 항목은 mimetype');
  const firstCompression = outBuf.readUInt16LE(8);
  assert.strictEqual(firstCompression, 0, 'mimetype은 STORED(0)');

  const zip = await JSZip.loadAsync(outBuf);
  const mimetype = await zip.file('mimetype').async('string');
  assert.match(mimetype, /hwp/i, 'mimetype 내용 보존');

  const section0 = await zip.file('Contents/section0.xml').async('string');
  assert.ok(section0.includes('$100$'), '$100$ 평문 보존');
  assert.ok(section0.includes('<hp:equation'), '수식 개체 생성됨');
});

test('한글 복구 경고 방지: 수정된 단락의 linesegarray 제거, 미수정 단락은 보존', async () => {
  const NS = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"';
  const sec =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<hs:sec ' + NS + '>' +
      '<hp:p id="1"><hp:run charPrIDRef="0"><hp:t>식 $x^2$ 끝</hp:t></hp:run>' +
        '<hp:linesegarray><hp:lineseg textpos="0" vertpos="0"/></hp:linesegarray></hp:p>' +
      '<hp:p id="2"><hp:run charPrIDRef="0"><hp:t>일반 문단(수식 없음)</hp:t></hp:run>' +
        '<hp:linesegarray><hp:lineseg textpos="0" vertpos="0"/></hp:linesegarray></hp:p>' +
    '</hs:sec>';
  const buf = await makeMiniHwpx(sec);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const { blob, stats } = await HwpxConvert.convertArrayBuffer(ab, DEPS);
  assert.strictEqual(stats.equations, 1, '수식 1개 변환');
  const zip = await JSZip.loadAsync(await blobToBuffer(blob));
  const xml = await zip.file('Contents/section0.xml').async('string');

  const p1 = xml.slice(xml.indexOf('id="1"'), xml.indexOf('id="2"'));
  assert.ok(p1.includes('<hp:equation'), '수정 단락에 수식 개체 생성');
  assert.ok(!p1.includes('<hp:linesegarray'), '수정 단락의 linesegarray 제거됨(복구 경고 방지)');

  const p2 = xml.slice(xml.indexOf('id="2"'));
  assert.ok(p2.includes('<hp:linesegarray'), '미수정 단락의 linesegarray는 보존');
});
