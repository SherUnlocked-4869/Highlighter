#!/usr/bin/env python3
"""R0-06：产品真实 capture/print.html 的 PDF 双后端对照分析（pypdf）。

读取 .tmp-r0-pdf/product/ 下：
  product-cases.json          共享用例 manifest（纸张/注入/预期）
  electron-product-report.json
  webview2-product-report.json
  electron-*.pdf / webview2-*.pdf

输出：
  analysis.json   机器可读逐 PDF 数据 + 逐用例差异 + 裁决
  analysis.md     给文档用的对照表（两后端逐项数字）

运行（仓库根目录）：
  PYTHONPATH=.tmp-r0-pdf/pylibs PYTHONIOENCODING=utf-8 \
    python scripts/rust/analyze-product-pdfs.py [--dir .tmp-r0-pdf/product]

本机 pypdf 6.7.0（任务约定版本；若 .tmp-r0-pdf/pylibs 不存在则用系统 python 已装的 pypdf）。
不安装任何依赖、不读取用户数据。
"""

import argparse
import hashlib
import json
import math
import os
import sys
from typing import Any


def load_pypdf():
    import pypdf  # noqa: F401  (import early so the version can be reported)
    return pypdf


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def operator_text(operator: Any) -> str:
    if isinstance(operator, bytes):
        return operator.decode("latin-1", "replace")
    return str(operator)


def mat_mul(first, second):
    """3x3 affine 矩阵乘法（PDF 行向量约定：[x y 1] * M）。

    M = [a b c d e f] 对应 [[a, b, 0], [c, d, 0], [e, f, 1]]。
    cm 操作符把 CTM 更新为 M * CTM。
    """
    a1, b1, c1, d1, e1, f1 = first
    a2, b2, c2, d2, e2, f2 = second
    return [
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    ]


def matrix_scale(matrix):
    a, b, c, d, _e, _f = matrix
    return math.hypot(a, b), math.hypot(c, d)


def bbox_of_unit_square(matrix, page_height_pt):
    a, b, c, d, e, f = matrix
    corners = [
        (e, f),
        (a + e, b + f),
        (c + e, d + f),
        (a + c + e, b + d + f),
    ]
    xs = [point[0] for point in corners]
    ys = [point[1] for point in corners]
    # PDF 原点在左下；转换成"距页面左上"更直观（Chromium 页面原点也在左上）。
    return {
        "x0Pt": round(min(xs), 3),
        "y0Pt": round(min(ys), 3),
        "x1Pt": round(max(xs), 3),
        "y1Pt": round(max(ys), 3),
        "widthPt": round(max(xs) - min(xs), 3),
        "heightPt": round(max(ys) - min(ys), 3),
        "topPt": round(page_height_pt - max(ys), 3),
        "bottomPt": round(page_height_pt - min(ys), 3),
    }


def image_resources(page):
    resources = page.get("/Resources")
    if resources is None:
        return {}
    resources = resources.get_object()
    xobjects = resources.get("/XObject")
    if xobjects is None:
        return {}
    xobjects = xobjects.get_object()
    images = {}
    for name, reference in xobjects.items():
        obj = reference.get_object()
        subtype = obj.get("/Subtype")
        if subtype is not None and str(subtype) == "/Image":
            images[str(name)] = obj
    return images


def analyze_page(reader, page, page_index):
    page_height_pt = float(page.mediabox.top) - float(page.mediabox.bottom)
    page_width_pt = float(page.mediabox.right) - float(page.mediabox.left)
    xobject_images = image_resources(page)
    draws = []
    try:
        contents = page.get_contents()
        if contents is not None:
            from pypdf.generic import ContentStream

            operations = ContentStream(contents, reader).operations
            stack = []
            ctm = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
            for operands, operator in operations:
                op = operator_text(operator)
                if op == "q":
                    stack.append(list(ctm))
                elif op == "Q":
                    ctm = stack.pop() if stack else [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
                elif op == "cm" and len(operands) >= 6:
                    matrix = [float(value) for value in operands[:6]]
                    ctm = mat_mul(matrix, ctm)
                elif op in ("Do", "do") and operands:
                    name = str(operands[0])
                    if name in xobject_images:
                        image = xobject_images[name]
                        width_px = int(image.get("/Width", 0))
                        height_px = int(image.get("/Height", 0))
                        filter_value = image.get("/Filter")
                        if filter_value is None:
                            filters = []
                        elif isinstance(filter_value, list):
                            filters = [str(item) for item in filter_value]
                        else:
                            filters = [str(filter_value)]
                        draws.append(
                            {
                                "name": name,
                                "imagePx": [width_px, height_px],
                                "filters": filters,
                                "colorSpace": str(image.get("/ColorSpace")),
                                **bbox_of_unit_square(ctm, page_height_pt),
                            }
                        )
    except Exception as error:  # pragma: no cover - 分析脚本容错
        draws.append({"name": "<content-parse-error>", "error": str(error)})

    text = ""
    try:
        text = page.extract_text() or ""
    except Exception:
        text = ""
    fonts = []
    try:
        resources = page.get("/Resources")
        if resources is not None:
            font_dict = resources.get_object().get("/Font")
            if font_dict is not None and hasattr(font_dict, "keys"):
                fonts = [str(name) for name in font_dict.keys()]
    except Exception:
        fonts = []
    rotation = int(page.get("/Rotate", 0) or 0)
    return {
        "pageIndex": page_index,
        "widthPt": round(page_width_pt, 3),
        "heightPt": round(page_height_pt, 3),
        "rotation": rotation,
        "imageDrawCount": len(draws),
        "images": draws,
        "textChars": len(text),
        "textSample": text[:60].replace("\n", " "),
        "fontNames": fonts,
    }


def analyze_pdf(path: str) -> dict:
    pypdf = load_pypdf()
    reader = pypdf.PdfReader(path)
    pages = [analyze_page(reader, page, index) for index, page in enumerate(reader.pages)]
    metadata = {}
    try:
        metadata = {str(key): str(value) for key, value in (reader.metadata or {}).items()}
    except Exception:
        metadata = {}
    blank_pages = [
        page["pageIndex"]
        for page in pages
        if page["imageDrawCount"] == 0 and page["textChars"] == 0
    ]
    return {
        "path": path,
        "file": os.path.basename(path),
        "bytes": os.path.getsize(path),
        "sha256": sha256_file(path),
        "pageCount": len(pages),
        "blankPages": blank_pages,
        "producer": metadata.get("/Producer"),
        "creator": metadata.get("/Creator"),
        "metadata": metadata,
        "pages": pages,
    }


def find_case_files(directory: str, prefix: str) -> dict:
    result = {}
    for name in sorted(os.listdir(directory)):
        if not name.startswith(prefix) or not name.endswith(".pdf"):
            continue
        case_name = name[len(prefix):-len(".pdf")]
        result[case_name] = os.path.join(directory, name)
    return result


def page_shape(pdf: dict):
    return [[page["widthPt"], page["heightPt"]] for page in pdf["pages"]]


def image_boxes(pdf: dict):
    return [
        [
            {
                "imagePx": draw.get("imagePx"),
                "widthPt": draw.get("widthPt"),
                "heightPt": draw.get("heightPt"),
                "x0Pt": draw.get("x0Pt"),
                "topPt": draw.get("topPt"),
                "bottomPt": draw.get("bottomPt"),
            }
            for draw in page["images"]
        ]
        for page in pdf["pages"]
    ]


def compare_pdfs(left: dict, right: dict) -> dict:
    """left=WebView2，right=Electron；返回逐项差异。"""
    page_shape_left = page_shape(left)
    page_shape_right = page_shape(right)
    max_media_delta = 0.0
    if len(page_shape_left) == len(page_shape_right):
        for left_page, right_page in zip(page_shape_left, page_shape_right):
            for left_value, right_value in zip(left_page, right_page):
                max_media_delta = max(max_media_delta, abs(left_value - right_value))
    boxes_left = image_boxes(left)
    boxes_right = image_boxes(right)
    max_box_delta = None
    if len(boxes_left) == len(boxes_right):
        max_box_delta = 0.0
        for left_page, right_page in zip(boxes_left, boxes_right):
            if len(left_page) != len(right_page):
                max_box_delta = None
                break
            for left_box, right_box in zip(left_page, right_page):
                if left_box["imagePx"] != right_box["imagePx"]:
                    max_box_delta = None
                    break
                for key in ("widthPt", "heightPt", "x0Pt", "topPt", "bottomPt"):
                    if left_box[key] is None or right_box[key] is None:
                        max_box_delta = None
                        break
                    max_box_delta = max(max_box_delta, abs(left_box[key] - right_box[key]))
                if max_box_delta is None:
                    break
            if max_box_delta is None:
                break
    text_chars_left = [page["textChars"] for page in left["pages"]]
    text_chars_right = [page["textChars"] for page in right["pages"]]
    blank_equal = left["blankPages"] == right["blankPages"]
    # 语义等价：页数/空白页/文字一致，MediaBox 与图片绘制框差异 ≤ 1pt。
    # 1pt 容差来自 Electron 43 把自定义 pageSize 量化到 0.24pt（300dpi）网格的实测
    # （见 .tmp-r0-pdf/product/diag2：输入 13.333346in 输出 13.346667in，差 0.96pt）。
    content_equivalent = (
        left["pageCount"] == right["pageCount"]
        and text_chars_left == text_chars_right
        and blank_equal
        and max_box_delta is not None
        and max_box_delta <= 1.0
        and max_media_delta <= 1.0
    )
    return {
        "pageCountEqual": left["pageCount"] == right["pageCount"],
        "pageCountWebView2": left["pageCount"],
        "pageCountElectron": right["pageCount"],
        "pageShapeEqual": page_shape_left == page_shape_right,
        "maxMediaBoxDeltaPt": round(max_media_delta, 4),
        "imageBoxMaxDeltaPt": None if max_box_delta is None else round(max_box_delta, 4),
        "blankPagesWebView2": left["blankPages"],
        "blankPagesElectron": right["blankPages"],
        "blankPagesEqual": blank_equal,
        "textCharsEqual": text_chars_left == text_chars_right,
        "textCharsWebView2": text_chars_left,
        "textCharsElectron": text_chars_right,
        "bytesWebView2": left["bytes"],
        "bytesElectron": right["bytes"],
        "bytesDelta": right["bytes"] - left["bytes"],
        "pixelIdentical": left["sha256"] == right["sha256"],
        "contentEquivalent": content_equivalent,
    }


def check_expected(case: dict, pdf: dict) -> dict:
    expected = case.get("expected", {})
    checks = {
        "pageCountMatchesExpected": pdf["pageCount"] == expected.get("pdfPages"),
        "expectedPages": expected.get("pdfPages"),
        "actualPages": pdf["pageCount"],
        "blankPages": pdf["blankPages"],
        "noBlankPages": not pdf["blankPages"],
        "mediaBoxPt": page_shape(pdf)[0] if pdf["pages"] else None,
        "expectedMediaBoxPt": expected.get("mediaBoxPt"),
        "mediaBoxMatchesExpected": (
            bool(pdf["pages"])
            and abs(pdf["pages"][0]["widthPt"] - expected.get("mediaBoxPt", [0, 0])[0]) <= 0.01
            and abs(pdf["pages"][0]["heightPt"] - expected.get("mediaBoxPt", [0, 0])[1]) <= 0.01
        ),
        "imagesPerPage": [page["imageDrawCount"] for page in pdf["pages"]],
        "everyPageHasOneImage": all(page["imageDrawCount"] >= 1 for page in pdf["pages"]),
        "clampedPaper": case.get("paper", {}).get("clamped"),
        "requestedHeightInches": (
            case.get("paper", {}).get("requestedPageSizeMicrons", {}).get("height", 0) / 25400
            if case.get("paper", {}).get("requestedPageSizeMicrons")
            else None
        ),
        "pageHeightInches": (
            case.get("paper", {}).get("pageSizeMicrons", {}).get("height", 0) / 25400
            if case.get("paper", {}).get("pageSizeMicrons")
            else None
        ),
    }
    # 内容是否被裁：每页图片绘制框必须落在 MediaBox 内（容差 0.75pt，覆盖 Chromium 取整）。
    cropped = []
    for page in pdf["pages"]:
        for draw in page["images"]:
            if draw.get("widthPt") is None:
                continue
            if (
                draw["x0Pt"] < -0.75
                or draw["topPt"] < -0.75
                or draw["x1Pt"] > page["widthPt"] + 0.75
                or draw["y1Pt"] > page["heightPt"] + 0.75
            ):
                cropped.append(
                    {
                        "page": page["pageIndex"],
                        "name": draw.get("name"),
                        "x0Pt": draw.get("x0Pt"),
                        "topPt": draw.get("topPt"),
                        "x1Pt": draw.get("x1Pt"),
                        "y1Pt": draw.get("y1Pt"),
                        "pageWidthPt": page["widthPt"],
                        "pageHeightPt": page["heightPt"],
                    }
                )
    checks["croppedImages"] = cropped
    checks["contentNotCropped"] = not cropped
    return checks


def dom_summary(report: dict) -> dict:
    summary = {}
    for case in report.get("cases", []):
        summary[case["name"]] = {
            "error": case.get("error"),
            "bytes": case.get("bytes"),
            "loadMs": case.get("loadMs"),
            "printMs": case.get("printMs"),
            "elapsedMs": case.get("elapsedMs"),
            "stepCount": len(case.get("steps") or []),
            "stepErrors": [
                {key: step.get(key) for key in ("kind", "index", "error")}
                for step in (case.get("steps") or [])
                if step.get("error") or (step.get("poll") and not step["poll"].get("ok"))
            ],
            "domAfterSteps": case.get("domAfterSteps"),
        }
    return summary


def dom_assertions(case: dict, dom: dict) -> dict:
    """DOM 层断言（真实页 CSP / 注入 / .print-page 结构）。"""
    result = {
        "cspPresent": bool(dom.get("csp")),
        "csp": dom.get("csp"),
        "origin": dom.get("origin"),
        "styleSheets": dom.get("styleSheets"),
        "failure": None,
    }
    if case.get("kind") == "batch":
        result.update(
            {
                "sheetCount": dom.get("sheetCount"),
                "pageClassCount": dom.get("pageClassCount"),
                "lastHasLastClass": dom.get("lastHasLastClass"),
                "containerStyle": dom.get("containerStyle"),
                "htmlMulti": dom.get("htmlMulti"),
                "bodyMulti": dom.get("bodyMulti"),
                "expectedSheets": len(case.get("images") or []),
                "sheetsMatch": dom.get("sheetCount") == len(case.get("images") or []),
                "noBlankTail": bool(
                    dom.get("sheets")
                    and dom["sheets"][-1].get("imageComplete")
                    and dom["sheets"][-1].get("naturalWidth", 0) > 0
                ),
                "allImagesDecoded": all(
                    sheet.get("imageComplete") and sheet.get("naturalWidth", 0) > 0
                    for sheet in (dom.get("sheets") or [])
                ),
            }
        )
    else:
        result.update(
            {
                "hasImage": dom.get("hasImage"),
                "imageComplete": dom.get("imageComplete"),
                "naturalWidth": dom.get("naturalWidth"),
                "naturalHeight": dom.get("naturalHeight"),
                "styleWidth": dom.get("styleWidth"),
                "styleHeight": dom.get("styleHeight"),
                "imageCount": dom.get("imageCount"),
                "imageLoadedFromDataUrl": bool(dom.get("imageComplete") and dom.get("naturalWidth", 0) > 0),
            }
        )
    return result


def markdown_table(rows, headers) -> str:
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in rows:
        lines.append("| " + " | ".join(str(value) for value in row) + " |")
    return "\n".join(lines)


def fmt_number(value, digits=2):
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


def main() -> int:
    parser = argparse.ArgumentParser(description="R0-06 product PDF dual-backend analysis")
    parser.add_argument("--dir", default=os.path.join(".tmp-r0-pdf", "product"), help="evidence directory")
    args = parser.parse_args()

    directory = os.path.abspath(args.dir)
    manifest_path = os.path.join(directory, "product-cases.json")
    electron_report_path = os.path.join(directory, "electron-product-report.json")
    webview2_report_path = os.path.join(directory, "webview2-product-report.json")
    for path in (manifest_path, electron_report_path):
        if not os.path.exists(path):
            print(f"[FAIL] missing {path}", file=sys.stderr)
            return 2

    pypdf = load_pypdf()
    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    with open(electron_report_path, "r", encoding="utf-8") as handle:
        electron_report = json.load(handle)
    webview2_report = None
    if os.path.exists(webview2_report_path):
        with open(webview2_report_path, "r", encoding="utf-8") as handle:
            webview2_report = json.load(handle)

    electron_files = find_case_files(directory, "electron-")
    webview2_files = find_case_files(directory, "webview2-")
    case_by_name = {case["name"]: case for case in manifest["cases"]}

    electron_pdfs = {name: analyze_pdf(path) for name, path in electron_files.items()}
    webview2_pdfs = {name: analyze_pdf(path) for name, path in webview2_files.items()}

    electron_dom = dom_summary(electron_report)
    webview2_dom = dom_summary(webview2_report) if webview2_report else {}

    cases = []
    for case in manifest["cases"]:
        name = case["name"]
        entry = {
            "name": name,
            "kind": case["kind"],
            "description": case["description"],
            "mode": case["mode"],
            "dpi": case["dpi"],
            "inject": case["inject"],
            "imagePx": [[image["pxW"], image["pxH"]] for image in case["images"]],
            "paper": case["paper"],
            "electronOptions": case["electronOptions"],
            "rustOptions": case["rustOptions"],
            "windowSize": case["windowSize"],
            "electron": None,
            "webview2": None,
            "dom": {
                "electron": dom_assertions(case, (electron_dom.get(name) or {}).get("domAfterSteps") or {}),
                "webview2": dom_assertions(case, (webview2_dom.get(name) or {}).get("domAfterSteps") or {})
                if webview2_dom
                else None,
            },
            "checks": {},
            "comparison": None,
        }
        if name in electron_pdfs:
            entry["electron"] = electron_pdfs[name]
            entry["checks"]["electron"] = check_expected(case, electron_pdfs[name])
        if name in webview2_pdfs:
            entry["webview2"] = webview2_pdfs[name]
            entry["checks"]["webview2"] = check_expected(case, webview2_pdfs[name])
        if name in electron_pdfs and name in webview2_pdfs:
            entry["comparison"] = compare_pdfs(webview2_pdfs[name], electron_pdfs[name])
        cases.append(entry)

    # 产品函数对照：x1 ↔ p1、x2 ↔ p6
    controls = []
    control_names = {control["name"] for control in manifest.get("controls", [])}
    for control in manifest.get("controls", []):
        target = control["targetCase"]
        entry = {
            "name": control["name"],
            "description": control["description"],
            "function": control["function"],
            "targetCase": target,
        }
        if control["name"] in electron_pdfs:
            entry["pdf"] = electron_pdfs[control["name"]]
        if control["name"] in electron_pdfs and target in electron_pdfs:
            entry["comparisonWithTarget"] = compare_pdfs(electron_pdfs[control["name"]], electron_pdfs[target])
            entry["byteIdenticalWithTarget"] = (
                electron_pdfs[control["name"]]["sha256"] == electron_pdfs[target]["sha256"]
            )
            entry["byteLengthIdenticalWithTarget"] = (
                electron_pdfs[control["name"]]["bytes"] == electron_pdfs[target]["bytes"]
            )
        if control["name"] in webview2_pdfs and target in webview2_pdfs:
            entry["comparisonWithTargetWebview2"] = compare_pdfs(webview2_pdfs[control["name"]], webview2_pdfs[target])
        controls.append(entry)
    missing_controls = sorted(control_names - set(electron_files.keys()))

    # 汇总（只对两后端都有 PDF 的用例）
    paired = [entry for entry in cases if entry["comparison"]]
    max_media_delta = max(
        [entry["comparison"]["maxMediaBoxDeltaPt"] for entry in paired], default=None
    )
    max_box_delta = max(
        [
            entry["comparison"]["imageBoxMaxDeltaPt"]
            for entry in paired
            if entry["comparison"]["imageBoxMaxDeltaPt"] is not None
        ],
        default=None,
    )
    # inject=natural 的用例本就故意让图片溢出纸张（DPR 负对照），裁切是预期证据，不计入汇总。
    crop_checked = [entry for entry in cases if entry["inject"] != "natural"]
    clamped_cases = []
    batch_cases = []
    for entry in cases:
        paper = entry["paper"]
        if paper.get("clamped"):
            requested = paper.get("requestedPageSizeMicrons") or {}
            actual = paper.get("pageSizeMicrons") or {}
            clamped_cases.append(
                {
                    "name": entry["name"],
                    "requestedHeightInches": round(requested.get("height", 0) / 25400, 4),
                    "paperHeightInches": round(actual.get("height", 0) / 25400, 4),
                    "clampedToMaxPageInches": actual.get("height") is not None
                    and abs(actual["height"] / 25400 - manifest["constants"]["maxPageInches"]) < 1e-6,
                    "webview2Pages": (entry["webview2"] or {}).get("pageCount"),
                    "electronPages": (entry["electron"] or {}).get("pageCount"),
                    "webview2ContentNotCropped": (entry["checks"].get("webview2") or {}).get("contentNotCropped"),
                    "electronContentNotCropped": (entry["checks"].get("electron") or {}).get("contentNotCropped"),
                    "webview2MediaBoxPt": (entry["checks"].get("webview2") or {}).get("mediaBoxPt"),
                    "electronMediaBoxPt": (entry["checks"].get("electron") or {}).get("mediaBoxPt"),
                }
            )
        if entry["kind"] == "batch":
            webview2_dom_entry = entry["dom"]["webview2"] or {}
            electron_dom_entry = entry["dom"]["electron"] or {}
            batch_cases.append(
                {
                    "name": entry["name"],
                    "expectedPages": entry["checks"].get("electron", {}).get("expectedPages"),
                    "webview2Pages": (entry["webview2"] or {}).get("pageCount"),
                    "electronPages": (entry["electron"] or {}).get("pageCount"),
                    "webview2ImagesPerPage": (entry["checks"].get("webview2") or {}).get("imagesPerPage"),
                    "electronImagesPerPage": (entry["checks"].get("electron") or {}).get("imagesPerPage"),
                    "webview2BlankPages": (entry["checks"].get("webview2") or {}).get("blankPages"),
                    "electronBlankPages": (entry["checks"].get("electron") or {}).get("blankPages"),
                    "webview2DomSheets": webview2_dom_entry.get("sheetCount"),
                    "electronDomSheets": electron_dom_entry.get("sheetCount"),
                    "webview2LastHasLastClass": webview2_dom_entry.get("lastHasLastClass"),
                    "electronLastHasLastClass": electron_dom_entry.get("lastHasLastClass"),
                }
            )
    # ExecuteScript vs executeJavaScript 对"脚本返回 Promise"的语义差异（R4-07 实现要点）。
    execute_script_semantics = {
        "webview2AwaitsPromiseInExecuteScript": None,
        "electronAwaitsPromiseInExecuteJavaScript": None,
        "webview2RawResults": [],
        "note": (
            "产品注入脚本返回 Promise；WebView2 ICoreWebView2::ExecuteScript 不等待 Promise（返回 {}），"
            "宿主必须轮询 DOM 才能确认图片 decode 完成；Electron executeJavaScript 直接返回 Promise 解析值。"
        ),
    }
    if webview2_report:
        raw_values = []
        for case in webview2_report.get("cases", []):
            for step in case.get("steps") or []:
                if step.get("kind") == "image-inject":
                    raw_values.append(str(step.get("executeResultRaw"))[:120])
        execute_script_semantics["webview2RawResults"] = raw_values
        # raw 全是 {} / null / 空 → ExecuteScript 没等 Promise（返回的是 Promise 对象 JSON）。
        execute_script_semantics["webview2AwaitsPromiseInExecuteScript"] = (
            False
            if raw_values and all(value.strip() in ("{}", "null", "") for value in raw_values)
            else None
        )
    if electron_report:
        resolved = []
        for case in electron_report.get("cases", []):
            for step in case.get("steps") or []:
                if step.get("kind") == "image-inject":
                    value = step.get("value")
                    resolved.append(isinstance(value, dict) and "width" in value)
        execute_script_semantics["electronAwaitsPromiseInExecuteJavaScript"] = (
            all(resolved) if resolved else None
        )
    summary = {
        "pairedCases": len(paired),
        "totalCases": len(cases),
        "allPageCountsEqual": all(entry["comparison"]["pageCountEqual"] for entry in paired),
        "maxMediaBoxDeltaPt": max_media_delta,
        "allMediaBoxEquivalentWithin1pt": max_media_delta is not None and max_media_delta <= 1.0,
        "maxImageBoxDeltaPt": max_box_delta,
        "allImageBoxEquivalentWithin1pt": max_box_delta is not None and max_box_delta <= 1.0,
        "allContentEquivalent": all(entry["comparison"]["contentEquivalent"] for entry in paired),
        "allBlankPagesAbsent": all(
            not (entry["checks"].get("webview2") or {}).get("blankPages")
            and not (entry["checks"].get("electron") or {}).get("blankPages")
            for entry in cases
        ),
        "allContentNotCroppedExceptNaturalPxControl": all(
            (entry["checks"].get("webview2") or {}).get("contentNotCropped", True)
            and (entry["checks"].get("electron") or {}).get("contentNotCropped", True)
            for entry in crop_checked
        ),
        "naturalPxControlCroppedBothBackends": [
            {
                "name": entry["name"],
                "webview2Cropped": (entry["checks"].get("webview2") or {}).get("croppedImages"),
                "electronCropped": (entry["checks"].get("electron") or {}).get("croppedImages"),
            }
            for entry in cases
            if entry["inject"] == "natural"
        ],
        "allExpectedPageCounts": all(
            entry["checks"].get(backend, {}).get("pageCountMatchesExpected", True)
            for entry in cases
            for backend in ("electron", "webview2")
            if entry["checks"].get(backend)
        ),
        "clampedLongImageCases": clamped_cases,
        "batchCases": batch_cases,
        "executeScriptPromiseSemantics": execute_script_semantics,
        "webview2ReportPresent": webview2_report is not None,
        "failures": {
            "electron": electron_report.get("errors", []),
            "webview2": (webview2_report or {}).get("failures", []),
        },
        "missingControls": missing_controls,
    }

    analysis = {
        "generatedAt": pypdf.__version__,
        "pypdfVersion": pypdf.__version__,
        "directory": directory,
        "manifestGeneratedAt": manifest.get("generatedAt"),
        "sourceHashes": manifest.get("sourceHashes"),
        "backendVersions": {
            "electron": {
                "electron": electron_report.get("electron"),
                "chrome": electron_report.get("chrome"),
            },
            "webview2": (webview2_report or {}).get("webview2Version"),
        },
        "summary": summary,
        "cases": cases,
        "controls": controls,
        "domReports": {"electron": electron_dom, "webview2": webview2_dom},
    }
    analysis_path = os.path.join(directory, "analysis.json")
    with open(analysis_path, "w", encoding="utf-8") as handle:
        json.dump(analysis, handle, ensure_ascii=False, indent=2)

    # ---- 文档用 markdown ----
    max_page_inches = manifest["constants"]["maxPageInches"]
    rows = []
    for entry in cases:
        electron = entry["electron"]
        webview2 = entry["webview2"]
        paper = entry["paper"]
        page_microns = paper.get("pageSizeMicrons") or {}
        requested_microns = paper.get("requestedPageSizeMicrons") or {}
        if paper.get("pageSize") == "A4":
            paper_label = "A4" + ("-横" if paper.get("landscape") else "-竖")
        else:
            paper_label = "custom"
        paper_text = f"{paper_label} {page_microns.get('width', 0) / 25400:.2f}×{page_microns.get('height', 0) / 25400:.2f}in"
        if paper.get("clamped"):
            paper_text += f"（请求 {requested_microns.get('height', 0) / 25400:.2f}in→夹取 {max_page_inches}in）"
        if webview2:
            wv_shape = (
                f"{webview2['pages'][0]['widthPt']:.2f}×{webview2['pages'][0]['heightPt']:.2f} / {webview2['pageCount']}"
                if webview2["pages"]
                else "-"
            )
            wv_boxes = "; ".join(
                f"{draw['widthPt']:.2f}×{draw['heightPt']:.2f}"
                for draw in (webview2["pages"][0]["images"] if webview2["pages"] else [])
            )
            wv_bytes = webview2["bytes"]
            wv_elapsed = (webview2_dom.get(entry["name"]) or {}).get("elapsedMs")
        else:
            wv_shape, wv_boxes, wv_bytes, wv_elapsed = "未运行/失败", "-", "-", "-"
        if electron:
            el_shape = (
                f"{electron['pages'][0]['widthPt']:.2f}×{electron['pages'][0]['heightPt']:.2f} / {electron['pageCount']}"
                if electron["pages"]
                else "-"
            )
            el_boxes = "; ".join(
                f"{draw['widthPt']:.2f}×{draw['heightPt']:.2f}"
                for draw in (electron["pages"][0]["images"] if electron["pages"] else [])
            )
            el_bytes = electron["bytes"]
            el_elapsed = (electron_dom.get(entry["name"]) or {}).get("elapsedMs")
        else:
            el_shape, el_boxes, el_bytes, el_elapsed = "未运行/失败", "-", "-", "-"
        comparison = entry["comparison"]
        verdict = "-"
        if comparison:
            if not comparison["pageCountEqual"]:
                verdict = (
                    f"页数不同（wv2={comparison['pageCountWebView2']} / el={comparison['pageCountElectron']}）"
                )
            elif comparison["contentEquivalent"]:
                verdict = "等价"
                if comparison["maxMediaBoxDeltaPt"] > 0.01:
                    verdict += f"（MediaBox 差 {comparison['maxMediaBoxDeltaPt']:.2f}pt）"
                if entry["inject"] == "natural":
                    verdict = "等价（DPR 负对照：两后端同样溢出裁切）"
            else:
                verdict = "内容差异（见 analysis.json）"
        rows.append(
            [
                entry["name"],
                f"{entry['mode']}/dpi={entry['dpi']}/inject={entry['inject']}",
                paper_text,
                f"{paper.get('scale')}",
                wv_shape,
                el_shape,
                wv_boxes,
                el_boxes,
                wv_bytes,
                el_bytes,
                wv_elapsed if wv_elapsed is not None else "-",
                el_elapsed if el_elapsed is not None else "-",
                verdict,
            ]
        )
    headers = [
        "用例",
        "模式/DPI/注入",
        "纸张（产品 computePaperOptions 输出）",
        "scale",
        "WebView2 MediaBox(pt)/页数",
        "Electron MediaBox(pt)/页数",
        "WebView2 首页图片 bbox(pt)",
        "Electron 首页图片 bbox(pt)",
        "WebView2 字节",
        "Electron 字节",
        "WebView2 ms",
        "Electron ms",
        "判定",
    ]

    dom_rows = []
    for entry in cases:
        for backend in ("webview2", "electron"):
            dom = entry["dom"].get(backend)
            if not dom:
                continue
            if entry["kind"] == "batch":
                dom_rows.append(
                    [
                        entry["name"],
                        backend,
                        f"sheets={dom.get('sheetCount')}/{len(entry['imagePx'])}",
                        f"pageClass={dom.get('pageClassCount')}",
                        f"lastHasLast={dom.get('lastHasLastClass')}",
                        f"multi html/body={dom.get('htmlMulti')}/{dom.get('bodyMulti')}",
                        f"container={dom.get('containerStyle')}",
                        f"allDecoded={dom.get('allImagesDecoded')}",
                        f"csp={bool(dom.get('cspPresent'))}",
                    ]
                )
            else:
                dom_rows.append(
                    [
                        entry["name"],
                        backend,
                        f"img={dom.get('naturalWidth')}×{dom.get('naturalHeight')}",
                        f"style={dom.get('styleWidth')}×{dom.get('styleHeight')}",
                        f"loaded={dom.get('imageLoadedFromDataUrl')}",
                        f"origin={dom.get('origin')}",
                        f"csp={bool(dom.get('cspPresent'))}",
                        f"sheets={dom.get('sheetCount', '-')}",
                        "",
                        "",
                    ]
                )
    dom_headers = [
        "用例",
        "后端",
        "图片自然像素",
        "注入 CSS 尺寸",
        "data: 图片加载",
        "页面 origin",
        "真实页 CSP 存在",
        "批量 DOM",
        "",
        "",
    ]

    markdown = ["# R0-06 产品真实 print.html PDF 双后端对照（pypdf 自动生成）", ""]
    markdown.append(f"- pypdf: {pypdf.__version__}")
    markdown.append(f"- manifest: {manifest.get('generatedAt')}")
    markdown.append(f"- print.html sha256: `{manifest.get('sourceHashes', {}).get('printPage', {}).get('sha256')}`")
    markdown.append(f"- tokens.css sha256: `{manifest.get('sourceHashes', {}).get('tokensCss', {}).get('sha256')}`")
    markdown.append(f"- electron: {electron_report.get('electron')} / chrome {electron_report.get('chrome')}")
    if webview2_report:
        markdown.append(f"- webview2: {webview2_report.get('webview2Version')}")
    markdown.append("")
    markdown.append(markdown_table(rows, headers))
    markdown.append("")
    markdown.append("## DOM 证据（产品注入脚本在真实页 CSP 下执行后的状态）")
    markdown.append("")
    markdown.append(markdown_table(dom_rows, dom_headers))
    markdown.append("")
    markdown.append("## 逐用例检查")
    markdown.append("")
    for entry in cases:
        markdown.append(f"### {entry['name']}")
        markdown.append("")
        markdown.append(f"- 说明：{entry['description']}")
        paper = entry["paper"]
        markdown.append(
            f"- 图片：{entry['imagePx']}；paper={json.dumps(paper.get('pageSize'))}；"
            f"scale={paper.get('scale')}；clamped={paper.get('clamped')}；"
            f"requested={json.dumps(paper.get('requestedPageSizeMicrons'))}µm；"
            f"actual={json.dumps(paper.get('pageSizeMicrons'))}µm"
        )
        markdown.append(f"- electron options: {json.dumps(entry['electronOptions'])}")
        markdown.append(f"- rust/WebView2 options: {json.dumps(entry['rustOptions'])}")
        for backend in ("electron", "webview2"):
            check = entry["checks"].get(backend)
            if not check:
                continue
            markdown.append(
                f"- {backend}: pages={check['actualPages']}（expected {check['expectedPages']}），"
                f"MediaBox={check['mediaBoxPt']}（expected {check['expectedMediaBoxPt']}），"
                f"blank={check['blankPages']}，images/page={check['imagesPerPage']}，"
                f"contentNotCropped={check['contentNotCropped']}，"
                f"cropped={json.dumps(check['croppedImages'], ensure_ascii=False)}"
            )
        if entry["comparison"]:
            markdown.append(f"- 对照：{json.dumps(entry['comparison'], ensure_ascii=False)}")
        markdown.append("")
    markdown.append("## 产品函数对照（Electron exportPdfBuffer / exportPagesToPdfBuffer）")
    markdown.append("")
    for control in controls:
        markdown.append(
            f"- {control['name']} → {control['targetCase']}: "
            f"byteLengthIdentical={control.get('byteLengthIdenticalWithTarget')}，"
            f"byteIdentical={control.get('byteIdenticalWithTarget')}，"
            f"comparison={json.dumps(control.get('comparisonWithTarget'), ensure_ascii=False)}"
        )
    markdown.append("")
    markdown.append("## 汇总")
    markdown.append("")
    markdown.append("```json")
    markdown.append(json.dumps(summary, ensure_ascii=False, indent=2))
    markdown.append("```")
    markdown_path = os.path.join(directory, "analysis.md")
    with open(markdown_path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(markdown) + "\n")

    print(f"[ok] pypdf {pypdf.__version__}")
    print(f"[ok] electron PDFs={len(electron_pdfs)} webview2 PDFs={len(webview2_pdfs)} cases={len(cases)} controls={len(controls)}")
    print(f"[ok] analysis: {analysis_path}")
    print(f"[ok] markdown: {markdown_path}")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
