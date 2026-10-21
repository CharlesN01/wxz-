"""Build a reviewed, deterministic replacement bundle from three supplied XLSX files.

This script only reads files. It never connects to a database or executes formulas.
"""

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re

from openpyxl import load_workbook


BASE_HEADERS = ("题目ID", "来源", "分类ID", "篇目ID", "题型", "标签", "排序", "题干")
CATEGORY_ALIASES = {
    "先秦": "pre-qin", "秦汉": "qin-han", "六朝": "wei-jin",
    "唐代": "tang", "宋代": "song", "元明清": "yuan-ming-qing",
    "现当代": "modern", "外国文学": "foreign",
}
TOKEN = re.compile(r"\{\{([0-9]+)\}\}")


def clean_text(value):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"文字字段不能包含 {type(value).__name__}")
    # Excel's escaped carriage return is transport encoding, not question text.
    return value.replace("_x000D_", "\r").replace("\r\n", "\n").replace("\r", "\n").strip()


def identity_stem(row, *, historical=False):
    stem = row["stem"].replace("\\n", "\n")
    if row["type"] == "translation":
        stem = TOKEN.sub("", stem)
        stem = re.sub(r"参考译文[：:]?\s*$", "", stem)
    elif row["type"] == "word":
        if historical:
            def recover(match):
                index = int(match[1])
                answer = row["answers"][index]
                # Only recover labels actually present in the historical answer.
                # Missing labels deliberately prevent an uncertain identity match.
                parts = re.split(r"[：:]", answer, maxsplit=1)
                return parts[0] if len(parts) == 2 else match[0]
            stem = TOKEN.sub(recover, stem)
        stem = stem.translate(str.maketrans("", "", "（）()"))
    return re.sub(r"\s+", "", stem)


def identity(row, *, historical=False):
    return (
        row["source"], row["type"], row.get("category_id"), row.get("article_id"),
        identity_stem(row, historical=historical),
    )


def baseline_record(row):
    keys = ("id", "source", "type", "tag", "stem", "answers", "sort_order", "category_id", "article_id", "is_published", "published_revision_id")
    return {key: row[key] for key in keys}


def read_workbook(path, expected_type, categories, articles):
    book = load_workbook(path, read_only=True, data_only=False, keep_links=False)
    issues = []
    questions = []
    try:
        sheet = book["题库"]
        iterator = sheet.iter_rows(values_only=True)
        headers = tuple(next(iterator))
        if headers[:8] != BASE_HEADERS or headers[8:] != tuple(f"答案{i}" for i in range(1, len(headers) - 7)):
            raise ValueError(f"{path.name}: 表头不符合题库规范")
        seen = set()
        for excel_row, cells in enumerate(iterator, 2):
            if not any(value is not None and str(value).strip() for value in cells):
                raise ValueError(f"{path.name}:{excel_row}: 题库中间存在空白行")
            if any(isinstance(value, str) and value.startswith("=") for value in cells):
                raise ValueError(f"{path.name}:{excel_row}: 不接受公式")
            qid, source, category, article, qtype, tag = map(clean_text, cells[:6])
            if not re.fullmatch(r"[-A-Za-z0-9_]{1,64}", qid) or qid in seen:
                raise ValueError(f"{path.name}:{excel_row}: 题号无效或重复")
            seen.add(qid)
            if qtype != expected_type or source != ("literature" if qtype == "fact" else "classical"):
                raise ValueError(f"{path.name}:{excel_row}: 来源/题型错误")
            order = cells[6]
            if not isinstance(order, int) or isinstance(order, bool) or order < 0:
                raise ValueError(f"{path.name}:{excel_row}: 排序必须是非负整数")
            stem = clean_text(cells[7])
            raw_answers = [clean_text(value) for value in cells[8:]]
            while raw_answers and not raw_answers[-1]:
                raw_answers.pop()
            if not raw_answers or not all(raw_answers):
                raise ValueError(f"{path.name}:{excel_row}: 答案为空或中间有空列")
            if category:
                category_id = category if category in categories else CATEGORY_ALIASES.get(category)
                if category_id not in categories or article:
                    raise ValueError(f"{path.name}:{excel_row}: 文学分类不明确")
                article_id = None
            else:
                category_id = None
                matches = [item["id"] for item in articles.values() if item["title"] == article or item["id"] == article]
                if len(matches) != 1:
                    raise ValueError(f"{path.name}:{excel_row}: 文言篇目不明确 {article}")
                article_id = matches[0]
            row = {
                "source_id": qid, "source_file": path.name, "source_row": excel_row,
                "source": source, "type": qtype, "category_id": category_id,
                "article_id": article_id, "tag": tag, "sort_order": order,
                "stem": stem, "answers": raw_answers,
            }
            original_stem = row["stem"]
            if any(isinstance(value, str) and "_x000D_" in value for value in cells):
                issues.append({"id": qid, "row": excel_row, "kind": "excel_carriage_return_decoded"})
            tokens = {str(int(index)) for index in TOKEN.findall(stem)}
            expected = {str(index) for index in range(len(raw_answers))}
            if qtype == "word" and not tokens:
                # Preserve the quoted words. Their explanations, not the words,
                # are the answers: never replace （词语） with an explanation slot.
                labels = [f"释义{index + 1}：{{{{{index}}}}}" for index in range(len(raw_answers))]
                row["stem"] = stem + "\n" + "\n".join(labels)
                issues.append({"id": qid, "row": excel_row, "kind": "word_explanation_slots_added"})
                parentheses = re.findall(r"（[^（）]*）", original_stem)
                if len(parentheses) != len(raw_answers):
                    issues.append({
                        "id": qid, "row": excel_row, "kind": "parenthesis_answer_count_mismatch_preserved",
                        "parentheses": len(parentheses), "answers": len(raw_answers),
                        "stem": original_stem, "answer_text": raw_answers,
                    })
            elif qtype == "translation" and not tokens and len(raw_answers) == 1:
                row["stem"] = stem + "\n参考译文：{{0}}"
                issues.append({"id": qid, "row": excel_row, "kind": "translation_slot_added"})
            elif tokens != expected:
                raise ValueError(f"{path.name}:{excel_row}: 占位符与答案不匹配")
            row["identity_stem"] = original_stem
            questions.append(row)
    finally:
        book.close()
    return questions, issues


def prepare(*, literature, words, translations, snapshot, namespace):
    old = json.loads(Path(snapshot).read_text(encoding="utf-8-sig"))
    categories = {row["id"]: row for row in old["categories"]}
    articles = {row["id"]: row for row in old["articles"]}
    rows, issues, files = [], [], []
    for path, qtype in ((Path(literature), "fact"), (Path(words), "word"), (Path(translations), "translation")):
        questions, found = read_workbook(path, qtype, categories, articles)
        rows.extend(questions)
        issues.extend({"file": path.name, **issue} for issue in found)
        files.append({"name": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "count": len(questions)})
    old_by_identity = defaultdict(list)
    new_by_identity = defaultdict(list)
    for question in old["questions"]:
        old_by_identity[identity(question, historical=True)].append(question)
    for question in rows:
        new_by_identity[identity({**question, "stem": question["identity_stem"]})].append(question)
    mapping = []
    used_ids = set()
    old_by_id = {row["id"]: row for row in old["questions"]}
    for question in rows:
        key = identity({**question, "stem": question.pop("identity_stem")})
        matches = old_by_identity[key]
        # Do not guess which duplicate a historical favourite referred to.
        if len(matches) == len(new_by_identity[key]) == 1:
            qid = matches[0]["id"]
            method = "unique_same_question"
        else:
            qid = f"{namespace}-{question['source_id']}"
            method = "new_identity" if not matches else "ambiguous_kept_as_new"
            if qid in old_by_id:
                raise ValueError(f"新命名空间已存在题号 {qid}；不能把重新编号的不同题覆盖到已有身份，请使用新的题库批次命名空间")
        if qid in used_ids or len(qid) > 64:
            raise ValueError(f"稳定题号冲突或过长：{qid}")
        used_ids.add(qid)
        question["id"] = qid
        mapping.append({
            "file": question["source_file"], "row": question["source_row"], "source_id": question["source_id"],
            "id": qid, "method": method, "historical_candidates": [row["id"] for row in matches],
        })
    bundle = {
        "schema": "chinese-study-questionbank-v1", "namespace": namespace, "source_files": files,
        "scope_sources": ["literature", "classical"],
        "baseline_questions": [baseline_record(row) for row in old["questions"]],
        "categories": list(categories.values()), "articles": list(articles.values()), "questions": rows,
    }
    report = {
        "source_files": files, "total": len(rows), "mapping_counts": dict(Counter(row["method"] for row in mapping)),
        "normalization_counts": dict(Counter(row["kind"] for row in issues)),
        "old_question_count": len(old["questions"]),
        "old_ids_retained": len(used_ids & {row["id"] for row in old["questions"]}),
        "archive_old_ids": sorted(row["id"] for row in old["questions"] if row["id"] not in used_ids),
        "mapping": mapping, "normalizations": issues,
    }
    return bundle, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("literature", "words", "translations", "snapshot", "output", "report", "namespace"):
        parser.add_argument(f"--{name}", required=True)
    args = vars(parser.parse_args())
    output, report_path = Path(args.pop("output")), Path(args.pop("report"))
    bundle, report = prepare(**args)
    for target, data in ((output, bundle), (report_path, report)):
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("x", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
    print(json.dumps({key: value for key, value in report.items() if key not in ("mapping", "normalizations", "archive_old_ids")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
