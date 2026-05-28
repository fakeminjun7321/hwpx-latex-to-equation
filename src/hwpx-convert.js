/*
 * HWPX 안의 LaTeX 수식만 한글(HWP) 수식 개체로 변환 (브라우저/Node 공용)
 *
 * 변환 엔진(LaTeX → 한글 수식 script)은 converter.js(window.LatexToHwp.convert)를 사용한다.
 * 이 모듈은 tools/hwpx_latex_to_hwp.py(파이썬)의 HWPX 처리 로직을 브라우저로 포팅한 것이다:
 *   ZIP 해제(JSZip) → Contents/section*.xml 파싱(DOMParser) → 텍스트 런에서 LaTeX 구간 탐지
 *   → <hp:equation> 개체로 치환 → 다시 ZIP 묶기(mimetype 우선·STORED 보존).
 *
 * 의존성: 전역 JSZip, DOMParser, XMLSerializer, LatexToHwp.convert
 *   (Node 테스트에서는 deps 인자로 주입 가능)
 *
 * ── 출처 표시 / 라이선스 ───────────────────────────────────────────
 * 이 파일은 latex-to-hwp 프로젝트의 파이썬 CLI(tools/hwpx_latex_to_hwp.py)
 * HWPX 처리 로직을 브라우저용으로 포팅한 2차적 저작물입니다.
 *   원저작자: Shin Mingyu (@minigu5)  ·  원본: https://github.com/minigu5/latex-to-hwp
 *   라이선스: Custom License (Non-Commercial & Attribution) — 저장소 LICENSE 참조
 * 본 결합 저작물은 변환 엔진(converter.js)을 포함·파생하므로 전체가 위 조건
 * (출처 표시 + 비영리)의 적용을 받습니다. 자세한 내용은 NOTICE 파일 참조.
 * 변환 규칙 근거: CONVERSION_RULES.md (한컴 공개 명세 revision 1.2 기반).
 */
(function (global) {
  'use strict';

  var HP_NS = 'http://www.hancom.co.kr/hwpml/2011/paragraph';

  // ── 의존성 해석 ────────────────────────────────────────────────
  function resolveDeps(deps) {
    deps = deps || {};
    var JSZipLib = deps.JSZip || global.JSZip;
    var DOMParserCls = deps.DOMParser || global.DOMParser;
    var XMLSerializerCls = deps.XMLSerializer || global.XMLSerializer;
    var convert = deps.convert ||
      (global.LatexToHwp && global.LatexToHwp.convert) ||
      (typeof require !== 'undefined' ? safeRequireConverter() : null);
    if (!JSZipLib) throw new Error('JSZip를 찾을 수 없습니다.');
    if (!DOMParserCls) throw new Error('DOMParser를 찾을 수 없습니다.');
    if (!XMLSerializerCls) throw new Error('XMLSerializer를 찾을 수 없습니다.');
    if (typeof convert !== 'function') throw new Error('LatexToHwp.convert를 찾을 수 없습니다.');
    return { JSZip: JSZipLib, DOMParser: DOMParserCls, XMLSerializer: XMLSerializerCls, convert: convert };
  }
  function safeRequireConverter() {
    try { return require('./converter.js').convert; } catch (e) { return null; }
  }

  // ── 스타일 (파이썬 EquationStyle 기본값) ───────────────────────
  function defaultStyle() {
    return { baseUnit: 1000, textColor: '#000000', lineThickness: 100, letterSpacing: 0 };
  }

  // ── ID 생성기 (파이썬 IdGenerator) ─────────────────────────────
  function collectUsedIds(xmlStrings) {
    var used = new Set();
    var re = /\bid="(\d+)"/g;
    for (var i = 0; i < xmlStrings.length; i++) {
      var s = xmlStrings[i], m;
      re.lastIndex = 0;
      while ((m = re.exec(s)) !== null) used.add(m[1]);
    }
    return used;
  }
  function makeIdGenerator(used, start) {
    if (start == null) start = 1000000;
    var next = start - 1;
    used.forEach(function (v) {
      var n = parseInt(v, 10);
      if (!isNaN(n) && /^\d+$/.test(v) && n > next) next = n;
    });
    next += 1;
    return {
      next: function () {
        while (used.has(String(next))) next++;
        var val = String(next);
        used.add(val);
        next++;
        return val;
      }
    };
  }

  // ── LaTeX 구간 탐지 (파이썬 find_latex_spans 등 그대로 포팅) ────
  function isEscaped(text, index) {
    var backslashes = 0, cursor = index - 1;
    while (cursor >= 0 && text[cursor] === '\\') { backslashes++; cursor--; }
    return backslashes % 2 === 1;
  }
  function findUnescapedMarker(text, marker, start) {
    var cursor = start;
    while (true) {
      var index = text.indexOf(marker, cursor);
      if (index < 0) return -1;
      if (!isEscaped(text, index)) return index;
      cursor = index + marker.length;
    }
  }
  function findSingleDollarClose(text, start) {
    var cursor = start;
    while (true) {
      var index = text.indexOf('$', cursor);
      if (index < 0) return -1;
      if (isEscaped(text, index)) { cursor = index + 1; continue; }
      if (index + 1 < text.length && text[index + 1] === '$') { cursor = index + 2; continue; }
      if (index > 0 && text[index - 1] === '$') { cursor = index + 1; continue; }
      return index;
    }
  }
  function shouldConvertDollarBody(body) {
    var value = body.trim();
    if (!value) return false;
    if (/^\d[\d,]*(?:\.\d+)?$/.test(value)) return false;
    if (/\\[A-Za-z]+|[_^{}=<>]|[+\-*\/|]/.test(value)) return true;
    if (/[A-Za-z]\d|\d[A-Za-z]/.test(value)) return true;
    if (/^[A-Za-z]{1,3}$/.test(value)) return true;
    // 글자+프라임 형태의 짧은 수식 (S', x', S'' 등). 상대론의 S′·x′ 관성계처럼
    // 인라인 $S'$ 가 평문으로 남지 않도록 한다. (원본 파이썬 휴리스틱에서 보강)
    if (/^[A-Za-z]{1,3}['′’]+$/.test(value)) return true;
    return false;
  }
  function findLatexSpans(text, stats) {
    var spans = [];
    var cursor = 0, n = text.length;
    while (cursor < n) {
      if (text.startsWith('$$', cursor) && !isEscaped(text, cursor)) {
        var e1 = findUnescapedMarker(text, '$$', cursor + 2);
        if (e1 >= 0 && text.slice(cursor + 2, e1).trim()) {
          spans.push({ start: cursor, end: e1 + 2, raw: text.slice(cursor, e1 + 2) });
          cursor = e1 + 2; continue;
        }
      }
      if (text.startsWith('\\[', cursor) && !isEscaped(text, cursor)) {
        var e2 = findUnescapedMarker(text, '\\]', cursor + 2);
        if (e2 >= 0 && text.slice(cursor + 2, e2).trim()) {
          spans.push({ start: cursor, end: e2 + 2, raw: text.slice(cursor, e2 + 2) });
          cursor = e2 + 2; continue;
        }
      }
      if (text.startsWith('\\(', cursor) && !isEscaped(text, cursor)) {
        var e3 = findUnescapedMarker(text, '\\)', cursor + 2);
        if (e3 >= 0 && text.slice(cursor + 2, e3).trim()) {
          spans.push({ start: cursor, end: e3 + 2, raw: text.slice(cursor, e3 + 2) });
          cursor = e3 + 2; continue;
        }
      }
      if (text[cursor] === '$' && !isEscaped(text, cursor)) {
        if (cursor + 1 < n && text[cursor + 1] === '$') { cursor += 1; continue; }
        var e4 = findSingleDollarClose(text, cursor + 1);
        if (e4 >= 0) {
          var body = text.slice(cursor + 1, e4);
          if (shouldConvertDollarBody(body)) {
            spans.push({ start: cursor, end: e4 + 1, raw: text.slice(cursor, e4 + 1) });
          } else {
            stats.skippedNumericDollars++;
          }
          cursor = e4 + 1; continue;
        }
      }
      cursor += 1;
    }
    return spans;
  }

  // ── DOM 헬퍼 ───────────────────────────────────────────────────
  function elementChildren(node) {
    var out = [];
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) out.push(c);
    }
    return out;
  }
  function isHp(el, local) {
    return el && el.nodeType === 1 && el.namespaceURI === HP_NS && el.localName === local;
  }
  function isPlainTextRun(el) {
    if (!isHp(el, 'run')) return false;
    var kids = elementChildren(el);
    return kids.length === 1 && isHp(kids[0], 't');
  }
  function runText(run) {
    var t = elementChildren(run)[0];
    return (t && t.textContent) || '';
  }
  function getAttrs(el) {
    var attrs = [];
    var a = el.attributes;
    for (var i = 0; i < a.length; i++) attrs.push({ name: a[i].name, value: a[i].value });
    return attrs;
  }
  function applyAttrs(el, attrs) {
    for (var i = 0; i < attrs.length; i++) el.setAttribute(attrs[i].name, attrs[i].value);
  }

  // ── 개체 생성 (파이썬 make_text_run / make_equation) ───────────
  function makeTextRun(doc, text, attrs) {
    var run = doc.createElementNS(HP_NS, 'hp:run');
    applyAttrs(run, attrs);
    var t = doc.createElementNS(HP_NS, 'hp:t');
    t.appendChild(doc.createTextNode(text));
    run.appendChild(t);
    return run;
  }
  function makeEquation(doc, script, id, style) {
    var eq = doc.createElementNS(HP_NS, 'hp:equation');
    eq.setAttribute('id', id);
    eq.setAttribute('type', '0');
    eq.setAttribute('textColor', style.textColor);
    eq.setAttribute('baseUnit', String(style.baseUnit));
    eq.setAttribute('letterSpacing', String(style.letterSpacing));
    eq.setAttribute('lineThickness', String(style.lineThickness));
    eq.setAttribute('baseLine', '0');

    var sz = doc.createElementNS(HP_NS, 'hp:sz');
    sz.setAttribute('width', '0');
    sz.setAttribute('height', '0');
    sz.setAttribute('widthRelTo', 'ABS');
    sz.setAttribute('heightRelTo', 'ABS');
    eq.appendChild(sz);

    var pos = doc.createElementNS(HP_NS, 'hp:pos');
    var posAttrs = [
      ['treatAsChar', '1'], ['affectLSpacing', '0'], ['flowWithText', '0'],
      ['allowOverlap', '0'], ['holdAnchorAndSO', '0'], ['rgroupWithPrevCtrl', '0'],
      ['vertRelTo', 'PARA'], ['horzRelTo', 'PARA'], ['vertAlign', 'TOP'],
      ['horzAlign', 'LEFT'], ['vertOffset', '0'], ['horzOffset', '0']
    ];
    for (var i = 0; i < posAttrs.length; i++) pos.setAttribute(posAttrs[i][0], posAttrs[i][1]);
    eq.appendChild(pos);

    var sc = doc.createElementNS(HP_NS, 'hp:script');
    sc.appendChild(doc.createTextNode((script || '').trim()));
    eq.appendChild(sc);
    return eq;
  }
  function makeEquationRun(doc, script, id, attrs, style) {
    var run = doc.createElementNS(HP_NS, 'hp:run');
    applyAttrs(run, attrs);
    run.appendChild(makeEquation(doc, script, id, style));
    return run;
  }

  // ── 런 그룹 내 LaTeX 치환 (파이썬 replace_latex_in_run_group) ──
  function buildTextRunSpans(runs) {
    var spans = [], pos = 0;
    for (var i = 0; i < runs.length; i++) {
      var text = runText(runs[i]);
      spans.push({ run: runs[i], text: text, start: pos, end: pos + text.length });
      pos += text.length;
    }
    return spans;
  }
  function attrsAtPosition(spans, pos) {
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      if (s.start <= pos && pos < s.end) return getAttrs(s.run);
      if (pos === s.start) return getAttrs(s.run);
    }
    if (spans.length) return getAttrs(spans[spans.length - 1].run);
    return [];
  }
  function textSliceToRuns(doc, spans, start, end) {
    var result = [];
    if (start >= end) return result;
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      var overlapStart = Math.max(start, s.start);
      var overlapEnd = Math.min(end, s.end);
      if (overlapStart >= overlapEnd) continue;
      var text = s.text.slice(overlapStart - s.start, overlapEnd - s.start);
      if (text) result.push(makeTextRun(doc, text, getAttrs(s.run)));
    }
    return result;
  }
  function replaceLatexInRunGroup(doc, runs, idGen, convert, style, stats) {
    var spans = buildTextRunSpans(runs);
    var text = spans.map(function (s) { return s.text; }).join('');
    var latexSpans = findLatexSpans(text, stats);
    if (!latexSpans.length) return { newRuns: null, count: 0 };

    var result = [];
    var cursor = 0;
    for (var i = 0; i < latexSpans.length; i++) {
      var ls = latexSpans[i];
      pushAll(result, textSliceToRuns(doc, spans, cursor, ls.start));
      var runAttrs = attrsAtPosition(spans, ls.start);
      var script = convert(ls.raw);
      result.push(makeEquationRun(doc, script, idGen.next(), runAttrs, style));
      cursor = ls.end;
    }
    pushAll(result, textSliceToRuns(doc, spans, cursor, text.length));
    return { newRuns: result, count: latexSpans.length };
  }
  function pushAll(arr, items) { for (var i = 0; i < items.length; i++) arr.push(items[i]); }

  // ── 섹션 1개 처리 ──────────────────────────────────────────────
  function processSectionXml(xmlString, idGen, convert, style, stats, DOMParserCls, XMLSerializerCls) {
    if (xmlString.indexOf('$') < 0 && xmlString.indexOf('\\(') < 0 && xmlString.indexOf('\\[') < 0) {
      return { xml: xmlString, changed: false };
    }
    var doc = new DOMParserCls().parseFromString(xmlString, 'application/xml');
    var perr = doc.getElementsByTagName('parsererror');
    if (perr && perr.length) throw new Error('section XML 파싱 실패');

    var paras = doc.getElementsByTagNameNS(HP_NS, 'p');
    var total = 0;
    for (var pi = 0; pi < paras.length; pi++) {
      var para = paras[pi];
      var children = elementChildren(para);
      var pending = []; // {nodes:[...], newRuns:[...]}
      var idx = 0;
      while (idx < children.length) {
        if (!isPlainTextRun(children[idx])) { idx++; continue; }
        var group = [];
        while (idx < children.length && isPlainTextRun(children[idx])) { group.push(children[idx]); idx++; }
        var groupText = group.map(runText).join('');
        if (groupText.indexOf('$') < 0 && groupText.indexOf('\\(') < 0 && groupText.indexOf('\\[') < 0) continue;
        var res = replaceLatexInRunGroup(doc, group, idGen, convert, style, stats);
        if (res.count) pending.push({ nodes: group, newRuns: res.newRuns, count: res.count });
      }
      for (var g = 0; g < pending.length; g++) {
        var item = pending[g];
        var firstNode = item.nodes[0];
        var parent = firstNode.parentNode;
        for (var r = 0; r < item.newRuns.length; r++) parent.insertBefore(item.newRuns[r], firstNode);
        for (var d = 0; d < item.nodes.length; d++) parent.removeChild(item.nodes[d]);
        total += item.count;
      }
      // 텍스트를 수정한 단락의 줄 배치 캐시(hp:linesegarray)는 더 이상 내용과 맞지
      // 않는다. 그대로 두면 한글이 파일을 열 때 "복구하였습니다" 경고를 띄우므로,
      // 변경된 단락의 직속 자식 linesegarray를 제거한다(한글이 다시 열 때 자동 재생성).
      if (pending.length > 0) {
        var paraKids = elementChildren(para);
        for (var ki = 0; ki < paraKids.length; ki++) {
          if (isHp(paraKids[ki], 'linesegarray')) para.removeChild(paraKids[ki]);
        }
      }
    }
    if (total === 0) return { xml: xmlString, changed: false };
    stats.equations += total;

    var serialized = new XMLSerializerCls().serializeToString(doc);
    return { xml: ensureXmlDeclaration(serialized, xmlString), changed: true };
  }

  function ensureXmlDeclaration(serialized, original) {
    if (/^﻿?\s*<\?xml/i.test(serialized)) return serialized;
    var decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    var m = original.match(/^﻿?\s*(<\?xml[^>]*\?>)/i);
    if (m) decl = m[1] + '\n';
    return decl + serialized;
  }

  // ── 섹션 파일 이름 (파이썬 find_section_files) ─────────────────
  function findSectionNames(zip) {
    var names = Object.keys(zip.files).filter(function (n) {
      return !zip.files[n].dir &&
        n.indexOf('Contents/section') === 0 &&
        n.slice(-4) === '.xml';
    });
    names.sort();
    return names;
  }

  // ── ZIP 재구성 (mimetype 우선·STORED 보존) ─────────────────────
  function rebuildZip(JSZipLib, originalZip, updates) {
    var out = new JSZipLib();
    var names = Object.keys(originalZip.files).filter(function (n) { return !originalZip.files[n].dir; });

    // 삽입 순서를 mimetype 우선으로 고정 (HWPX/OCF 규약: mimetype은 첫 항목·비압축).
    var ordered = [];
    if (names.indexOf('mimetype') !== -1) ordered.push('mimetype');
    for (var i = 0; i < names.length; i++) {
      if (names[i] !== 'mimetype') ordered.push(names[i]);
    }

    // 내용은 병렬로 먼저 모두 읽고, out.file() 호출은 정해진 순서대로 '동기' 실행한다.
    // (비동기 읽기 완료 순서에 따라 삽입 순서가 흐트러지는 것을 방지)
    return Promise.all(ordered.map(function (name) {
      if (Object.prototype.hasOwnProperty.call(updates, name)) {
        return Promise.resolve([name, updates[name]]); // 수정된 XML 문자열
      }
      return originalZip.file(name).async('uint8array').then(function (data) { return [name, data]; });
    })).then(function (entries) {
      var contentByName = {};
      entries.forEach(function (e) { contentByName[e[0]] = e[1]; });
      ordered.forEach(function (name) {
        var opts = name === 'mimetype'
          ? { compression: 'STORE', createFolders: false }
          : { compression: 'DEFLATE', createFolders: false };
        out.file(name, contentByName[name], opts);
      });
      return out;
    });
  }

  // ── 메인 진입점 ────────────────────────────────────────────────
  function convertArrayBuffer(arrayBuffer, deps) {
    var d = resolveDeps(deps);
    var stats = { equations: 0, sectionsChanged: 0, skippedNumericDollars: 0 };
    var style = defaultStyle();
    return d.JSZip.loadAsync(arrayBuffer).then(function (zip) {
      var sectionNames = findSectionNames(zip);
      if (!sectionNames.length) {
        throw new Error('Contents/section*.xml 을 찾지 못했습니다. 올바른 HWPX 파일이 맞나요?');
      }
      return Promise.all(sectionNames.map(function (n) {
        return zip.file(n).async('string').then(function (s) { return [n, s]; });
      })).then(function (pairs) {
        var sectionXml = {};
        pairs.forEach(function (p) { sectionXml[p[0]] = p[1]; });

        var idGen = makeIdGenerator(collectUsedIds(Object.keys(sectionXml).map(function (k) { return sectionXml[k]; })));
        var updates = {};
        sectionNames.forEach(function (n) {
          var res = processSectionXml(sectionXml[n], idGen, d.convert, style, stats, d.DOMParser, d.XMLSerializer);
          if (res.changed) { updates[n] = res.xml; stats.sectionsChanged++; }
        });

        return rebuildZip(d.JSZip, zip, updates).then(function (outZip) {
          return outZip.generateAsync({ type: 'blob', mimeType: 'application/octet-stream' })
            .catch(function () { return outZip.generateAsync({ type: 'uint8array' }); })
            .then(function (blob) { return { blob: blob, stats: stats }; });
        });
      });
    });
  }

  function makeOutputName(name) {
    if (!name) return 'output_hwp_equations.hwpx';
    var dot = name.lastIndexOf('.');
    var stem = dot >= 0 ? name.slice(0, dot) : name;
    var ext = dot >= 0 ? name.slice(dot) : '.hwpx';
    return stem + '_hwp_equations' + ext;
  }

  function convertFile(file, deps) {
    return file.arrayBuffer().then(function (buf) {
      return convertArrayBuffer(buf, deps).then(function (out) {
        return { blob: out.blob, stats: out.stats, filename: makeOutputName(file.name) };
      });
    });
  }

  var api = {
    convertFile: convertFile,
    convertArrayBuffer: convertArrayBuffer,
    makeOutputName: makeOutputName,
    // 내부 함수 일부 노출(테스트용)
    _internal: {
      findLatexSpans: findLatexSpans,
      shouldConvertDollarBody: shouldConvertDollarBody,
      makeIdGenerator: makeIdGenerator,
      collectUsedIds: collectUsedIds
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.HwpxConvert = api;
})(typeof window !== 'undefined' ? window : globalThis);
